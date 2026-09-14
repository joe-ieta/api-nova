'use strict';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const parser = require('api-nova-parser');
const base = '../src/modules/gateway-runtime/services/';
const { GatewayProxyEngineService } = require(base + 'gateway-proxy-engine.service.ts');
const { GatewayRequestCaptureService } = require(base + 'gateway-request-capture.service.ts');
const root = path.resolve(__dirname, '../../../tmp/gateway-header-boundary-tests');
const resolverResult = headers => ({ headers, credentialHeaderNames: Object.keys(headers),
  managedHeaderNames: ['authorization', 'x-private', 'x-other-candidate'] });
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function fixture(t, options = {}) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const previousAudit = process.env.API_NOVA_AUDIT_DIR;
  process.env.API_NOVA_AUDIT_DIR = directory;
  const f = { received: [], connectionCount: 0, pending: new Set(), resolveCalls: 0, outgoing: [] };
  t.after(async () => {
    await close(f.gateway); await close(f.upstream);
    await Promise.allSettled([...f.pending]); await parser.flushRuntimeAudit();
    if (previousAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR;
    else process.env.API_NOVA_AUDIT_DIR = previousAudit;
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  f.upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      f.received.push({ headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks), url: req.url });
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200; res.end(JSON.stringify({ bytes: Buffer.concat(chunks).length }));
    });
  });
  f.upstream.on('connection', () => { f.connectionCount++; });
  const upstreamPort = await listen(f.upstream);
  const resolver = { resolve: async (...args) => {
    f.resolveCalls++;
    return options.resolve ? options.resolve(...args) : resolverResult({ authorization: 'Bearer synthetic-upstream', 'x-private': 'synthetic-private' });
  } };
  f.service = new GatewayProxyEngineService(new GatewayRequestCaptureService(), resolver);
  // Observe the exact header map used by forward() before native HTTP canonicalizes it.
  const build = f.service.buildForwardHeaders.bind(f.service);
  f.service.buildForwardHeaders = (...args) => { const output = build(...args); f.outgoing.push({ ...output }); return output; };
  f.route = { runtimeAsset: { id: 'fixture-runtime' }, membership: { id: 'fixture-member' },
    sourceServiceAsset: { id: 'fixture-source' }, sourceServiceInstance: { id: 'fixture-instance' },
    endpointDefinition: { id: 'fixture-endpoint' },
    routeBinding: { upstreamMethod: 'POST', upstreamPath: '/echo', timeoutMs: 1000 },
    upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort, params: {}, policies: {} };
  f.upstreamHost = '127.0.0.1:' + upstreamPort;
  f.gateway = http.createServer((req, res) => {
    req.originalUrl = req.url; req.protocol = 'http';
    res.status = code => { res.statusCode = code; return res; };
    options.adapt?.(req);
    const pending = f.service.forward(f.route, req, res).catch(error => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      res.statusCode = error.getStatus?.() || 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: error.message }));
    }).finally(() => f.pending.delete(pending));
    f.pending.add(pending);
  });
  const gatewayPort = await listen(f.gateway);
  f.send = (headers = {}, body = Buffer.from('payload-with-binary-\u0000-tail')) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: gatewayPort, path: '/resource', method: 'POST',
      agent: false, headers: { 'content-type': 'application/octet-stream', 'content-length': body.length, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    request.setTimeout(4000, () => request.destroy(new Error('fixture timed out')));
    request.on('error', reject); request.end(body);
  });
  return f;
}
function assertAbsent(headers, names) {
  const keys = Object.keys(headers).map(key => key.toLowerCase());
  for (const name of names) assert.equal(keys.includes(name), false, name);
}

test('sending combines every case variant and array Connection nomination before trusted credential injection', async t => {
  const f = await fixture(t, { adapt(req) {
    req.headers.connection = ['X-Hop-A, authorization, X-PRIVATE', 'x-hop-a,,'];
    req.headers.Connection = [' X-Hop-B, COOKIE, trailer ', 'TRAILERS, x-api-key'];
    req.headers.cOnNeCtIoN = 'x-hop-c, X-Hop-B';
    Object.assign(req.headers, { 'X-Hop-A': 'consumer-hop-a', 'x-hop-b': 'consumer-hop-b', 'X-HOP-C': 'consumer-hop-c',
      Authorization: 'consumer-auth', Cookie: 'consumer-cookie', 'X-API-Key': 'consumer-key', 'X-Private': 'consumer-private',
      trailer: 'X-A', trailers: 'X-B', 'proxy-authorization': 'consumer-proxy', 'keep-alive': 'timeout=5' });
  } });
  const body = Buffer.from([0, 1, 2, 255, 65, 66, 67]);
  const response = await f.send({ 'x-business': 'preserved', accept: 'application/json' }, body);
  assert.equal(response.status, 200); assert.equal(f.received.length, 1);
  assertAbsent(f.outgoing[0], ['connection', 'x-hop-a', 'x-hop-b', 'x-hop-c', 'cookie', 'x-api-key', 'trailer', 'trailers', 'proxy-authorization', 'keep-alive']);
  assertAbsent(f.received[0].headers, ['x-hop-a', 'x-hop-b', 'x-hop-c', 'cookie', 'x-api-key', 'trailer', 'trailers', 'proxy-authorization', 'keep-alive']);
  assert.equal(f.received[0].headers.authorization, 'Bearer synthetic-upstream');
  assert.equal(f.received[0].headers['x-private'], 'synthetic-private');
  assert.equal(f.received[0].headers['x-business'], 'preserved'); assert.equal(f.received[0].headers.accept, 'application/json');
  assert.equal(JSON.stringify(f.outgoing).includes('consumer-'), false);
  assert.deepEqual(f.received[0].body, body); assert.equal(Number(f.received[0].headers['content-length']), body.length);
});

test('native repeated Connection fields nominate all names on the actual socket sending path', async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ Connection: ['x-one, x-two', 'X-THREE, x-one,'],
    'x-one': 'remove-one', 'x-two': 'remove-two', 'x-three': 'remove-three', 'x-business': 'keep' })).status, 200);
  assertAbsent(f.received[0].headers, ['x-one', 'x-two', 'x-three']);
  assert.equal(f.received[0].headers['x-business'], 'keep');
});

test('Connection-nominated XFF cannot reappear through proxy metadata regeneration', async t => {
  const f = await fixture(t, { adapt(req) {
    req.headers.Connection = [' X-Forwarded-For, X-Request-ID', 'x-forwarded-for'];
    req.headers['x-forwarded-for'] = ['198.51.100.41', '198.51.100.42'];
    req.headers['X-Forwarded-For'] = '198.51.100.99';
    req.headers['X-Request-ID'] = 'consumer-forged-id';
  } });
  const response = await f.send(); assert.equal(response.status, 200);
  assert.equal(f.received[0].headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(JSON.stringify(f.outgoing).includes('198.51.100.'), false);
  assert.notEqual(f.received[0].headers['x-request-id'], 'consumer-forged-id');
  assert.equal(f.received[0].headers['x-request-id'], response.headers['x-request-id']);
});

test('ordinary XFF keeps append compatibility while generated proxy fields have no case aliases', async t => {
  const f = await fixture(t, { adapt(req) {
    req.headers['x-forwarded-for'] = ['198.51.100.10', '198.51.100.11'];
    Object.assign(req.headers, { 'X-Forwarded-For': 'forged-case-alias', 'X-Forwarded-Host': 'forged-host',
      'X-Forwarded-Proto': 'forged-protocol', 'X-Request-ID': 'forged-request',
      forwarded: 'for=198.51.100.12;proto=https' });
  } });
  assert.equal((await f.send({ host: 'gateway.fixture', 'x-request-id': 'client-correlation-only' })).status, 200);
  const output = f.outgoing[0], received = f.received[0];
  assert.equal(output['x-forwarded-for'], '198.51.100.10,198.51.100.11, 127.0.0.1');
  assert.equal(received.headers['x-forwarded-for'], output['x-forwarded-for']);
  assert.equal(received.headers['x-forwarded-host'], 'gateway.fixture'); assert.equal(received.headers['x-forwarded-proto'], 'http');
  assert.equal(received.headers.host, f.upstreamHost);
  assert.equal(received.headers.forwarded, 'for=198.51.100.12;proto=https'); // Legacy compatibility, never a trusted identity claim.
  for (const name of ['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-request-id']) {
    assert.deepEqual(Object.keys(output).filter(key => key.toLowerCase() === name), [name]);
    assert.equal(received.rawHeaders.filter((_, index) => index % 2 === 0).filter(key => key.toLowerCase() === name).length, 1);
  }
  assert.equal(JSON.stringify(output).includes('forged-'), false);
  assert.notEqual(received.headers['x-request-id'], 'client-correlation-only');
});

test('None resolution removes all candidate credential names but preserves ordinary business headers', async t => {
  const f = await fixture(t, { resolve: async () => resolverResult({}) });
  assert.equal((await f.send({ Authorization: 'consumer-auth', 'X-Private': 'consumer-private',
    'X-Other-Candidate': 'consumer-other', 'X-API-Key': 'consumer-key', Cookie: 'consumer-cookie', 'x-business': 'keep' })).status, 200);
  assertAbsent(f.received[0].headers, ['authorization', 'x-private', 'x-other-candidate', 'x-api-key', 'cookie']);
  assert.equal(f.received[0].headers['x-business'], 'keep'); assert.equal(f.resolveCalls, 1);
});

test('resolver rejection occurs before any upstream socket connection or header/body send', async t => {
  const f = await fixture(t, { resolve: async () => { throw new Error('synthetic-secret-provider-path'); } });
  const response = await f.send({ authorization: 'consumer-secret' });
  assert.equal(response.status, 503); assert.equal(f.resolveCalls, 1);
  assert.equal(f.connectionCount, 0); assert.equal(f.received.length, 0); assert.equal(f.outgoing.length, 0);
  assert.equal(response.body.includes('synthetic-secret'), false); assert.equal(response.body.includes('consumer-secret'), false);
  assert.deepEqual(JSON.parse(response.body), { message: 'gateway_upstream_credential_unavailable' });
});
