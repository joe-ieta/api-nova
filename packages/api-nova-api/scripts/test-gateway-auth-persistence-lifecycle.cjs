'use strict';
// SEC-A1-02D: isolated disk persistence -> real candidate verification/activation ->
// fresh service/database instances -> real Gateway HTTP. No configured database is opened.
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { DataSource } = require('typeorm');
const express = require('express');
const { flushRuntimeAudit } = require('api-nova-parser');
const base = path.resolve(__dirname, '../dist/src');
function entity(name, exported) { return require(path.join(base, 'database/entities', name + '.entity.js'))[exported]; }
function service(module, name, exported) { return require(path.join(base, 'modules', module, 'services', name + '.service.js'))[exported]; }
const names = {
  runtime: ['runtime-asset', 'RuntimeAssetEntity'], membership: ['runtime-asset-endpoint-binding', 'RuntimeAssetEndpointBindingEntity'],
  binding: ['runtime-upstream-binding', 'RuntimeUpstreamBindingEntity'], candidate: ['runtime-upstream-binding-instance', 'RuntimeUpstreamBindingInstanceEntity'],
  source: ['source-service-asset', 'SourceServiceAssetEntity'], instance: ['source-service-instance', 'SourceServiceInstanceEntity'],
  endpoint: ['endpoint-definition', 'EndpointDefinitionEntity'], publication: ['endpoint-publish-binding', 'EndpointPublishBindingEntity'],
  route: ['gateway-route-binding', 'GatewayRouteBindingEntity'], snapshot: ['gateway-route-snapshot', 'GatewayRouteSnapshotEntity'],
  credential: ['gateway-consumer-credential', 'GatewayConsumerCredentialEntity'], sample: ['endpoint-test-sample', 'EndpointTestSampleEntity'],
  run: ['runtime-verification-run', 'RuntimeVerificationRunEntity'], result: ['runtime-verification-result', 'RuntimeVerificationResultEntity'],
};
const entities = Object.fromEntries(Object.entries(names).map(([key, args]) => [key, entity(...args)]));
const gateway = (name, exported) => service('gateway-runtime', name, exported);
const Policy = gateway('gateway-policy', 'GatewayPolicyService');
const Snapshot = gateway('gateway-route-snapshot', 'GatewayRouteSnapshotService');
const Security = gateway('gateway-security', 'GatewaySecurityService');
const Traffic = gateway('gateway-traffic-control', 'GatewayTrafficControlService');
const Cache = gateway('gateway-cache', 'GatewayCacheService');
const ProxyEngine = gateway('gateway-proxy-engine', 'GatewayProxyEngineService');
const Capture = gateway('gateway-request-capture', 'GatewayRequestCaptureService');
const Runtime = gateway('gateway-runtime', 'GatewayRuntimeService');
const Bindings = service('runtime-upstream-bindings', 'runtime-upstream-bindings', 'RuntimeUpstreamBindingsService');
const Invalidation = service('runtime-governance', 'runtime-governance-invalidation', 'RuntimeGovernanceInvalidationService');
const Verify = service('runtime-verification', 'runtime-verification', 'RuntimeVerificationService');
const Replay = service('runtime-verification', 'gateway-candidate-replay', 'GatewayCandidateReplayService');
const McpReplay = service('runtime-verification', 'mcp-candidate-replay', 'McpCandidateReplayService');
const Assertion = service('runtime-verification', 'runtime-response-assertion', 'RuntimeResponseAssertionService');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// Storage for operational metrics/logging is outside this auth acceptance; runtime audit remains real.
const telemetry = new Proxy({}, { get: () => async () => {} });
let db, directory, ingress, upstream, upstreamHits = 0;
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { if (!server) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function open(initialize) {
  db = await new DataSource({ type: 'sqljs', location: path.join(directory, 'fixture.sqlite'), autoSave: true,
    synchronize: initialize, entities: Object.values(entities) }).initialize();
  const repo = key => db.getRepository(entities[key]);
  const invalidation = new Invalidation(repo('runtime'), repo('membership'), repo('binding'), repo('candidate'));
  const bindings = new Bindings(repo('binding'), repo('candidate'), repo('instance'), db, telemetry, invalidation);
  const snapshot = new Snapshot(new Policy(), repo('route'), repo('snapshot'), repo('membership'), repo('publication'), repo('runtime'), repo('endpoint'), repo('source'), bindings);
  const runtime = new Runtime(snapshot, new Security(telemetry, repo('credential')), new Traffic(telemetry, telemetry),
    new Cache(), new ProxyEngine(new Capture()), telemetry, telemetry);
  const verification = new Verify(repo('runtime'), repo('membership'), repo('sample'), repo('run'), repo('result'), bindings,
    snapshot, new Replay(snapshot, runtime), new McpReplay(), new Assertion());
  return { repo, bindings, snapshot, runtime, verification };
}
async function serve(runtime) {
  const app = express();
  app.use((req, res) => runtime.forwardRequest(req.path, req, res).catch(error => {
    if (!res.headersSent) res.status(error.getStatus?.() || 500).json({ error: error.message });
  }));
  ingress = http.createServer(app);
  return listen(ingress);
}
async function main() {
  const scratch = path.resolve(__dirname, '../../../tmp');
  await fs.mkdir(scratch, { recursive: true });
  directory = await fs.mkdtemp(path.join(scratch, 'gateway-auth-loop-'));
  process.env.API_NOVA_AUDIT_DIR = path.join(directory, 'audit');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.API_NOVA_RUNTIME_ISSUER = 'https://fixture.invalid';
  process.env.API_NOVA_GATEWAY_RESOURCE = 'https://fixture.invalid/gateway';
  process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'api:invoke';
  delete process.env.API_NOVA_RUNTIME_JWKS_URI;
  process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture' }] });
  const unsigned = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' +
    Buffer.from(JSON.stringify({ iss: process.env.API_NOVA_RUNTIME_ISSUER, aud: process.env.API_NOVA_GATEWAY_RESOURCE,
      sub: 'fixture', scope: 'api:invoke', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const token = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url');
  const headers = { jwt: { authorization: `Bearer ${token}` }, api_key: { 'x-api-key': 'fixture.fixture-secret' }, anonymous: {} };
  upstream = http.createServer((_req, res) => { upstreamHits++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  await listen(upstream);
  let current = await open(true);
  await current.repo('source').save({ id: id(1), sourceKey: 'auth-loop' });
  await current.repo('instance').save({ id: id(2), sourceServiceAssetId: id(1), name: 'loopback', environment: 'test',
    scheme: 'http', host: '127.0.0.1', port: upstream.address().port, status: 'healthy' });
  await current.repo('runtime').save({ id: id(3), name: 'auth-loop', type: 'gateway_service', status: 'active', servicePrefix: 'fixture' });
  await current.repo('credential').save({ name: 'fixture', keyId: 'fixture', secretHash: createHash('sha256').update('fixture-secret').digest('hex'), runtimeAssetId: id(3) });
  const modes = ['jwt', 'api_key', 'anonymous'];
  for (const [index, mode] of modes.entries()) {
    const endpoint = id(10 + index), membership = id(20 + index);
    await current.repo('endpoint').save({ id: endpoint, sourceServiceAssetId: id(1), method: 'GET', path: '/' + mode });
    await current.repo('membership').save({ id: membership, runtimeAssetId: id(3), endpointDefinitionId: endpoint, status: 'active', enabled: true });
    await current.repo('publication').save({ endpointDefinitionId: endpoint, runtimeAssetEndpointBindingId: membership, publishStatus: 'active', publishedToHttp: true });
    await current.repo('route').save({ endpointDefinitionId: endpoint, runtimeAssetEndpointBindingId: membership,
      routePath: '/' + mode, upstreamPath: '/ping', routeMethod: 'GET', upstreamMethod: 'GET', routeVisibility: 'external',
      authPolicyRef: mode === 'api_key' ? 'api-key-default' : mode + '-default', status: 'active' });
    await current.bindings.upsert(membership, { sourceServiceAssetId: id(1), environment: 'test', selectionMode: 'fixed_primary',
      primaryInstanceId: id(2), status: 'active', candidates: [{ sourceServiceInstanceId: id(2) }] }, { actorId: 'fixture' });
    await current.repo('sample').save({ endpointDefinitionId: endpoint, testRunId: id(30 + index), fingerprint: mode,
      responseStatusCode: 200, tags: ['smoke'], capturedAt: new Date(), requestPayload: {}, responsePayload: { ok: true }, requestHeaders: headers[mode] });
  }
  // Reopen saved configurations before the production verification/activation path.
  await db.destroy(); current = await open(false);
  // DB timestamps have second precision; do not let the seed invalidation appear newer than the plan.
  await new Promise(resolve => setTimeout(resolve, 1050));
  const plan = await current.verification.planCandidate(id(3));
  assert.equal(plan.canExecute, true, JSON.stringify(plan.results));
  const executed = await current.verification.executeGatewayCandidate(id(3), plan.run.id);
  assert.equal(executed.run.status, 'passed', JSON.stringify(executed.results));
  assert.equal(await current.repo('snapshot').count(), 1);
  assert.equal((await current.repo('runtime').findOneByOrFail({ id: id(3) })).metadata.activeRevision, plan.run.candidateRevision);
  assert.equal(upstreamHits, 3, 'all three candidate modes must replay against real upstream');
  let checks = 0;
  for (const phase of ['activated', 'cold-restored']) {
    if (phase === 'cold-restored') {
      // Unpublished edits and a conflicting global default must not reinterpret the active snapshot.
      await current.repo('route').save((await current.repo('route').find()).map(route => ({ ...route, authPolicyRef: 'anonymous-default' })));
      process.env.API_NOVA_RUNTIME_AUTH_MODE = 'anonymous';
      await db.destroy(); current = await open(false);
      await current.snapshot.onModuleInit();
    }
    const url = await serve(current.runtime);
    for (const mode of modes) {
      assert.equal(current.snapshot.resolve(undefined, 'GET', '/fixture/' + mode).policies.auth.mode, mode);
      for (const [kind, requestHeaders] of [['missing', {}], ['wrong', { authorization: 'Bearer invalid', 'x-api-key': 'fixture.wrong' }], ['valid', headers[mode]]]) {
        const before = upstreamHits;
        const result = await fetch(url + '/fixture/' + mode, { headers: requestHeaders, signal: AbortSignal.timeout(5000) });
        const expected = mode === 'anonymous' || kind === 'valid' ? 200 : 401;
        assert.equal(result.status, expected, `${phase}/${mode}/${kind}: ${await result.text()}`);
        assert.equal(upstreamHits - before, expected === 200 ? 1 : 0, 'rejected request must not reach upstream');
        checks++;
      }
    }
    await close(ingress); ingress = null;
  }
  console.log(JSON.stringify({ marker: 'GATEWAY_AUTH_PERSISTENCE_LOOP_OK', modes: 3, realHttpChecks: checks,
    candidateReplays: 3, databaseReopens: 2, persistedSnapshots: 1, telemetryStorage: 'no-op', productionDeployment: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await close(ingress); await close(upstream); await flushRuntimeAudit();
  if (db?.isInitialized) await db.destroy();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
