'use strict';
process.env.DB_TYPE = 'sqlite';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '../tsconfig.json') });
// Exercise current sources without emitting build artifacts into another worker's output.
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  if (name === 'api-nova-parser') return path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
  return resolve.call(this, name, ...args);
};
const parser = require('api-nova-parser');
// Opt-in source verification until the main worker exports the shared adapter.
if (process.env.OBS_TP07_SOURCE_ADAPTER === '1') {
  Object.assign(parser, require('../../api-nova-parser/src/audit/runtime-http-agent'));
}
assert.equal(typeof parser.createRuntimeHttpAuditAgents, 'function', 'Parser public HTTP audit adapter export is required');
const { HttpService } = require('@nestjs/axios');
const { firstValueFrom } = require('rxjs');
const { AssetCatalogService } = require('../src/modules/asset-catalog/services/asset-catalog.service');
const { SourceServiceInstancesService } = require('../src/modules/source-service-instances/services/source-service-instances.service');
const { McpCandidateReplayService } = require('../src/modules/runtime-verification/services/mcp-candidate-replay.service');
const { endpointDependencyContext, observeEndpointDependency } = require('../src/modules/endpoint-testing/services/endpoint-dependency-audit');
let f;
beforeEach(async () => {
  f = { environment: { ...process.env }, requests: [], evidence: [] };
  f.root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-tp07-'));
  process.env.API_NOVA_AUDIT_DIR = f.root;
  delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
  const fixture = f;
  f.server = http.createServer((req, res) => {
    fixture.requests.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      if (req.url === '/slow') return;
      if (req.url === '/reset') return req.socket.destroy();
      if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url === '/error' ? 503 : req.url === '/fallback' && req.method === 'HEAD' ? 404 : 200;
      res.end(JSON.stringify({ ok: res.statusCode === 200, token: 'private-response-token' }));
    });
  });
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  f.url = 'http://127.0.0.1:' + f.server.address().port;
  f.instance = { id: 'instance-a', sourceServiceAssetId: 'source-a', enabled: true,
    scheme: 'http', host: '127.0.0.1', port: f.server.address().port, basePath: '', status: 'healthy' };
  f.endpoint = { id: 'endpoint-a', sourceServiceAssetId: 'source-a', path: '/ok', method: 'GET',
    metadata: { sourceType: 'manual' }, parameters: [] };
  f.catalog = Object.assign(Object.create(AssetCatalogService.prototype), {
    httpService: new HttpService(), endpointDefinitionRepository: { save: async x => x },
    getEndpointDefinitionDetail: async () => ({ endpoint: f.endpoint, sourceServiceAsset: { id: 'source-a' } }),
    sourceServiceInstancesService: {
      resolveForExecution: async () => f.instance, buildBaseUrl: () => f.url,
    },
    endpointTestingService: {
      recordSuccessfulRun: async x => f.evidence.push({ success: true, ...x }),
      recordFailedRun: async x => f.evidence.push({ success: false, ...x }),
    },
  });
  f.instances = Object.assign(Object.create(SourceServiceInstancesService.prototype), {
    httpService: new HttpService(), requireInstance: async () => f.instance,
    instanceRepository: { save: async x => x },
    governanceInvalidationService: { invalidateForSourceInstance: async () => undefined },
    recordMutationAudit: async () => undefined,
  });
});
afterEach(async () => {
  f.server.closeAllConnections();
  await new Promise(resolve => f.server.close(resolve));
  await parser.flushRuntimeAudit();
  process.env = f.environment;
  // The fixture is an exclusively owned temporary directory.
  assert.equal(path.dirname(f.root), os.tmpdir());
  assert.match(path.basename(f.root), /^nova-tp07-/);
  await fs.rm(f.root, { recursive: true, force: true });
});
async function rows() {
  await new Promise(resolve => setImmediate(resolve));
  await parser.flushRuntimeAudit();
  const files = (await fs.readdir(f.root)).filter(x => /^calls-v2-.*\.jsonl$/.test(x));
  const values = (await Promise.all(files.map(x => fs.readFile(path.join(f.root, x), 'utf8'))))
    .flatMap(x => x.trim().split('\n').filter(Boolean).map(JSON.parse));
  return values.filter(x => x.phase === 'finished');
}
function upstream(row, origin) {
  assert.equal(row.origin, origin);
  assert.equal(row.spanKind, 'upstream_api');
  assert.equal(row.parentInvocationId, undefined);
  assert.equal(row.rootInvocationId, row.invocationId);
  assert.equal(row.callerId, undefined);
}
test('endpoint test observes a real successful HTTP request and retains evidence', async () => {
  const result = await f.catalog.executeEndpointDefinitionTest('endpoint-a');
  assert.equal(result.test.passed, true);
  assert.equal(f.evidence.length, 1);
  const log = await rows();
  assert.equal(log.length, 1);
  upstream(log[0], 'test');
  assert.equal(log[0].endpointDefinitionId, 'endpoint-a');
  assert.equal(log[0].sourceServiceInstanceId, 'instance-a');
  assert.equal(log[0].sourceServiceAssetId, 'source-a');
  assert.equal(log[0].response.state, 'complete');
  assert.ok(log[0].response.totalBytes > 0);
  assert.ok(!JSON.stringify(log).includes('private-response-token'));
});
test('HTTP failure is still a business test failure with one upstream attempt', async () => {
  f.endpoint.path = '/error';
  assert.equal((await f.catalog.executeEndpointDefinitionTest('endpoint-a')).test.passed, false);
  assert.equal(f.evidence[0].success, false);
  const log = await rows();
  assert.equal(log.length, 1);
  assert.equal(log[0].statusCode, 503);
  assert.equal(log[0].outcome, 'error');
});
test('redirects retain each physical hop without adding a request', async () => {
  f.endpoint.path = '/redirect';
  assert.equal((await f.catalog.executeEndpointDefinitionTest('endpoint-a')).test.passed, true);
  const log = await rows();
  assert.equal(log.length, 2);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(log.map(x => x.redirectHopIndex).sort(), [0, 1]);
  assert.equal(new Set(log.map(x => x.upstreamOperationId)).size, 1);
  const first = log.find(x => x.redirectHopIndex === 0);
  const redirected = log.find(x => x.redirectHopIndex === 1);
  upstream(first, 'test');
  assert.equal(redirected.origin, 'test');
  assert.equal(redirected.spanKind, 'upstream_api');
  assert.equal(redirected.parentInvocationId, first.invocationId);
  assert.equal(redirected.rootInvocationId, first.invocationId);
  assert.equal(redirected.traceId, first.traceId);
});
test('endpoint HEAD failure falls back to GET in the same probe trace', async () => {
  f.endpoint.path = '/fallback';
  f.endpoint.metadata.probeUrl = f.url + '/fallback';
  assert.equal((await f.catalog.probeEndpointDefinition('endpoint-a')).probe.status, 'healthy');
  assert.deepEqual(f.requests.map(x => x.method), ['HEAD', 'GET']);
  const log = await rows();
  assert.equal(log.length, 2);
  log.forEach(x => upstream(x, 'probe'));
  assert.equal(new Set(log.map(x => x.traceId)).size, 1);
  assert.equal(new Set(log.map(x => x.upstreamOperationId)).size, 2);
});
test('source instance probe keeps its no-redirect behavior', async () => {
  f.instance.basePath = '/redirect';
  const result = await f.instances.probe('source-a', 'instance-a');
  assert.equal(result.probe.httpStatus, 302);
  assert.equal(f.requests.length, 1);
  const log = await rows();
  assert.equal(log.length, 1);
  upstream(log[0], 'probe');
  assert.equal(log[0].sourceServiceInstanceId, 'instance-a');
  assert.equal(log[0].endpointDefinitionId, undefined);
});
test('disabled instance produces no fictional request', async () => {
  f.instance.enabled = false;
  await assert.rejects(f.instances.probe('source-a', 'instance-a'), /disabled/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await rows(), []);
});
test('timeout is one observed timeout, with original business error handling', async () => {
  f.instance.basePath = '/slow';
  const result = await f.instances.probe('source-a', 'instance-a', { timeoutMs: 30 });
  assert.ok(result.probe.errorMessage.includes('timeout'));
  const log = await rows();
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, 'timeout');
  assert.equal(f.requests.length, 1);
});
test('connection reset retains failure without retrying the endpoint test', async () => {
  f.endpoint.path = '/reset';
  assert.equal((await f.catalog.executeEndpointDefinitionTest('endpoint-a')).test.passed, false);
  const log = await rows();
  assert.equal(log.length, 1);
  assert.equal(log[0].errorCategory, 'connection');
  assert.equal(f.requests.length, 1);
});
test('concurrent test and probe do not inherit an external caller or trace', async () => {
  await parser.withRuntimeCallContext({ transport: 'gateway', requestId: 'outside',
    identitySource: 'authenticated', callerId: 'outside-caller', origin: 'external',
    traceId: 'outside-trace', parentInvocationId: 'outside-parent' }, async () => {
    await Promise.all([f.catalog.executeEndpointDefinitionTest('endpoint-a'),
      f.instances.probe('source-a', 'instance-a')]);
    assert.equal(parser.getRuntimeCallContext().callerId, 'outside-caller');
  });
  const log = await rows();
  assert.equal(log.length, 2);
  assert.deepEqual(log.map(x => x.origin).sort(), ['probe', 'test']);
  assert.equal(new Set(log.map(x => x.traceId)).size, 2);
  log.forEach(x => { upstream(x, x.origin); assert.notEqual(x.traceId, 'outside-trace'); });
});
test('MCP candidate executes actual parser HTTP with internal origin and asset snapshots', async () => {
  const tool = parser.transformToMCPTools({ openapi: '3.0.3', info: { title: 'test', version: '1' },
    servers: [{ url: f.url }], paths: { '/ok': { get: {
      operationId: 'invoke', 'x-runtime-asset-id': 'runtime-a',
      'x-endpoint-definition-id': 'endpoint-a', 'x-source-service-instance-id': 'instance-a',
      'x-source-service-asset-id': 'source-a', responses: { '200': { description: 'OK' } },
    } } } }, { includeFieldAnnotations: false })[0];
  const result = await new McpCandidateReplayService().replay({ tool,
    sample: { endpointDefinitionId: 'endpoint-a', requestPayload: {} },
    runtimeAssetId: 'runtime-a', runtimeMembershipId: 'membership-a' });
  assert.equal(result.statusCode, 200);
  const log = await rows();
  assert.equal(log.length, 1);
  upstream(log[0], 'internal');
  assert.equal(log[0].runtimeAssetId, 'runtime-a');
  assert.equal(log[0].runtimeAssetEndpointBindingId, 'membership-a');
  assert.equal(log[0].sourceServiceInstanceId, 'instance-a');
});
test('unexecutable MCP candidate creates no upstream evidence', async () => {
  await assert.rejects(new McpCandidateReplayService().replay({
    tool: { name: 'missing' }, sample: {} }), /no executable handler/);
  assert.deepEqual(await rows(), []);
});
test('audit filesystem failure does not change the successful HTTP result', async () => {
  const blocked = path.join(f.root, 'not-a-directory');
  await fs.writeFile(blocked, 'fixture');
  process.env.API_NOVA_AUDIT_DIR = blocked;
  const failures = parser.getRuntimeAuditHealth().writeFailures;
  assert.equal((await f.catalog.executeEndpointDefinitionTest('endpoint-a')).test.passed, true);
  await parser.flushRuntimeAudit();
  assert.ok(parser.getRuntimeAuditHealth().writeFailures > failures);
  assert.equal(f.requests.length, 1);
});
test('dependency wrapper returns the exact rejection and invokes callback once', async () => {
  const original = new Error('original');
  let calls = 0;
  await assert.rejects(observeEndpointDependency(endpointDependencyContext('internal', { transport: 'gateway' }),
    async () => { calls++; throw original; }), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(await rows(), []);
});


const { GatewayCandidateReplayService } = require('../src/modules/runtime-verification/services/gateway-candidate-replay.service');
const { GatewayRuntimeService } = require('../src/modules/gateway-runtime/services/gateway-runtime.service');
const { GatewayProxyEngineService } = require('../src/modules/gateway-runtime/services/gateway-proxy-engine.service');
const { GatewayRequestCaptureService } = require('../src/modules/gateway-runtime/services/gateway-request-capture.service');
const { GatewaySecurityService } = require('../src/modules/gateway-runtime/services/gateway-security.service');
const { GatewayAccessLogService } = require('../src/modules/gateway-runtime/services/gateway-access-log.service');
const { GatewayRuntimeMetricsService } = require('../src/modules/gateway-runtime/services/gateway-runtime-metrics.service');
function gatewayFixture() {
  const route = {
    runtimeAsset: { id: 'runtime-a' }, membership: { id: 'membership-a' },
    endpointDefinition: { id: 'endpoint-a', path: '/ok' },
    sourceServiceAsset: { id: 'source-a' }, sourceServiceInstance: f.instance,
    routeBinding: { id: 'route-a', routePath: '/ok', routeMethod: 'GET',
      upstreamPath: '/ok', upstreamMethod: 'GET', routeVisibility: 'external' },
    upstreamBaseUrl: f.url, params: {}, policies: {
      auth: { mode: 'anonymous' },
      traffic: { timeoutMs: 80, retryPolicy: { attempts: 1, baseDelayMs: 0, allowNonIdempotent: false } },
      cache: { enabled: false },
    },
  };
  const snapshot = { resolve: () => route, resolveCandidate: () => route,
    getCandidateRoute: () => ({ normalizedRoutePath: '/ok', routeMethod: 'GET' }) };
  const legacy = [], controls = [], admissions = [];
  const metrics = new GatewayRuntimeMetricsService({
    recordGatewayRequestResult: async x => controls.push(x),
    recordGatewayCacheResult: async x => controls.push(x),
    recordRuntimeControlEvent: async x => controls.push(x),
  });
  const security = new GatewaySecurityService({ log: async () => undefined }, {
    findOne: async () => null,
  });
  const runtime = new GatewayRuntimeService(snapshot, security, {
    admit: async () => { admissions.push('admit'); return { release() { admissions.push('release'); } }; },
    beforeAttempt: async () => undefined,
    recordAttemptSuccess: async () => undefined,
    recordAttemptFailure: async () => undefined,
    recordRetryAttempt: async () => undefined,
  }, { resolve: () => null, store() {} },
  new GatewayProxyEngineService(new GatewayRequestCaptureService()),
  new GatewayAccessLogService({ create: x => x, save: async x => legacy.push(x) }), metrics);
  const replay = new GatewayCandidateReplayService(snapshot, runtime);
  return { route, runtime, replay, metrics, legacy, controls, admissions,
    execute: () => replay.replay({ candidateRevision: 'candidate-a', runtimeMembershipId: 'membership-a',
      verificationRunId: 'verification-a', sample: {
        endpointDefinitionId: 'endpoint-a', requestPayload: {},
        requestHeaders: { 'x-api-nova-origin': 'external' },
      } }),
    async external() {
      const server = http.createServer((req, res) => {
        req.originalUrl = req.url;
        res.status = value => { res.statusCode = value; return res; };
        runtime.forwardRequest('/ok', req, res).catch(error => {
          res.statusCode = error.getStatus?.() || 500; res.end();
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const result = await fetch('http://127.0.0.1:' + server.address().port + '/ok', {
          headers: { 'x-api-nova-origin': 'internal', 'x-api-nova-verification-run-id': 'forged',
            'x-origin': 'probe', 'x-request-id': 'forged-request' },
        });
        await result.text();
        return result.status;
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
}
test('Gateway candidate keeps real upstream root, no synthetic ingress, caller or legacy counters', async () => {
  const gateway = gatewayFixture();
  const response = await parser.withRuntimeCallContext({ transport: 'gateway', requestId: 'outside',
    identitySource: 'authenticated', callerId: 'administrator', origin: 'external',
    traceId: 'outside-trace', parentInvocationId: 'outside-parent' }, () => gateway.execute());
  assert.equal(response.statusCode, 200);
  const log = await rows();
  assert.equal(log.length, 1);
  upstream(log[0], 'internal');
  assert.equal(log[0].runtimeAssetId, 'runtime-a');
  assert.equal(log[0].sourceServiceInstanceId, 'instance-a');
  assert.equal(log[0].clientIp, undefined);
  assert.equal(log[0].peerIp, undefined);
  assert.equal(log[0].runtimeAssetEndpointBindingId, 'membership-a');
  assert.deepEqual(gateway.admissions, ['admit', 'release']);
  assert.deepEqual(gateway.legacy, []);
  assert.deepEqual(gateway.controls, []);
  assert.equal(gateway.metrics.getRuntimeAssetMetrics('runtime-a').requestCount, 0);
});
test('external HTTP cannot forge internal origin through replay or origin headers', async () => {
  const gateway = gatewayFixture();
  assert.equal(await gateway.external(), 200);
  const log = await rows();
  assert.equal(log.length, 2);
  assert.ok(log.every(x => x.origin === 'external'));
  const ingress = log.find(x => x.spanKind === 'gateway_request');
  const dependency = log.find(x => x.spanKind === 'upstream_api');
  assert.ok(ingress);
  assert.equal(dependency.parentInvocationId, ingress.invocationId);
  assert.equal(gateway.legacy.length, 1);
  assert.equal(gateway.metrics.getRuntimeAssetMetrics('runtime-a').requestCount, 1);
});
test('Gateway replay preserves authentication denial and sends no upstream request', async () => {
  const gateway = gatewayFixture();
  gateway.route.policies.auth = { mode: 'api-key' };
  await assert.rejects(gateway.execute());
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await rows(), []);
  assert.deepEqual(gateway.legacy, []);
  assert.equal(gateway.metrics.getRuntimeAssetMetrics('runtime-a').requestCount, 0);
});
test('Gateway replay upstream failure and retry retain internal origin on each real attempt', async () => {
  const gateway = gatewayFixture();
  gateway.route.routeBinding.upstreamPath = '/reset';
  gateway.route.policies.traffic.retryPolicy.attempts = 2;
  await assert.rejects(gateway.execute());
  const log = await rows();
  assert.equal(log.length, 2);
  assert.equal(f.requests.length, 2);
  log.forEach(x => { upstream(x, 'internal'); assert.equal(x.outcome, 'error'); });
  assert.deepEqual(log.map(x => x.attemptIndex).sort(), [1, 2]);
  assert.equal(new Set(log.map(x => x.upstreamOperationId)).size, 1);
  assert.equal(new Set(log.map(x => x.traceId)).size, 1);
  assert.deepEqual(gateway.legacy, []);
});
test('real JSONL collection into SQLite isolates default queries/statistics and respects asset scope', async () => {
  const { DataSource } = require('typeorm');
  const { ConfigService } = require('@nestjs/config');
  const { CALL_OBSERVABILITY_ENTITIES } = require('../src/database/entities/runtime-call-observability.entity');
  const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity');
  const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store');
  const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store');
  const { CallObservabilityCollector } = require('../src/modules/call-observability/call-observability.collector');
  const { ObservabilityCursorService } = require('../src/modules/call-observability/call-observability-cursor.service');
  const { CallObservabilityInvocationsService } = require('../src/modules/call-observability/call-observability-invocations.service');
  const { CallObservabilityStatisticsService } = require('../src/modules/call-observability/call-observability-statistics.service');
  const database = new DataSource({ type: 'sqljs', synchronize: true, logging: false,
    entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] });
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(f.root, 'objects');
  const payloads = new CallObservabilityPayloadStore();
  await database.initialize();
  const store = new CallObservabilityStore(database, payloads);
  const collector = new CallObservabilityCollector(store);
  try {
    const gateway = gatewayFixture();
    await gateway.execute();
    await f.catalog.executeEndpointDefinitionTest('endpoint-a');
    await f.instances.probe('source-a', 'instance-a');
    assert.equal(await gateway.external(), 200);
    const captured = await rows();
    assert.equal(captured.length, 5);
    const files = (await fs.readdir(f.root)).filter(x => /^calls-v2-.*\.jsonl$/.test(x));
    for (const file of files) {
      const report = await collector.collectFile(file);
      assert.equal(report.quarantinedRecords, 0);
      assert.equal(report.hasMore, false);
      assert.ok(report.processedRecords >= 10);
    }
    const config = new ConfigService({ API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'fixture-'.repeat(10) });
    const invocations = new CallObservabilityInvocationsService(store, new ObservabilityCursorService(config));
    const statistics = new CallObservabilityStatisticsService(store);
    const authorization = { principalId: 'fixture', runtimeAssetIds: null,
      requiredPermissions: ['monitoring:read'], fingerprint: 'fixture' };
    const range = { from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 60000).toISOString() };
    const defaults = await invocations.list(range, authorization);
    assert.equal(defaults.data.items.length, 2);
    assert.ok(defaults.data.items.every(x => x.origin === 'external'));
    for (const origin of ['internal', 'test', 'probe']) {
      const selected = await invocations.list({ ...range, origin, sourceServiceInstanceId: 'instance-a' }, authorization);
      assert.equal(selected.data.items.length, 1, origin);
      assert.equal(selected.data.items[0].origin, origin);
      const metrics = await statistics.summary({ ...range, origin, scope: 'upstream' }, authorization);
      assert.equal(metrics.data.metrics.selectedInvocations, 1, origin);
    }
    const business = await statistics.summary({ ...range, scope: 'business' }, authorization);
    assert.equal(business.data.metrics.selectedInvocations, 1);
    const externalUpstream = await statistics.summary({ ...range, scope: 'upstream' }, authorization);
    assert.equal(externalUpstream.data.metrics.selectedInvocations, 1);
    const internalBusiness = await statistics.summary({ ...range, scope: 'business', origin: 'internal' }, authorization);
    assert.equal(internalBusiness.data.metrics.selectedInvocations, 0);
    const assetQuery = { ...range, origin: 'internal', runtimeAssetId: 'runtime-a',
      endpointDefinitionId: 'endpoint-a', sourceServiceInstanceId: 'instance-a' };
    assert.equal((await invocations.list(assetQuery, authorization)).data.items.length, 1);
    const denied = { ...authorization, runtimeAssetIds: ['other-asset'], fingerprint: 'denied' };
    assert.equal((await invocations.list(assetQuery, denied)).data.items.length, 0);
    assert.equal((await statistics.summary({ ...assetQuery, scope: 'upstream' }, denied)).data.metrics.selectedInvocations, 0);
    for (const file of files) {
      assert.equal((await collector.collectFile(file)).processedRecords, 0);
    }
    assert.equal((await statistics.summary({ ...range, scope: 'upstream', origin: 'internal' },
      authorization)).data.metrics.selectedInvocations, 1);
  } finally {
    await collector.onModuleDestroy();
    await payloads.onModuleDestroy();
    await database.destroy();
  }
});


const { ProcessHealthService } = require('../src/modules/servers/services/process-health.service');
const { ServerLifecycleService } = require('../src/modules/servers/services/server-lifecycle.service');
for (const serviceName of ['process-health', 'server-lifecycle']) {
  for (const status of [200, 503]) {
    test(serviceName + ' health HTTP ' + status + ' stays outside business audit in an external context', async () => {
      f.server.removeAllListeners('request');
      f.server.on('request', (req, res) => {
        f.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
        req.resume();
        req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"healthy":true}'); });
      });
      const service = Object.assign(Object.create(
        serviceName === 'process-health' ? ProcessHealthService.prototype : ServerLifecycleService.prototype), {
        httpService: new HttpService(), config: { healthCheckTimeout: 1000 },
      });
      const external = { transport: 'gateway', requestId: 'external-request',
        traceId: 'external-trace', parentInvocationId: 'external-parent',
        identitySource: 'authenticated', callerId: 'external-caller', origin: 'external' };
      await parser.flushRuntimeAudit();
      const before = parser.getRuntimeAuditHealth();
      const beforeAttempts = parser.getRuntimeUpstreamAuditHealth().attemptsStarted;
      const result = await parser.withRuntimeCallContext(external, async () => {
        const result = await service.httpHealthCheck(serviceName === 'process-health' ? f.url + '/health' : f.url);
        // Exclusion must not corrupt the surrounding business request's context.
        assert.equal(parser.getRuntimeCallContext(), external);
        return result;
      });
      assert.equal(serviceName === 'process-health' ? result.healthy : result, status === 200);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].method, 'GET');
      assert.equal(f.requests[0].url, '/health');
      assert.equal(f.requests[0].headers['x-request-id'], undefined);
      assert.equal(f.requests[0].headers['x-correlation-id'], undefined);
      assert.deepEqual(await rows(), []);
      assert.equal(parser.getRuntimeAuditHealth().writtenRecords, before.writtenRecords);
      assert.equal(parser.getRuntimeAuditHealth().activeCalls, before.activeCalls);
      assert.equal(parser.getRuntimeUpstreamAuditHealth().attemptsStarted, beforeAttempts);
    });
  }
}

