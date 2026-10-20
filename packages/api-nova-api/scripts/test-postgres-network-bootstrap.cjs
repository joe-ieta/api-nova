'use strict';
// Called only after the parent fixture has verified ownership of its disposable PG cluster.
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { Controller, Get } = require('@nestjs/common');
const { DataSource } = require('typeorm');
const request = require('supertest');
const { createNetworkPolicyCompiler } = require('api-nova-parser');
const base = '../dist/src/modules/gateway-runtime/';
const service = name => require(base + 'services/' + name);
const { GatewayNetworkBootstrap, gatewayNetworkBootstrapProvider, gatewayBootstrapNetworkProvider, GATEWAY_HOST_CANDIDATE_ATTESTATION } = service('gateway-network-bootstrap');
const { attestGatewayHostNetworkPlan, GATEWAY_HOST_NETWORK_PLAN } = service('gateway-host-network-plan');
const { GatewayNetworkInstallationService } = service('gateway-network-installation.service');
const { GatewayRouteSnapshotService } = service('gateway-route-snapshot.service');
const { GatewayPolicyService } = service('gateway-policy.service');
const { GatewayProxyEngineService } = service('gateway-proxy-engine.service');
const { GatewayRuntimeService } = service('gateway-runtime.service');
const { GatewayRequestCaptureService } = service('gateway-request-capture.service');
const { GatewayRuntimeMetricsService } = service('gateway-runtime-metrics.service');
const { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } = service('gateway-upstream-credential-resolver');
const { GATEWAY_TRUSTED_NETWORK_PROVIDER } = service('gateway-trusted-network.provider');
const { gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider, GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY } = service('gateway-upstream-credential.providers');
const { GatewayRuntimeController } = require(base + 'gateway-runtime.controller');
const { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } = require('../dist/src/database/entities/runtime-asset.entity');
const { GatewayRouteSnapshotEntity } = require('../dist/src/database/entities/gateway-route-snapshot.entity');
const { GatewayRoutePathMatchMode } = require('../dist/src/database/entities/gateway-route-binding.entity');

module.exports = async function postRouteBootstrapChecks(pg, fixture, candidate, source, endpoint) {
  let hits = 0, dnsQueries = 0, seenAuth, app, routeService, count = 0;
  const upstream = http.createServer((req, res) => { hits++; seenAuth = req.headers.authorization; res.end('np11-ok'); });
  const dns = dgram.createSocket('udp4');
  dns.on('message', (query, peer) => {
    dnsQueries++; let at = 12; while (query[at]) at += query[at] + 1; at++;
    const type = query.readUInt16BE(at), end = at + 4, header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(type === 1 ? 1 : 0, 6);
    const answer = Buffer.alloc(16); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(1, 2); answer.writeUInt16BE(1, 4); answer.writeUInt16BE(4, 10); Buffer.from([127, 0, 0, 1]).copy(answer, 12);
    dns.send(Buffer.concat([header, query.subarray(12, end), ...(type === 1 ? [answer] : [])]), peer.port, peer.address);
  });
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => dns.bind(0, '127.0.0.1', resolve));
    const origin = `http://a.example:${upstream.address().port}`;
    const document = candidate();
    document.sites.forEach(site => { site.headerPolicy = { version: 1 }; });
    document.sites[0].match = { scheme: 'http', host: 'a.example', port: upstream.address().port, basePath: '/' };
    const material = fixture(document), compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const policy = compiler.compile({ version: 1, id: 'np11', revision: '1', sourceServiceAssetId: source, siteId: 'site0', origin, mode: 'private-exception', connection: 'direct',
      privateException: { id: 'test-only', revision: '1', sourceServiceAssetId: source, siteId: 'site0', origin, addresses: ['127.0.0.1'], purpose: 'isolated fixture', owner: 'test', approvalRef: 'test',
        issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } });
    const networkPlan = attestGatewayHostNetworkPlan({ compiler, servers: [`127.0.0.1:${dns.address().port}`],
      policies: [{ routeBindingId: 'np11-route', siteId: 'site0', policy }], proofTtlMs: 60000 });
    const metrics = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, async () => {}]));
    const traffic = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, async () => {}]));
    traffic.admit = async () => ({ release() {} });
    const noCache = () => { throw new Error('network mode must not consult cache'); };
    class Health { health() { return { ok: true }; } }
    Controller('np11-health')(Health); Get()(Health.prototype, 'health', Object.getOwnPropertyDescriptor(Health.prototype, 'health'));
    const module = await Test.createTestingModule({ controllers: [Health, GatewayRuntimeController], providers: [
      { provide: ConfigService, useValue: new ConfigService() }, { provide: DataSource, useValue: pg },
      { provide: GATEWAY_HOST_CANDIDATE_ATTESTATION, useValue: material.token() }, { provide: GATEWAY_HOST_NETWORK_PLAN, useValue: networkPlan },
      gatewayNetworkBootstrapProvider, gatewayBootstrapNetworkProvider, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider,
      GatewayPolicyService, GatewayNetworkInstallationService, GatewayRequestCaptureService, GatewayProxyEngineService,
      { provide: GatewayRuntimeMetricsService, useValue: metrics },
      { provide: GatewayRouteSnapshotService, inject: [GatewayPolicyService], useFactory: policies =>
        new GatewayRouteSnapshotService(policies, {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {}) },
      { provide: GatewayRuntimeService, inject: [GatewayRouteSnapshotService, GatewayProxyEngineService, GatewayNetworkBootstrap], useFactory: (routes, proxy, bootstrap) =>
        new GatewayRuntimeService(routes, { authorize: async () => ({ mode: 'anonymous' }) }, traffic, { resolve: noCache, store: noCache }, proxy, { recordRequest: async () => {} }, metrics, undefined, bootstrap) },
    ] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const state = module.get(GatewayNetworkBootstrap);
    routeService = module.get(GatewayRouteSnapshotService);
    assert.equal(module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY), null);
    assert.equal(module.get(GATEWAY_TRUSTED_NETWORK_PROVIDER), state.networkProvider);
    assert.equal(module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER), state.credentialResolver);
    assert.throws(() => state.assertTrafficAllowed()); count++;
    // Only the two explicitly owned assets from the preceding fixture are stopped.
    for (const id of ['00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000100']) {
      await pg.getRepository(RuntimeAssetEntity).update(id, { status: RuntimeAssetStatus.OFFLINE, metadata: {} });
    }
    const runtimeId = '00000000-0000-0000-0000-000000000101';
    const runtimeAsset = await pg.getRepository(RuntimeAssetEntity).save({ id: runtimeId, name: 'np11', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    const binding = { id: 'np11-route', endpointDefinitionId: endpoint, authPolicyRef: 'anonymous', routeVisibility: 'external',
      pathMatchMode: GatewayRoutePathMatchMode.EXACT, routePath: '/np11', routeMethod: 'GET', upstreamMethod: 'GET', upstreamPath: '/items', retryPolicy: { attempts: 3 },
      createdAt: new Date(), updatedAt: new Date(), upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } };
    const entries = [{ runtimeAsset, routeBinding: binding, membership: { id: 'np11-member', publicationRevision: 1 }, publishBinding: { id: 'np11-pub' },
      sourceServiceAsset: { id: source }, endpointDefinition: { id: endpoint }, sourceServiceInstance: { id: 'instance' },
      normalizedRoutePath: '/np11', routeMethod: 'GET', upstreamBaseUrl: origin, priorityScore: 1, policies: module.get(GatewayPolicyService).compileForRoute(binding) }];
    const fingerprint = routeService.fingerprintEntries(entries);
    routeService.candidateSnapshots.set('np11-v1', { runtimeAssetId: runtimeId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
    await pg.transaction(async manager => {
      await routeService.activateCandidate('np11-v1', manager);
      await manager.update(RuntimeAssetEntity, runtimeId, { metadata: { activeRevision: 'np11-v1', activeGatewaySnapshotFingerprint: fingerprint } });
    });
    assert.throws(() => state.assertTrafficAllowed()); count++;
    // Real onModuleInit loads persisted routes before the real onApplicationBootstrap hook.
    await app.init();
    assert.doesNotThrow(() => state.assertTrafficAllowed());
    await request(app.getHttpServer()).get('/np11-health').expect(200, { ok: true });
    await request(app.getHttpServer()).get('/v1/gateway/np11').expect(200, 'np11-ok');
    assert.equal(hits, 1); assert.ok(dnsQueries > 0);
    assert.equal(seenAuth, 'Basic ' + Buffer.from('user-old:pass-old').toString('base64')); count++;
    const active = routeService.resolve('localhost', 'GET', '/np11');
    assert.throws(() => state.assertTrafficAllowed({ ...active, runtimeAsset: { id: 'unregistered' }, membership: { id: 'new' }, routeBinding: { ...active.routeBinding, id: 'new' } })); count++;
    // Catalog change closes the bundle synchronously; no implicit proof renewal.
    await routeService.reload();
    const dnsBefore = dnsQueries;
    await request(app.getHttpServer()).get('/v1/gateway/np11').expect(503);
    state.installCommittedRoutes(routeService);
    assert.throws(() => state.assertTrafficAllowed());
    assert.equal(hits, 1); assert.equal(dnsQueries, dnsBefore); count++;
    material.store.revoke(material.generation);
    await request(app.getHttpServer()).get('/np11-health').expect(200, { ok: true });
    await request(app.getHttpServer()).get('/v1/gateway/np11').expect(503);
    assert.equal(hits, 1); count++;
    await app.close(); app = undefined;
    assert.throws(() => state.captureSnapshot());
    assert.throws(() => state.assertTrafficAllowed()); count++;
    console.log(JSON.stringify({ marker: 'NP11_POST_ROUTE_BOOTSTRAP_OK', checks: count }));
    return count;
  } finally {
    if (app) { app.getHttpServer().closeAllConnections?.(); await app.close(); }
    routeService?.onModuleDestroy();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => dns.close(resolve));
  }
};
