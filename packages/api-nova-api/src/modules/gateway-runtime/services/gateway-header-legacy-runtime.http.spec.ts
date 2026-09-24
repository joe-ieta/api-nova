import * as http from 'node:http';
import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayHeaderLegacyExceptionService } from './gateway-header-legacy-exception.service';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayCacheService } from './gateway-cache.service';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

// Real RuntimeService production guard call with isolated database and loopback servers.
describe('Legacy guard production Runtime call before real HTTP cache/resolver', () => {
  let db: DataSource, now: number, sourceEnabled: boolean | undefined, route: any, grantId: string;
  let upstream: http.Server, gateway: http.Server, port: number, outbound: number, resolver: jest.Mock, cache: GatewayCacheService, runtime: GatewayRuntimeService, buildRuntime: () => GatewayRuntimeService;
  const exception = () => new GatewayHeaderLegacyExceptionService(db, () => now);
  const grant = () => ({ version: 1, mode: 'legacy', routeId: route.routeBinding.id, owner: 'operator', reason: 'isolated fixture', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z', rollbackEvidence: 'fixture:123' });
  beforeEach(async () => {
    now = Date.parse('2026-09-24T00:00:00Z'); sourceEnabled = false; outbound = 0;
    db = await new DataSource({ type: 'sqljs', entities: [GatewayRouteBindingEntity], synchronize: true }).initialize();
    const repo = db.getRepository(GatewayRouteBindingEntity);
    const binding = await repo.save(repo.create({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/old', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET', routeVisibility: 'external', authPolicyRef: 'anonymous', status: GatewayRouteBindingStatus.ACTIVE }));
    upstream = http.createServer((_req, res) => { outbound++; res.setHeader('content-type', 'text/plain'); res.end('real-upstream'); });
    const upstreamPort = await listen(upstream);
    route = { routeBinding: JSON.parse(JSON.stringify(binding)), runtimeAsset: { id: 'runtime' }, membership: { id: 'membership' }, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'source' }, sourceServiceInstance: { id: 'instance' }, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } }, cache: { enabled: true, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 4096 }, upstream: {} } };
    grantId = await exception().register(binding.id, grant(), { actorId: 'admin', source: { source: 'inline' }, registryConfigured: false });
    resolver = jest.fn().mockResolvedValue({ headers: {}, credentialHeaderNames: [], managedHeaderNames: [] });
    cache = new GatewayCacheService();
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    traffic.admit = jest.fn().mockResolvedValue({ release: jest.fn() });
    buildRuntime = () => new GatewayRuntimeService({ resolve: () => route } as any, { authorize: jest.fn().mockResolvedValue({ mode: 'anonymous' }) } as any, traffic, cache,
      new GatewayProxyEngineService(new GatewayRequestCaptureService(), { resolve: resolver }, metrics), { recordRequest: jest.fn().mockResolvedValue(undefined) } as any, metrics, new GatewayHeaderLegacyRuntimeGuard(db, () => sourceEnabled, () => now));
    runtime = buildRuntime();
    gateway = http.createServer((req, res) => {
      (req as any).originalUrl = req.url; (res as any).status = (status: number) => { res.statusCode = status; return res; };
      void (async () => {
        await runtime.forwardResolvedRoute(route, req as any, res as any);
      })().catch(error => { if (!res.headersSent) { res.statusCode = error.getStatus?.() ?? 500; res.end(error.message); } else res.destroy(); });
    });
    port = await listen(gateway);
  });
  afterEach(async () => { await Promise.all([gateway, upstream].filter(Boolean).map(close)); if (db?.isInitialized) await db.destroy(); });
  async function reopen() { const database = (db.driver as any).export(); await db.destroy(); db = await new DataSource({ type: 'sqljs', database, entities: [GatewayRouteBindingEntity], synchronize: false }).initialize(); runtime = buildRuntime(); }
  const get = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/old' }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body })); }).on('error', reject);
  });
  it('valid inline grant after DB reopen reaches the actual upstream and subsequently caches', async () => {
    await reopen(); expect(await get()).toEqual({ status: 200, body: 'real-upstream' });
    expect((await get()).status).toBe(200); expect(outbound).toBe(1); expect(resolver).toHaveBeenCalledTimes(1);
  });
  it.each(['expired', 'revoked', 'deleted', 'unknown', 'provider-unknown', 'registry'])('rejects %s with 503 and zero Resolver/upstream operations after reopen', async failure => {
    if (failure === 'expired') now = Date.parse('2026-10-24T00:00:00Z');
    if (failure === 'revoked') await exception().revoke(route.routeBinding.id, grantId, 'admin');
    if (failure === 'provider-unknown') sourceEnabled = undefined;
    const repo = db.getRepository(GatewayRouteBindingEntity), row = await repo.findOneByOrFail({ id: route.routeBinding.id });
    if (failure === 'deleted') { row.upstreamConfig = {}; await repo.save(row); }
    if (failure === 'unknown') { (row.upstreamConfig!.headerPolicyLegacyException as any).unknown = true; await repo.save(row); }
    if (failure === 'registry') {
      row.upstreamConfig = {}; await repo.save(row); sourceEnabled = true;
      grantId = await exception().register(row.id, grant(), { actorId: 'admin', registryConfigured: true, source: { source: 'registry', providerId: 'provider', siteId: 'site', providerFingerprint: 'a'.repeat(64) } });
    }
    await reopen(); expect(await get()).toEqual({ status: 503, body: 'gateway_header_legacy_exception_unavailable' });
    expect(resolver).not.toHaveBeenCalled(); expect(outbound).toBe(0);
  });
  it('revocation blocks a populated cache hit before Resolver and upstream work', async () => {
    expect((await get()).status).toBe(200); expect(outbound).toBe(1);
    resolver.mockClear(); outbound = 0;
    await exception().revoke(route.routeBinding.id, grantId, 'admin'); await reopen();
    expect((await get()).status).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(outbound).toBe(0);
  });
});
