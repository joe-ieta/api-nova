'use strict';
process.env.DB_TYPE = 'sqlite';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { HttpException } = require('@nestjs/common');
const parser = require('api-nova-parser');
const services = '../dist/src/modules/gateway-runtime/services/';
const { GatewayRuntimeService } = require(services + 'gateway-runtime.service.js');
const { GatewayProxyEngineService } = require(services + 'gateway-proxy-engine.service.js');
const { GatewayRequestCaptureService } = require(services + 'gateway-request-capture.service.js');
const { GatewaySecurityService } = require(services + 'gateway-security.service.js');
const { GatewayAccessLogService } = require(services + 'gateway-access-log.service.js');
const { GatewayCacheService } = require(services + 'gateway-cache.service.js');
const { getGatewayRequestAuditHealth } = require(services + 'gateway-request-audit.js');

let fixture;
let savedEnvironment;
function makeRoute(port) {
  return {
    runtimeAsset: { id: 'gateway-test' }, membership: { id: 'membership-test' },
    publishBinding: { id: 'publish-test' },
    endpointDefinition: { id: 'endpoint-test', path: '/echo' },
    sourceServiceAsset: { id: 'source-test' },
    sourceServiceInstance: { id: 'instance-test' },
    routeBinding: { id: 'route-test', routePath: '/resource', routeMethod: 'POST',
      upstreamPath: '/echo', upstreamMethod: 'POST', routeVisibility: 'external' },
    upstreamBaseUrl: 'http://127.0.0.1:' + port, params: {},
    policies: {
      auth: { mode: 'anonymous', apiKeyQueryParamName: 'access_code' },
      traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1, baseDelayMs: 0, allowNonIdempotent: false } },
      cache: { enabled: false, methods: ['GET'], maxBodyBytes: 65536, ttlMs: 30000,
        varyQueryKeys: [], varyHeaderKeys: [] },
    },
  };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  if (!server) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
beforeEach(async () => {
  savedEnvironment = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-gateway-observability-'));
  process.env.API_NOVA_AUDIT_DIR = root;
  delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
  delete process.env.API_NOVA_AUDIT_MAX_BODY_BYTES;
  delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
  fixture = { root, pending: new Set(), upstreamRequests: [], attempts: [], legacy: [], credentials: new Map() };
  const f = fixture;
  f.onUpstream = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith('/binary')) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(body);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, bytes: body.length, token: 'upstream-secret' }));
      }
    });
  };
  f.upstream = http.createServer((req, res) => {
    f.upstreamRequests.push({ url: req.url, headers: { ...req.headers } });
    f.onUpstream(req, res);
  });
  f.route = makeRoute(await listen(f.upstream));
  const proxy = new GatewayProxyEngineService(new GatewayRequestCaptureService());
  const recordingProxy = {
    forward(target, req, res, options) {
      f.attempts.push({ ...options });
      return proxy.forward(target, req, res, options);
    },
  };
  f.security = new GatewaySecurityService({ log: async () => undefined }, {
    findOne: async ({ where }) => f.credentials.get(where.keyId) || null,
    save: async value => value,
  });
  const metrics = new Proxy({}, { get: () => async () => undefined });
  const traffic = {
    admit: async () => {
      if (f.trafficError) throw f.trafficError;
      return { release() {} };
    },
    beforeAttempt: async () => undefined, recordAttemptSuccess: async () => undefined,
    recordAttemptFailure: async () => undefined, recordRetryAttempt: async () => undefined,
  };
  const access = new GatewayAccessLogService({
    create: value => value, save: async value => { f.legacy.push(value); return value; },
  });
  f.runtime = new GatewayRuntimeService(
    { resolve: (_host, _method, routePath) => routePath.startsWith('/missing') ? undefined : f.route },
    f.security, traffic, new GatewayCacheService(), recordingProxy, access, metrics,
  );
  f.gateway = http.createServer((req, res) => {
    req.originalUrl = req.url;
    req.protocol = 'http';
    req.query = Object.fromEntries(new URL(req.url, 'http://fixture').searchParams);
    req.ip = '203.0.113.254'; // Not accepted as provenance by the new observer.
    res.status = code => { res.statusCode = code; return res; };
    let operation;
    operation = f.runtime.forwardRequest(new URL(req.url, 'http://fixture').pathname, req, res)
      .catch(error => {
        if (res.headersSent) { if (!res.writableFinished) res.destroy(); return; }
        if (res.destroyed) return;
        res.statusCode = typeof error.getStatus === 'function' ? error.getStatus() : 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'fixture-response', statusCode: res.statusCode }));
      }).finally(() => f.pending.delete(operation));
    f.pending.add(operation);
  });
  f.port = await listen(f.gateway);
});
afterEach(async () => {
  const f = fixture;
  await close(f?.gateway);
  await close(f?.upstream);
  if (f) await Promise.allSettled([...f.pending]);
  await parser.flushRuntimeAudit();
  process.env = savedEnvironment;
  if (f) {
    const resolved = path.resolve(f.root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('api-nova-gateway-observability-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

function send(options = {}) {
  const f = fixture;
  return new Promise((resolve, reject) => {
    let responseSeen = false;
    const req = http.request({
      host: '127.0.0.1', port: f.port, path: options.path || '/resource', method: options.method || 'POST',
      headers: options.headers || {}, agent: false,
    }, res => {
      responseSeen = true;
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      const done = interrupted => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks), interrupted });
      res.on('end', () => done(false));
      res.on('aborted', () => done(true));
      res.on('error', () => done(true));
    });
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP timeout')));
    req.on('error', error => { if (!responseSeen) reject(error); });
    if (options.chunks) { for (const chunk of options.chunks) req.write(chunk); req.end(); }
    else req.end(options.body);
  });
}
async function records() {
  await Promise.allSettled([...fixture.pending]);
  await parser.flushRuntimeAudit();
  const names = (await fs.readdir(fixture.root)).filter(name => name.startsWith('calls-v2-'));
  const all = (await Promise.all(names.map(name => fs.readFile(path.join(fixture.root, name), 'utf8'))))
    .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  for (const record of all) parser.normalizeRuntimeAuditRecord(record);
  return all;
}
function finished(all, kind) { return all.filter(row => row.phase === 'finished' && (!kind || row.spanKind === kind)); }
function only(all, kind) {
  const rows = finished(all, kind);
  assert.equal(rows.length, 1, 'one terminal ' + kind);
  return rows[0];
}
function assertLinked(parent, child) {
  assert.equal(child.parentInvocationId, parent.invocationId);
  assert.equal(child.rootInvocationId, parent.invocationId);
  assert.equal(child.traceId, parent.traceId);
  assert.equal(child.requestId, parent.requestId);
  assert.notEqual(child.invocationId, parent.invocationId);
}
function asGet() { fixture.route.routeBinding.upstreamMethod = 'GET'; fixture.route.routeBinding.routeMethod = 'GET'; }
function credential(overrides = {}) {
  const value = { id: 'consumer-test', keyId: 'known', secretHash: createHash('sha256').update('consumer-secret').digest('hex'), ...overrides };
  fixture.credentials.set(value.keyId, value);
  fixture.route.policies.auth.mode = 'api_key';
  return value;
}

test('real Gateway records one ingress and one linked physical upstream with separate byte stages', { timeout: 7000 }, async () => {
  const body = Buffer.from(JSON.stringify({ greeting: 'hello', token: 'client-secret' }));
  const response = await send({ body, headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-request-id': 'untrusted-client-id' } });
  assert.equal(response.status, 200);
  const all = await records();
  const entrance = only(all, 'gateway_request'), upstream = only(all, 'upstream_api');
  assertLinked(entrance, upstream);
  assert.equal(entrance.clientRequestId, 'untrusted-client-id');
  assert.notEqual(entrance.requestId, 'untrusted-client-id');
  assert.equal(response.headers['x-request-id'], entrance.requestId);
  assert.equal(fixture.upstreamRequests[0].headers['x-request-id'], entrance.requestId);
  assert.equal(entrance.request.totalBytes, body.length);
  assert.equal(upstream.request.totalBytes, body.length);
  assert.equal(entrance.response.totalBytes, response.body.length);
  assert.equal(upstream.response.totalBytes, response.body.length);
  assert.equal(entrance.measurementStage, 'gateway_http');
  assert.equal(upstream.measurementStage, 'upstream_http');
  assert.equal(entrance.runtimeAssetEndpointBindingId, 'membership-test');
  assert.equal(upstream.sourceServiceAssetId, 'source-test');
  assert.equal(upstream.attemptIndex, 1);
  assert.equal(upstream.redirectHopIndex, 0);
  assert.ok(upstream.upstreamOperationId);
  assert.equal(entrance.outcome, 'success');
  assert.equal(upstream.outcome, 'success');
  assert.equal(entrance.request.state, 'complete');
  assert.equal(entrance.response.state, 'complete');
  assert.equal(fixture.legacy.length, 1);
  assert.ok(all.some(row => row.phase === 'started' && row.invocationId === entrance.invocationId));
  assert.ok(!JSON.stringify(all).includes('client-secret'));
  assert.ok(!JSON.stringify(all).includes('upstream-secret'));
});

test('verified API key identity is recorded without persisting or forwarding its secret', async () => {
  credential();
  const response = await send({ headers: { 'x-api-key': 'known.consumer-secret' } });
  assert.equal(response.status, 200);
  const all = await records(), entrance = only(all, 'gateway_request');
  assert.equal(entrance.authState, 'authenticated');
  assert.equal(entrance.callerSubject, 'consumer-test');
  assert.equal(entrance.credentialId, 'known');
  assert.equal(fixture.upstreamRequests[0].headers['x-api-key'], undefined);
  assert.ok(!JSON.stringify(all).includes('consumer-secret'));
});

test('query API keys are redacted at ingress and removed before the upstream request', async () => {
  credential();
  const response = await send({ path: '/resource?access_code=known.consumer-secret&safe=yes' });
  assert.equal(response.status, 200);
  const all = await records();
  assert.ok(!JSON.stringify(all).includes('consumer-secret'));
  assert.ok(!fixture.upstreamRequests[0].url.includes('access_code'));
  assert.ok(fixture.upstreamRequests[0].url.includes('safe=yes'));
});

test('invalid API key records an authentication failure without a fabricated caller', async () => {
  credential();
  const response = await send({ headers: { 'x-api-key': 'fake.guessed-secret', 'x-forwarded-for': '198.51.100.13' } });
  assert.equal(response.status, 401);
  const all = await records(), entrance = only(all, 'gateway_request');
  assert.equal(entrance.authState, 'authentication_failed');
  assert.equal(entrance.callerId, undefined);
  assert.equal(entrance.identitySource, 'anonymous');
  assert.equal(entrance.peerIp, '127.0.0.1');
  assert.equal(entrance.clientIp, '127.0.0.1');
  assert.equal(entrance.ipSource, 'peer');
  assert.equal(entrance.proxyTrusted, false);
  assert.equal(entrance.request, undefined);
  assert.equal(finished(all, 'upstream_api').length, 0);
  assert.ok(!JSON.stringify(all).includes('guessed-secret'));
});

test('verified but forbidden credentials keep the trusted caller and never reach upstream', async () => {
  credential({ runtimeAssetId: 'another-gateway' });
  const response = await send({ headers: { 'x-api-key': 'known.consumer-secret' } });
  assert.equal(response.status, 403);
  const all = await records(), entrance = only(all, 'gateway_request');
  assert.equal(entrance.authState, 'authenticated');
  assert.equal(entrance.callerSubject, 'consumer-test');
  assert.equal(entrance.errorCategory, 'authorization');
  assert.equal(finished(all, 'upstream_api').length, 0);
});

test('route misses retain ingress and sent error content without attributing an unknown asset', async () => {
  const response = await send({ method: 'GET', path: '/missing' });
  assert.equal(response.status, 404);
  const all = await records(), entrance = only(all, 'gateway_request');
  assert.equal(entrance.runtimeAssetId, undefined);
  assert.equal(entrance.statusCode, 404);
  assert.equal(entrance.response.totalBytes, response.body.length);
  assert.equal(entrance.errorCategory, 'routing');
  assert.equal(finished(all, 'upstream_api').length, 0);
});

test('rate-limit rejection has a single ingress terminal and no upstream invocation', async () => {
  fixture.trafficError = new HttpException('test rate limit', 429);
  const response = await send();
  assert.equal(response.status, 429);
  const all = await records(), entrance = only(all, 'gateway_request');
  assert.equal(entrance.errorCategory, 'rate_limit');
  assert.equal(entrance.failureStage, 'admission');
  assert.equal(finished(all, 'upstream_api').length, 0);
});

test('cache hit observes its own client send and does not manufacture an upstream invocation', async () => {
  asGet(); fixture.route.policies.cache.enabled = true;
  const first = await send({ method: 'GET' }), second = await send({ method: 'GET' });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(second.headers['x-apinova-cache'], 'HIT');
  assert.deepEqual(first.body, second.body);
  const all = await records(), entries = finished(all, 'gateway_request');
  assert.equal(entries.length, 2);
  const cached = entries.find(row => row.cacheHit);
  assert.ok(cached);
  assert.equal(cached.outcome, 'cache_hit');
  assert.equal(cached.response.totalBytes, second.body.length);
  assert.equal(cached.response.state, 'complete');
  assert.equal(finished(all, 'upstream_api').length, 1);
  assert.equal(fixture.upstreamRequests.length, 1);
});

test('upstream HTTP failure is not inferred as success from a completed response stream', async () => {
  fixture.onUpstream = (req, res) => { req.resume(); res.statusCode = 503; res.end('unavailable'); };
  const response = await send();
  assert.equal(response.status, 503);
  const all = await records();
  assert.equal(only(all, 'gateway_request').outcome, 'error');
  assert.equal(only(all, 'upstream_api').outcome, 'error');
  assert.equal(only(all, 'upstream_api').errorCategory, 'http_status');
});

test('204 responses are observed empty rather than unavailable', async () => {
  fixture.onUpstream = (req, res) => { req.resume(); res.statusCode = 204; res.end(); };
  const response = await send();
  assert.equal(response.status, 204);
  const all = await records();
  for (const row of finished(all)) {
    assert.equal(row.response.state, 'empty');
    assert.equal(row.response.totalBytes, 0);
    assert.equal(row.outcome, 'success');
  }
});

test('chunked UTF-8 bodies count bytes rather than characters without duplicate consumption', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from([0xe4, 0xbd, 0xa0]), Buffer.from('xyz')];
  const response = await send({ chunks, headers: { 'content-type': 'text/plain' } });
  assert.equal(response.status, 200);
  const all = await records();
  assert.equal(only(all, 'gateway_request').request.totalBytes, 9);
  assert.equal(only(all, 'upstream_api').request.totalBytes, 9);
  assert.equal(JSON.parse(response.body).bytes, 9);
});

test('binary request and response captures preserve bytes using Base64', async () => {
  fixture.route.routeBinding.upstreamPath = '/binary';
  const body = Buffer.from([0, 255, 1, 128, 2, 129]);
  const response = await send({ body, headers: { 'content-type': 'application/octet-stream', 'content-length': body.length } });
  assert.deepEqual(response.body, body);
  for (const row of finished(await records())) {
    assert.equal(row.request.encoding, 'base64');
    assert.equal(row.response.encoding, 'base64');
    assert.equal(row.request.data, body.toString('base64'));
    assert.equal(row.response.data, body.toString('base64'));
  }
});

test('oversized captures omit fragments but retain actual byte measurements on both sides', async () => {
  process.env.API_NOVA_AUDIT_MAX_BODY_BYTES = '32';
  const body = Buffer.from(JSON.stringify({ token: 'never-retain-secret', padding: 'x'.repeat(100) }));
  const response = await send({ body, headers: { 'content-type': 'application/json', 'content-length': body.length } });
  assert.equal(response.status, 200);
  const all = await records();
  for (const row of finished(all)) {
    assert.equal(row.request.state, 'omitted');
    assert.equal(row.request.reason, 'size_limit');
    assert.equal(row.request.totalBytes, body.length);
    assert.equal(row.request.data, undefined);
  }
  assert.ok(!JSON.stringify(all).includes('never-retain-secret'));
});

test('a physical retry has a distinct child, shared operation id and increasing attempt index', async () => {
  asGet(); fixture.route.policies.traffic.retryPolicy.attempts = 2;
  fixture.onUpstream = (req, res) => {
    req.resume();
    if (fixture.upstreamRequests.length === 1) req.socket.destroy();
    else res.end('retried');
  };
  const response = await send({ method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'retried');
  const all = await records(), entrance = only(all, 'gateway_request'), children = finished(all, 'upstream_api').sort((a, b) => a.attemptIndex - b.attemptIndex);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(row => row.attemptIndex), [1, 2]);
  assert.equal(children[0].upstreamOperationId, children[1].upstreamOperationId);
  assert.notEqual(children[0].invocationId, children[1].invocationId);
  for (const child of children) assertLinked(entrance, child);
  assert.equal(children[0].outcome, 'error');
  assert.equal(children[0].errorCategory, 'connection');
  assert.equal(children[1].outcome, 'success');
  assert.equal(entrance.outcome, 'success');
});

test('body-bearing requests are not silently retried with an already consumed empty stream', async () => {
  fixture.route.policies.traffic.retryPolicy = { attempts: 2, allowNonIdempotent: true };
  fixture.onUpstream = (req, _res) => { req.resume(); req.on('end', () => req.socket.destroy()); };
  const response = await send({ body: 'once-only', headers: { 'content-length': 9 } });
  assert.equal(response.status, 502);
  const all = await records();
  assert.equal(finished(all, 'upstream_api').length, 1);
  assert.equal(fixture.upstreamRequests.length, 1);
});

test('upstream timeout records timeout on the child and an actually sent 504 on ingress', async () => {
  fixture.route.policies.traffic.timeoutMs = 30;
  fixture.onUpstream = req => req.resume();
  const response = await send();
  assert.equal(response.status, 504);
  const all = await records(), entrance = only(all, 'gateway_request'), child = only(all, 'upstream_api');
  assert.equal(child.outcome, 'timeout');
  assert.equal(child.errorCode, 'UPSTREAM_TIMEOUT');
  assert.equal(child.response, undefined);
  assert.equal(entrance.statusCode, 504);
  assert.equal(entrance.outcome, 'timeout');
  assert.equal(entrance.response.totalBytes, response.body.length);
});

test('interrupted upstream response is incomplete and cannot produce a success terminal', async () => {
  fixture.onUpstream = (req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    res.write('{"token":"partial-secret');
    setTimeout(() => res.destroy(), 15);
  };
  const response = await send();
  assert.equal(response.interrupted, true);
  const all = await records(), child = only(all, 'upstream_api'), entrance = only(all, 'gateway_request');
  assert.notEqual(child.outcome, 'success');
  assert.equal(child.response.state, 'incomplete');
  assert.equal(child.response.data, undefined);
  assert.notEqual(entrance.outcome, 'success');
  assert.equal(entrance.response.state, 'incomplete');
  assert.ok(!JSON.stringify(all).includes('partial-secret'));
});

test('client disconnect during a stream terminates both spans once and releases capture memory', async () => {
  asGet();
  fixture.onUpstream = (req, res) => {
    req.resume(); res.setHeader('content-type', 'text/event-stream');
    res.write('data: first\n\n');
    const timer = setInterval(() => res.write('data: next\n\n'), 10);
    res.once('close', () => clearInterval(timer));
  };
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: fixture.port, path: '/resource', agent: false }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
      res.on('error', () => undefined);
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await sleep(30);
  const all = await records();
  assert.equal(only(all, 'gateway_request').outcome, 'cancelled');
  assert.equal(only(all, 'upstream_api').outcome, 'cancelled');
  assert.equal(parser.getRuntimeAuditHealth().activeCalls, 0);
  assert.equal(parser.getRuntimeAuditHealth().captureMemoryBytes, 0);
});

test('client disconnect before upstream headers is captured and does not cause a retry', async () => {
  asGet(); fixture.route.policies.traffic.retryPolicy.attempts = 3;
  let received;
  const upstreamReceived = new Promise(resolve => { received = resolve; });
  fixture.onUpstream = req => { req.resume(); received(); };
  const req = http.get({ host: '127.0.0.1', port: fixture.port, path: '/resource', agent: false });
  req.on('error', () => undefined);
  await upstreamReceived;
  req.destroy();
  await sleep(30);
  const all = await records();
  assert.equal(only(all, 'gateway_request').outcome, 'cancelled');
  assert.equal(only(all, 'upstream_api').outcome, 'cancelled');
  assert.equal(fixture.attempts.length, 1);
});

test('concurrent requests with the same client id retain independent traces and parent links', async () => {
  asGet();
  await Promise.all(Array.from({ length: 8 }, (_, index) => send({ method: 'GET',
    path: '/resource?index=' + index, headers: { 'x-request-id': 'same-client-id' } })));
  const all = await records(), parents = finished(all, 'gateway_request'), children = finished(all, 'upstream_api');
  assert.equal(parents.length, 8); assert.equal(children.length, 8);
  assert.equal(new Set(parents.map(row => row.requestId)).size, 8);
  assert.equal(new Set(parents.map(row => row.traceId)).size, 8);
  for (const child of children) {
    const parent = parents.find(row => row.invocationId === child.parentInvocationId);
    assert.ok(parent);
    assertLinked(parent, child);
  }
});

test('filesystem audit failure does not replace the Gateway business response or repeat upstream work', async () => {
  const blocker = path.join(fixture.root, 'not-a-directory');
  await fs.writeFile(blocker, 'fixture');
  process.env.API_NOVA_AUDIT_DIR = blocker;
  const before = parser.getRuntimeAuditHealth().writeFailures;
  const response = await send();
  await Promise.allSettled([...fixture.pending]);
  await parser.flushRuntimeAudit();
  assert.equal(response.status, 200);
  assert.equal(fixture.upstreamRequests.length, 1);
  assert.ok(parser.getRuntimeAuditHealth().writeFailures > before);
  assert.equal(parser.getRuntimeAuditHealth().activeCalls, 0);
  assert.equal(parser.getRuntimeAuditHealth().captureMemoryBytes, 0);
  assert.equal(getGatewayRequestAuditHealth().instrumentationFailures, 0);
});
