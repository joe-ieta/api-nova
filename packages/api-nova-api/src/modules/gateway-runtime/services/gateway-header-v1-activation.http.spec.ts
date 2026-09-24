import { INestApplication } from '@nestjs/common';
import { GatewayRuntimeController } from '../gateway-runtime.controller';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { GatewayRouteBindingEntity as Route } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayRouteSnapshotEntity as Snapshot } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity as Member } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointPublishBindingEntity as Binding } from '../../../database/entities/endpoint-publish-binding.entity';
import { PublicationProfileEntity as Profile } from '../../../database/entities/publication-profile.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity as Source } from '../../../database/entities/source-service-asset.entity';
import { GatewayHeaderHistoryLedgerEntity as Ledger } from '../../../database/entities/gateway-header-history-ledger.entity';
import { PublicationService } from '../../publication/services/publication.service';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayUpstreamSecurityRuntimeGuard } from './gateway-upstream-security-runtime.guard';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';
import { gatewayHeaderLegacyRuntimeGuardProvider } from './gateway-header-legacy-runtime.providers';
import { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } from './gateway-upstream-credential-resolver';
import { GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider } from './gateway-upstream-credential.providers';
const listen = (s: http.Server) => new Promise<number>(resolve => s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port)));
const close = (s: http.Server) => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); });
const entities = [Route, Snapshot, Runtime, Member, Binding, Profile, Endpoint, Source, Ledger];
describe('H11A explicit Registry v1 membership transaction and Nest runtime', () => {
  let app: INestApplication, db: DataSource, module: TestingModule, registry: UpstreamCredentialRegistry, policy: GatewayPolicyService;
  let upstream: http.Server, gateway: http.Server, directory: string, port: number, upstreamPort: number, seen: any[], candidate: any;
  let publication: any, snapshots: GatewayRouteSnapshotService, runtime: GatewayRuntimeService, resolverSpy: jest.SpyInstance, route: any;
  const business = () => Promise.all([Route, Runtime, Member, Binding, Profile].map(entity => db.getRepository(entity as any).find()));
  beforeEach(async () => {
    seen = [];
    upstream = http.createServer((req, res) => { seen.push(req.headers); res.setHeader('x-safe-result', 'yes'); res.setHeader('x-drop-result', 'no'); res.end('ok'); });
    upstreamPort = await listen(upstream);
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    await db.getRepository(Source).save({ id: 'source', sourceKey: 'fixture' });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'source', path: '/items', method: 'GET', status: 'verified' as any, publishEnabled: true, rawOperation: {}, metadata: { testStatus: 'passed', lastProbeStatus: 'healthy' } });
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Member).save({ id: 'member', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    await db.getRepository(Profile).save({ id: 'profile', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member', status: 'reviewed' as any, intentName: 'read', descriptionForLlm: 'Read items' });
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: {}, credentials: {}, sites: [{ id: 'site', sourceServiceAssetId: 'source', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none', headerPolicy: { version: 1, requestHeaders: ['x-safe'], responseHeaders: ['x-safe-result'] }, endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    directory = await fs.mkdtemp(join(tmpdir(), 'apinova-h11a-'));
    const file = join(directory, 'registry.json'); await fs.writeFile(file, JSON.stringify(candidate));
    module = await Test.createTestingModule({ providers: [{ provide: DataSource, useValue: db }, { provide: ConfigService, useValue: new ConfigService({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: file, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'test' }) }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider, gatewayHeaderLegacyRuntimeGuardProvider, GatewayPolicyService] }).compile();
    registry = module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY); policy = module.get(GatewayPolicyService);
    const context = async () => ({ membership: await db.getRepository(Member).findOneByOrFail({ id: 'member' }), runtimeAsset: await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' }), endpointDefinition: await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }), sourceServiceAsset: await db.getRepository(Source).findOneByOrFail({ id: 'source' }) });
    publication = Object.create(PublicationService.prototype);
    Object.assign(publication, { gatewayPolicyService: policy, routeBindingRepository: db.getRepository(Route), profileRepository: db.getRepository(Profile),
      resolveMembershipPublicationContext: context, ensureRouteConflictFree: jest.fn(), writeHistory: jest.fn(), recordAuditEvent: jest.fn(),
      emitGatewaySnapshotRefresh: jest.fn(() => { expect(db.createQueryRunner().isTransactionActive).toBe(false); }),
      buildMembershipPublicationState: context, buildPostPublishDeploymentState: async () => ({ attempted: false }) });
    await publication.configureRuntimeMembershipGatewayRoute('member', { routePath: '/items', routeMethod: 'GET', upstreamPath: '/items', upstreamMethod: 'GET', routeVisibility: 'external', authPolicyRef: 'anonymous', cachePolicyRef: 'enabled', upstreamConfig: { cache: { ttlMs: 30000, maxBodyBytes: 4096 }, headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } });
    snapshots = new GatewayRouteSnapshotService(policy, db.getRepository(Route), db.getRepository(Snapshot), db.getRepository(Member), db.getRepository(Binding), db.getRepository(Runtime), db.getRepository(Endpoint), db.getRepository(Source), { resolve: async () => ({ resolved: true, instance: { id: 'instance', scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' } }) } as any);
    const actualResolver = module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER);
    const wrapper = { headerPolicyEnabled: true, resolve: (...args: any[]) => actualResolver.resolve(...args) }; resolverSpy = jest.spyOn(wrapper, 'resolve');
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)])); traffic.admit = async () => ({ release() {} });
    runtime = new GatewayRuntimeService(snapshots, { authorize: async () => ({ mode: 'anonymous' }) } as any, traffic, new GatewayCacheService(), new GatewayProxyEngineService(new GatewayRequestCaptureService(), wrapper, metrics, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint))), { recordRequest: async () => undefined } as any, metrics, module.get(GatewayHeaderLegacyRuntimeGuard));
    const httpModule = await Test.createTestingModule({ controllers: [GatewayRuntimeController], providers: [{ provide: GatewayRuntimeService, useValue: runtime }] }).compile();
    app = httpModule.createNestApplication(); await app.listen(0, '127.0.0.1');
    gateway = app.getHttpServer(); port = (gateway.address() as any).port;
  });
  afterEach(async () => { if (gateway) gateway.closeAllConnections(); await app?.close(); if (upstream) await close(upstream); await module?.close(); if (db?.isInitialized) await db.destroy(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
  async function publish() {
    await publication.publishRuntimeMembership('member', { autoStart: false });
    const prepared = await snapshots.prepareCandidate('runtime', 'v1');
    await snapshots.activateCandidate('v1');
    await db.getRepository(Runtime).update('runtime', { metadata: { activeRevision: 'v1', activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint } });
    await snapshots.reload(); route = snapshots.resolve(undefined, 'GET', '/items');
    expect(route).toBeTruthy();
  }
  const get = () => new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => { http.get({ hostname: '127.0.0.1', port, path: '/v1/gateway/items', headers: { 'x-safe': 'allowed', 'x-drop': 'blocked', 'x-header-policy': 'legacy' } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => setImmediate(() => resolve({ status: res.statusCode!, headers: res.headers, body }))); }).on('error', reject); });
  it('atomically publishes an explicit membership, persists/reloads snapshot, and enforces Registry policy before cache', async () => {
    await publish(); expect((await db.getRepository(Member).findOneByOrFail({ id: 'member' })).publicationRevision).toBe(1);
    expect((await db.getRepository(Route).findOneByOrFail({ id: route.routeBinding.id })).status).toBe('active');
    expect(await db.getRepository(Snapshot).count()).toBe(1); expect(await db.getRepository(Ledger).count()).toBe(1);
    const first = await get(); expect(first).toMatchObject({ status: 200, body: 'ok' }); expect(first.headers['x-safe-result']).toBe('yes'); expect(first.headers['x-drop-result']).toBeUndefined();
    expect(seen[0]['x-safe']).toBe('allowed'); expect(seen[0]['x-drop']).toBeUndefined(); expect(seen[0]['x-header-policy']).toBeUndefined();
    expect((await get()).status).toBe(200); expect(seen).toHaveLength(1); expect(resolverSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it.each(['marker', 'revision', 'binding-offline', 'cache-policy', 'protected'])('rejects %s changes before cache, resolver, and upstream', async change => {
    await publish(); expect((await get()).status).toBe(200); resolverSpy.mockClear(); seen = [];
    if (change === 'marker') await db.getRepository(Route).update(route.routeBinding.id, { upstreamConfig: {} });
    if (change === 'cache-policy') await db.getRepository(Route).update(route.routeBinding.id, { cachePolicyRef: 'changed' });
    if (change === 'binding-offline') await db.getRepository(Binding).update(route.routeBinding.publishBindingId, { publishedToHttp: false });
    if (change === 'revision') await db.getRepository(Member).update('member', { publicationRevision: 2 });
    if (change === 'protected') await db.getRepository(Endpoint).update('endpoint', { rawOperation: { security: [{ Missing: [] }] } });
    expect((await get()).status).toBe(503); expect(resolverSpy).not.toHaveBeenCalled(); expect(seen).toHaveLength(0);
  });
  it('reopens SQL.js and the durable Registry before restoring the verified v1 snapshot', async () => {
    await publish(); gateway.closeAllConnections(); await app.close(); app = undefined as any; gateway = undefined as any; await module.close();
    const database = (db.driver as any).export(); await db.destroy();
    db = await new DataSource({ type: 'sqljs', entities, database, synchronize: false }).initialize();
    module = await Test.createTestingModule({ providers: [{ provide: DataSource, useValue: db }, { provide: ConfigService, useValue: new ConfigService({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: join(directory, 'registry.json'), API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'test' }) }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider, gatewayHeaderLegacyRuntimeGuardProvider, GatewayPolicyService] }).compile();
    const cold = new GatewayRouteSnapshotService(module.get(GatewayPolicyService), db.getRepository(Route), db.getRepository(Snapshot), db.getRepository(Member), db.getRepository(Binding), db.getRepository(Runtime), db.getRepository(Endpoint), db.getRepository(Source), {} as any);
    await cold.reload(); const restored = cold.resolve(undefined, 'GET', '/items'); expect(restored).toBeTruthy();
    await expect(module.get(GatewayHeaderLegacyRuntimeGuard).assertAllowed(restored!)).resolves.toBeUndefined();
    expect((await module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER).resolve(restored, 'http://127.0.0.1:' + upstreamPort + '/items')).compiledHeaderPolicy).toBeDefined();
    expect(await db.getRepository(Snapshot).count()).toBe(1);
  });
  it('database failure rolls back every ACTIVE write and emits no publication refresh', async () => {
    const before = await business(); publication.emitGatewaySnapshotRefresh.mockClear();
    await db.query("CREATE TRIGGER reject_publish BEFORE INSERT ON endpoint_publish_bindings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await expect(publication.publishRuntimeMembership('member', { autoStart: false })).rejects.toThrow('fixture failure');
    expect(await business()).toEqual(before); expect(publication.emitGatewaySnapshotRefresh).not.toHaveBeenCalled(); expect(await db.getRepository(Snapshot).count()).toBe(0);
  });
  it('failed Registry compilation retains last good snapshot and wire policy', async () => {
    await publish(); const generation = registry.captureSnapshot().generation;
    candidate.sites[0].headerPolicy.requestHeaders = ['connection'];
    await expect(registry.reload(candidate)).rejects.toThrow(); expect(registry.captureSnapshot().generation).toBe(generation);
    expect((await get()).status).toBe(200); expect(seen[0]['x-safe']).toBe('allowed'); expect(await db.getRepository(Snapshot).count()).toBe(1);
  });
  it('failed snapshot compilation preserves the old published snapshot without activating the candidate', async () => {
    await publish(); const old = snapshots.resolve(undefined, 'GET', '/items');
    const binding = await db.getRepository(Route).findOneByOrFail({ id: route.routeBinding.id });
    (binding.upstreamConfig!.headerPolicyMigration as any).unknown = true; await db.getRepository(Route).save(binding);
    await expect(snapshots.prepareCandidate('runtime', 'bad')).rejects.toThrow('NOT_READY');
    expect(snapshots.resolve(undefined, 'GET', '/items')).toEqual(old);
    expect(await db.getRepository(Snapshot).count()).toBe(1); expect((await get()).status).toBe(503);
  });
  it.each(['inline-conflict', 'no-policy', 'missing-marker', 'legacy-unmarked', 'unknown', 'protected'])('blocks %s publication with zero ACTIVE writes', async change => {
    const binding = await db.getRepository(Route).findOneByOrFail({ runtimeAssetEndpointBindingId: 'member' });
    if (change === 'inline-conflict') binding.upstreamConfig!.headerPolicy = { version: 1 };
    if (change === 'legacy-unmarked') binding.upstreamConfig = {};
    if (change === 'missing-marker') binding.upstreamConfig = { headerPolicy: { version: 1 } };
    if (change === 'unknown') (binding.upstreamConfig!.headerPolicyMigration as any).extra = true;
    if (change === 'protected') await db.getRepository(Endpoint).update('endpoint', { rawOperation: { security: [{ Missing: [] }] } });
    if (change === 'no-policy') { delete candidate.sites[0].headerPolicy; candidate.metadata.revision = 'no-policy'; await registry.reload(candidate); }
    await db.getRepository(Route).save(binding); const before = await business();
    await expect(publication.publishRuntimeMembership('member', { autoStart: false })).rejects.toThrow(); expect(await business()).toEqual(before); expect(seen).toHaveLength(0);
  });
});
