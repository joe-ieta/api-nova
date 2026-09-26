import * as net from 'node:net';
import { gzipSync } from 'node:zlib';
import { SourceServiceInstanceEntity as Instance } from '../../../database/entities/source-service-instance.entity';
import { RuntimeUpstreamBindingEntity as UpstreamBinding } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity as UpstreamCandidate } from '../../../database/entities/runtime-upstream-binding-instance.entity';
import { EndpointTestSampleEntity as Sample } from '../../../database/entities/endpoint-test-sample.entity';
import { RuntimeVerificationRunEntity as Run } from '../../../database/entities/runtime-verification-run.entity';
import { RuntimeVerificationResultEntity as Result } from '../../../database/entities/runtime-verification-result.entity';
import { MCPServerEntity } from '../../../database/entities/mcp-server.entity';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';
import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import { RuntimeGovernanceInvalidationService } from '../../runtime-governance/services/runtime-governance-invalidation.service';
import { RuntimeVerificationService } from '../../runtime-verification/services/runtime-verification.service';
import { GatewayCandidateReplayService } from '../../runtime-verification/services/gateway-candidate-replay.service';
import { McpCandidateReplayService } from '../../runtime-verification/services/mcp-candidate-replay.service';
import { RuntimeResponseAssertionService } from '../../runtime-verification/services/runtime-response-assertion.service';
import { RuntimeAssetsService } from '../../runtime-assets/services/runtime-assets.service';
import { installGatewayHttpIngressBoundary } from './gateway-http-ingress-boundary';
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
import { gatewayHostRuntimeProvider } from './gateway-host-runtime.providers';
import { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } from './gateway-upstream-credential-resolver';
import { GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider } from './gateway-upstream-credential.providers';
const listen = (s: http.Server) => new Promise<number>(resolve => s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port)));
const close = (s: http.Server) => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); });
const entities = [Route, Snapshot, Runtime, Member, Binding, Profile, Endpoint, Source, Ledger, Instance, UpstreamBinding, UpstreamCandidate, Sample, Run, Result, MCPServerEntity, GatewayConsumerCredentialEntity];
describe('H11B real deployment/replay and published Header v1 HTTP matrix', () => {
  let app: INestApplication, db: DataSource, module: TestingModule, registry: UpstreamCredentialRegistry, policy: GatewayPolicyService;
  let upstream: http.Server, gateway: http.Server, directory: string, port: number, upstreamPort: number, seen: any[], candidate: any;
  let assets: RuntimeAssetsService, upstreamBindings: RuntimeUpstreamBindingsService, handler: http.RequestListener, declaration: string | undefined;
  let publication: any, snapshots: GatewayRouteSnapshotService, runtime: GatewayRuntimeService, resolverSpy: jest.SpyInstance, route: any;
  const business = () => Promise.all([Route, Runtime, Member, Binding, Profile].map(entity => db.getRepository(entity as any).find()));
  beforeEach(async () => {
    seen = []; declaration = process.env.API_NOVA_H11B_SECRET; process.env.API_NOVA_H11B_SECRET = 'synthetic-h11b';
    handler = (_req, res) => { res.setHeader('content-type', 'text/plain'); res.setHeader('x-safe-result', 'yes'); res.setHeader('x-drop-result', 'no'); res.end('ok'); };
    upstream = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
    upstreamPort = await listen(upstream);
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    await db.getRepository(Source).save({ id: 'source', sourceKey: 'fixture' });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'source', path: '/items', method: 'GET', status: 'verified' as any, publishEnabled: true, rawOperation: {}, metadata: { testStatus: 'passed', lastProbeStatus: 'healthy' } });
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'fixture', type: RuntimeAssetType.GATEWAY_SERVICE });
    await db.getRepository(Member).save({ id: 'member', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    await db.getRepository(Profile).save({ id: 'profile', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member', status: 'reviewed' as any, intentName: 'read', descriptionForLlm: 'Read items' });
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'x-managed' }, secretRef: 'env:API_NOVA_H11B_SECRET' }, other: { type: 'apiKey', placement: { in: 'header', name: 'x-other' }, secretRef: 'env:API_NOVA_H11B_SECRET' } }, sites: [{ id: 'site', sourceServiceAssetId: 'source', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none', headerPolicy: { version: 1, requestHeaders: ['x-safe'], responseHeaders: ['x-safe-result'] }, endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    directory = await fs.mkdtemp(join(tmpdir(), 'apinova-h11a-'));
    const file = join(directory, 'registry.json'); await fs.writeFile(file, JSON.stringify(candidate));
    module = await Test.createTestingModule({ providers: [{ provide: DataSource, useValue: db }, { provide: ConfigService, useValue: new ConfigService({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: file, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'test' }) }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider, gatewayHeaderLegacyRuntimeGuardProvider, gatewayHostRuntimeProvider, GatewayPolicyService] }).compile();
    registry = module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY); policy = module.get(GatewayPolicyService);
    await db.getRepository(Instance).save({ id: 'instance', sourceServiceAssetId: 'source', name: 'loopback', environment: 'test', scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/', status: 'healthy' as any });
    const invalidation = new RuntimeGovernanceInvalidationService(db.getRepository(Runtime), db.getRepository(Member), db.getRepository(UpstreamBinding), db.getRepository(UpstreamCandidate));
    upstreamBindings = new RuntimeUpstreamBindingsService(db.getRepository(UpstreamBinding), db.getRepository(UpstreamCandidate), db.getRepository(Instance), db, { log: async () => undefined } as any, invalidation);
    await upstreamBindings.upsert('member', { sourceServiceAssetId: 'source', environment: 'test', selectionMode: 'fixed_primary', primaryInstanceId: 'instance', status: 'active', candidates: [{ sourceServiceInstanceId: 'instance' }] } as any, { actorId: 'fixture' });
    await db.getRepository(Sample).save({ id: 'sample', endpointDefinitionId: 'endpoint', testRunId: 'test', fingerprint: 'fixture', tags: ['smoke'], capturedAt: new Date(), requestPayload: {}, responseStatusCode: 200, responsePayload: 'ok', metadata: { responseAssertion: { mode: 'exact' } } });
    const context = async () => ({ membership: await db.getRepository(Member).findOneByOrFail({ id: 'member' }), runtimeAsset: await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' }), endpointDefinition: await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }), sourceServiceAsset: await db.getRepository(Source).findOneByOrFail({ id: 'source' }) });
    publication = Object.create(PublicationService.prototype);
    Object.assign(publication, { gatewayPolicyService: policy, routeBindingRepository: db.getRepository(Route), profileRepository: db.getRepository(Profile),
      resolveMembershipPublicationContext: context, ensureRouteConflictFree: jest.fn(), writeHistory: jest.fn(), recordAuditEvent: jest.fn(),
      emitGatewaySnapshotRefresh: jest.fn(() => { expect(db.createQueryRunner().isTransactionActive).toBe(false); }),
      buildMembershipPublicationState: context, buildPostPublishDeploymentState: async () => ({ attempted: false }) });
    await publication.configureRuntimeMembershipGatewayRoute('member', { routePath: '/items', routeMethod: 'GET', upstreamPath: '/items', upstreamMethod: 'GET', routeVisibility: 'external', authPolicyRef: 'anonymous', cachePolicyRef: 'enabled', upstreamConfig: { cache: { ttlMs: 30000, maxBodyBytes: 4096 }, headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } });
    snapshots = new GatewayRouteSnapshotService(policy, db.getRepository(Route), db.getRepository(Snapshot), db.getRepository(Member), db.getRepository(Binding), db.getRepository(Runtime), db.getRepository(Endpoint), db.getRepository(Source), upstreamBindings);
    const actualResolver = module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER);
    const wrapper = { headerPolicyEnabled: true, resolve: (...args: any[]) => actualResolver.resolve(...args) }; resolverSpy = jest.spyOn(wrapper, 'resolve');
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)])); traffic.admit = async () => ({ release() {} });
    runtime = new GatewayRuntimeService(snapshots, { authorize: async () => ({ mode: 'anonymous' }) } as any, traffic, new GatewayCacheService(), new GatewayProxyEngineService(new GatewayRequestCaptureService(), wrapper, metrics, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint))), { recordRequest: async () => undefined } as any, metrics, module.get(GatewayHeaderLegacyRuntimeGuard));
    const verification = new RuntimeVerificationService(db.getRepository(Runtime), db.getRepository(Member), db.getRepository(Sample), db.getRepository(Run), db.getRepository(Result), upstreamBindings, snapshots, new GatewayCandidateReplayService(snapshots, runtime), new McpCandidateReplayService(), new RuntimeResponseAssertionService());
    assets = new RuntimeAssetsService({} as any, { emit() {} } as any, db.getRepository(Runtime), db.getRepository(MCPServerEntity), db.getRepository(Member), db.getRepository(Endpoint), db.getRepository(Source), db.getRepository(Profile), db.getRepository(Binding), db.getRepository(Route), db.getRepository(GatewayConsumerCredentialEntity), {} as any, { getRuntimeAssetMetrics: () => ({}) } as any, {} as any, { recordRuntimeControlEvent: async () => undefined } as any, { log: async () => undefined } as any, upstreamBindings, verification);
    const httpModule = await Test.createTestingModule({ controllers: [GatewayRuntimeController], providers: [{ provide: GatewayRuntimeService, useValue: runtime }] }).compile();
    app = httpModule.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    installGatewayHttpIngressBoundary(app.getHttpServer(), req => { const current = snapshots.resolve(req.headers.host, req.method || 'GET', '/items'); return Boolean(current && policy.assertHeaderV1Ready(current.routeBinding)); });
    await app.listen(0, '127.0.0.1');
    gateway = app.getHttpServer(); port = (gateway.address() as any).port;
  });
  afterEach(async () => { if (declaration === undefined) delete process.env.API_NOVA_H11B_SECRET; else process.env.API_NOVA_H11B_SECRET = declaration; if (gateway) gateway.closeAllConnections(); await app?.close(); if (upstream) await close(upstream); await module?.close(); if (db?.isInitialized) await db.destroy(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
  async function publish() {
    await publication.publishRuntimeMembership('member', { autoStart: false });
    // SQL.js timestamps are second precision; do not weaken production stale-candidate checks.
    await new Promise(resolve => setTimeout(resolve, 1050));
    const deployed = await assets.deployGatewayRuntimeAsset('runtime').catch(error => { throw new Error(JSON.stringify(error.getResponse?.() ?? error.message)); });
    expect(deployed.verification.run.status).toBe('passed');
    expect(seen.length).toBeGreaterThan(0);
    await snapshots.reload(); route = snapshots.resolve(undefined, 'GET', '/items');
    expect(route).toBeTruthy();
  }
  const request = (headers: http.OutgoingHttpHeaders = {}, direct = false, body?: Buffer) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; trailers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: direct ? upstreamPort : port, path: direct ? '/items' : '/api/v1/gateway/items', method: 'GET', headers }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => setImmediate(() => resolve({ status: res.statusCode!, headers: res.headers, trailers: res.trailers, body: Buffer.concat(chunks) }))); });
    req.on('error', reject); req.end(body);
  });
  it('deploys through real assemble, plan, replay, verify, and atomic activation before public cache', async () => {
    await publish(); expect(await db.getRepository(Run).count()).toBe(1); expect(await db.getRepository(Result).count()).toBe(1);
    seen = []; expect((await request()).body.toString()).toBe('ok'); const cached = await request();
    expect(cached.headers['x-apinova-cache']).toBe('HIT'); expect(seen).toHaveLength(1);
  });

  async function reload(configure: (value: any) => void) {
    configure(candidate); candidate.metadata.revision += '-next'; await registry.reload(candidate);
  }
  it('H01/H03/H09 strips consumer authentication and unknown headers and uses only the real peer', async () => {
    await reload(value => { value.sites[0].credential = 'key'; }); await publish(); seen = [];
    const result = await request({ Authorization: 'consumer', 'X-API-Key': 'consumer', Cookie: 'consumer', 'Proxy-Authorization': 'consumer', 'x-managed': 'consumer', 'x-business': 'strip', 'x-safe': 'keep', 'x-forwarded-for': '203.0.113.99', forwarded: 'for=203.0.113.99', 'x-request-id': 'forged' });
    expect(result.status).toBe(200); expect(seen).toHaveLength(1);
    for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization', 'x-business', 'forwarded']) expect(seen[0][name]).toBeUndefined();
    expect(seen[0]['x-managed']).toBe('synthetic-h11b'); expect(seen[0]['x-safe']).toBe('keep');
    expect(seen[0]['x-forwarded-for']).toBe('127.0.0.1'); expect(seen[0]['x-request-id']).not.toBe('forged');
  });
  it('H02 Connection nominations remove business/consumer values while trusted credentials are reconstructed', async () => {
    await reload(value => { value.sites[0].credential = 'key'; }); await publish(); seen = [];
    expect((await request({ connection: 'x-safe, x-managed', 'x-safe': 'remove', 'x-managed': 'forged' })).status).toBe(200);
    expect(seen[0]['x-safe']).toBeUndefined(); expect(seen[0]['x-managed']).toBe('synthetic-h11b');
  });
  it.each(['inherit', 'empty', 'replace'])('H04 %s is compiled and replayed through deployment', async mode => {
    await reload(value => { if (mode !== 'inherit') value.sites[0].endpoints[0].headerPolicy = { version: 1, requestHeaders: mode === 'empty' ? [] : ['x-endpoint'], responseHeaders: mode === 'empty' ? [] : ['x-endpoint-result'] }; });
    await publish(); seen = [];
    handler = (_req, res) => { res.setHeader('x-safe-result', 'site'); res.setHeader('x-endpoint-result', 'endpoint'); res.end('ok'); };
    const result = await request({ 'x-safe': 'site', 'x-endpoint': 'endpoint' }); expect(result.status).toBe(200);
    expect(seen[0]['x-safe']).toBe(mode === 'inherit' ? 'site' : undefined); expect(seen[0]['x-endpoint']).toBe(mode === 'replace' ? 'endpoint' : undefined);
    expect(result.headers['x-safe-result']).toBe(mode === 'inherit' ? 'site' : undefined); expect(result.headers['x-endpoint-result']).toBe(mode === 'replace' ? 'endpoint' : undefined);
  });
  it.each(['x-managed', 'connection', '*'])('H05 invalid %s reload has zero upstream writes and preserves the deployed snapshot', async name => {
    await publish(); const active = (await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' })).metadata!.activeRevision;
    const generation = registry.captureSnapshot().generation; seen = [];
    candidate.metadata.revision = 'invalid'; candidate.sites[0].headerPolicy.requestHeaders = [name];
    await expect(registry.reload(candidate)).rejects.toThrow(); expect(seen).toHaveLength(0); expect(registry.captureSnapshot().generation).toBe(generation);
    expect((await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' })).metadata!.activeRevision).toBe(active);
    expect((await request()).status).toBe(200);
  });
  it('H06 None removes every candidate credential without injection', async () => {
    await publish(); seen = []; expect((await request({ 'x-managed': 'forged', 'x-other': 'forged', authorization: 'forged' })).status).toBe(200);
    for (const name of ['x-managed', 'x-other', 'authorization']) expect(seen[0][name]).toBeUndefined();
  });
  it('H07 rotation and removal keep historical names rejected by the durable production Registry', async () => {
    await publish(); await reload(value => { value.credentials.key.placement.name = 'x-rotated'; });
    await reload(value => { delete value.credentials.key; }); seen = [];
    expect((await request({ 'x-managed': 'retired', 'x-rotated': 'retired', 'x-other': 'forged' })).status).toBe(200);
    for (const name of ['x-managed', 'x-rotated', 'x-other']) expect(seen[0][name]).toBeUndefined();
    expect(registry.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-managed', 'x-rotated']));
  });
  it('H07 closed SQL.js and cold Registry retain retired authentication history on real published HTTP', async () => {
    await publish(); await reload(value => { value.credentials.key.placement.name = 'x-rotated'; });
    await reload(value => { delete value.credentials.key; });
    await fs.writeFile(join(directory, 'registry.json'), JSON.stringify(candidate));
    gateway.closeAllConnections(); await app.close(); await module.close();
    const database = (db.driver as any).export(); await db.destroy();
    db = await new DataSource({ type: 'sqljs', entities, database, synchronize: false }).initialize();
    module = await Test.createTestingModule({ providers: [{ provide: DataSource, useValue: db }, { provide: ConfigService, useValue: new ConfigService({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: join(directory, 'registry.json'), API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'test' }) }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider, gatewayHeaderLegacyRuntimeGuardProvider, gatewayHostRuntimeProvider, GatewayPolicyService] }).compile();
    registry = module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY); policy = module.get(GatewayPolicyService);
    const invalidation = new RuntimeGovernanceInvalidationService(db.getRepository(Runtime), db.getRepository(Member), db.getRepository(UpstreamBinding), db.getRepository(UpstreamCandidate));
    upstreamBindings = new RuntimeUpstreamBindingsService(db.getRepository(UpstreamBinding), db.getRepository(UpstreamCandidate), db.getRepository(Instance), db, { log: async () => undefined } as any, invalidation);
    snapshots = new GatewayRouteSnapshotService(policy, db.getRepository(Route), db.getRepository(Snapshot), db.getRepository(Member), db.getRepository(Binding), db.getRepository(Runtime), db.getRepository(Endpoint), db.getRepository(Source), upstreamBindings);
    await snapshots.reload();
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, async () => undefined]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, async () => undefined])); traffic.admit = async () => ({ release() {} });
    runtime = new GatewayRuntimeService(snapshots, { authorize: async () => ({ mode: 'anonymous' }) } as any, traffic, new GatewayCacheService(), new GatewayProxyEngineService(new GatewayRequestCaptureService(), module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER), metrics, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint))), { recordRequest: async () => undefined } as any, metrics, module.get(GatewayHeaderLegacyRuntimeGuard));
    const httpModule = await Test.createTestingModule({ controllers: [GatewayRuntimeController], providers: [{ provide: GatewayRuntimeService, useValue: runtime }] }).compile();
    app = httpModule.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
    installGatewayHttpIngressBoundary(app.getHttpServer(), req => { const current = snapshots.resolve(req.headers.host, req.method || 'GET', '/items'); return Boolean(current && policy.assertHeaderV1Ready(current.routeBinding)); });
    await app.listen(0, '127.0.0.1'); gateway = app.getHttpServer(); port = (gateway.address() as any).port;
    expect(registry.captureSnapshot().generation).toBe(1); expect(registry.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-managed', 'x-rotated']));
    const invalid = structuredClone(candidate); invalid.metadata.revision = 'resurrected'; invalid.sites[0].headerPolicy.requestHeaders = ['x-managed'];
    await expect(registry.reload(invalid)).rejects.toThrow(); seen = [];
    expect((await request({ 'x-managed': 'retired', 'x-rotated': 'retired' })).status).toBe(200);
    expect(seen[0]['x-managed']).toBeUndefined(); expect(seen[0]['x-rotated']).toBeUndefined(); expect(await db.getRepository(Snapshot).count()).toBe(1);
  });
  it.each(['range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range'])('H11 %s bypasses an existing cache and matches direct status/headers/body', async name => {
    await publish(); seen = [];
    handler = (req, res) => {
      res.setHeader('content-type', 'text/plain'); res.setHeader('etag', '"v1"'); res.setHeader('last-modified', 'Thu, 24 Sep 2026 00:00:00 GMT');
      if (req.headers[name]) {
        if (name === 'range' || name === 'if-range') { res.statusCode = 206; res.setHeader('content-range', 'bytes 0-1/6'); res.end('ab'); }
        else if (name === 'if-match' || name === 'if-unmodified-since') { res.statusCode = 412; res.end('precondition'); }
        else { res.statusCode = 304; res.end(); }
      } else res.end('abcdef');
    };
    await request(); expect((await request()).headers['x-apinova-cache']).toBe('HIT');
    const headers = { [name]: name === 'range' ? 'bytes=0-1' : '"v1"' };
    const direct = await request(headers, true); seen = [];
    for (let i = 0; i < 2; i++) {
      const response = await request(headers); expect(response.status).toBe(direct.status); expect(response.body).toEqual(direct.body);
      for (const header of ['etag', 'last-modified', 'content-range', 'content-type', 'content-length']) expect(response.headers[header]).toEqual(direct.headers[header]);
      expect(response.headers['x-apinova-cache']).toBeUndefined();
    }
    expect(seen).toHaveLength(2); const ordinary = await request(); expect(ordinary.body.toString()).toBe('abcdef'); expect(ordinary.headers['x-apinova-cache']).toBe('HIT');
  });
  it('H11 identity and gzip representations match direct bytes and occupy distinct cache entries', async () => {
    await publish(); handler = (req, res) => { const body = Buffer.from('compressed published response'); const gzip = req.headers['accept-encoding'] === 'gzip'; const bytes = gzip ? gzipSync(body) : body;
      res.setHeader('content-type', 'text/plain'); res.setHeader('vary', 'accept-encoding'); res.setHeader('content-length', bytes.length); if (gzip) res.setHeader('content-encoding', 'gzip'); res.end(bytes); };
    for (const encoding of ['identity', 'gzip']) {
      const headers = { 'accept-encoding': encoding }; const direct = await request(headers, true); seen = [];
      const miss = await request(headers), hit = await request(headers);
      expect(miss.body).toEqual(direct.body); expect(hit.body).toEqual(direct.body); expect(miss.status).toBe(direct.status); expect(hit.headers['x-apinova-cache']).toBe('HIT');
      for (const header of ['content-type', 'content-length', 'content-encoding', 'vary']) { expect(miss.headers[header]).toEqual(direct.headers[header]); expect(hit.headers[header]).toEqual(direct.headers[header]); }
      expect(seen).toHaveLength(1);
    }
  });
  it('H08 duplicate allowed singletons reject before upstream while multi-value Accept merges', async () => {
    await publish(); seen = [];
    expect((await request({ 'x-safe': ['one', 'two'] })).status).toBe(400); expect(seen).toHaveLength(0);
    expect((await request({ accept: ['text/plain', 'application/json'] })).status).toBe(200);
    expect(seen[0].accept).toBe('text/plain, application/json');
  });
  it.each(['Content-Length: 2\r\nTransfer-Encoding: chunked', 'Content-Length: 2\r\nContent-Length: 2', 'X-Safe: bad\rvalue'])('H08/H10 raw invalid framing rejects before connecting: %s', async framing => {
    await publish(); seen = [];
    const output = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1'); let output = '';
      socket.on('data', chunk => { output += chunk.toString(); }); socket.on('error', reject); socket.on('close', () => resolve(output));
      socket.on('connect', () => socket.write('GET /api/v1/gateway/items HTTP/1.1\r\nHost: localhost\r\n' + framing + '\r\nConnection: close\r\n\r\nab'));
    });
    expect(output).toContain('400 Bad Request'); expect(seen).toHaveLength(0);
  });
  it.each(['fixed', 'chunked', 'empty'])('H10 %s body framing matches actual upstream bytes without cache or replay', async framing => {
    await publish(); seen = [];
    const bytes = framing === 'empty' ? Buffer.alloc(0) : Buffer.from('published body'); let actual = Buffer.alloc(0);
    handler = (req, res) => { const parts: Buffer[] = []; req.on('data', chunk => parts.push(chunk)); req.on('end', () => { actual = Buffer.concat(parts); res.setHeader('content-length', actual.length); res.end(actual); }); };
    const result = await request(framing === 'chunked' ? { 'transfer-encoding': 'ChUnKeD' } : { 'content-length': String(bytes.length) }, false, bytes);
    expect(result.status).toBe(200); expect(result.body).toEqual(bytes); expect(actual).toEqual(bytes); expect(seen).toHaveLength(1);
    if (framing === 'chunked') { expect(seen[0]['transfer-encoding']).toBe('chunked'); expect(seen[0]['content-length']).toBeUndefined(); }
    else { expect(seen[0]['content-length']).toBe(String(bytes.length)); expect(seen[0]['transfer-encoding']).toBeUndefined(); }
  });
  it.each(['trailer', 'trailers'])('H02 rejects inbound %s declarations before upstream', async name => {
    await publish(); seen = [];
    const result = await request({ [name]: 'x-tail', 'transfer-encoding': 'chunked' });
    expect(result.status).toBe(400); expect(seen).toHaveLength(0);
  });
  it('H02 actual response trailers are dropped from the published response', async () => {
    await publish(); seen = [];
    handler = (_req, res) => { res.write('ok'); res.addTrailers({ 'x-tail': 'discard' }); res.end(); };
    const result = await request(); expect(result.status).toBe(200); expect(result.body.toString()).toBe('ok'); expect(result.headers['x-tail']).toBeUndefined(); expect(Object.keys(result.trailers)).toHaveLength(0);
  });
  it('H10 client cancellation closes the upstream exchange and does not retry it', async () => {
    await publish(); seen = [];
    let closeObserved!: () => void; const closed = new Promise<void>(resolve => { closeObserved = resolve; });
    handler = (_req, res) => { res.on('close', closeObserved); res.write('first'); };
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/v1/gateway/items' }, res => {
        res.once('data', () => { req.destroy(); res.destroy(); resolve(); }); res.on('error', () => undefined);
      }); req.on('error', error => { if ((error as any).code !== 'ECONNRESET') reject(error); });
    });
    await closed; expect(seen).toHaveLength(1);
  });
  it('H10 actual installed ingress rejects Expect without replaying a body upstream', async () => {
    await publish(); seen = []; const result = await request({ expect: '100-continue', 'content-length': '2' }, false, Buffer.from('hi'));
    expect(result.status).toBe(417); expect(seen).toHaveLength(0);
  });
  it('H12 current provider failure is fixed 503 before any upstream connection or cache response', async () => {
    await reload(value => { value.sites[0].credential = 'key'; }); await publish(); await request(); seen = [];
    delete process.env.API_NOVA_H11B_SECRET; const result = await request(); expect(result.status).toBe(503); expect(seen).toHaveLength(0);
    expect(result.body.toString()).not.toContain('API_NOVA_H11B_SECRET'); expect(result.body.toString()).not.toContain('synthetic-h11b');
  });
  it('failed real candidate replay preserves the prior active revision and snapshot', async () => {
    await publish(); const before = await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' }); const snapshotCount = await db.getRepository(Snapshot).count();
    handler = (_req, res) => { res.statusCode = 503; res.end('unavailable'); };
    await expect(assets.deployGatewayRuntimeAsset('runtime')).rejects.toThrow('Gateway candidate replay failed');
    const after = await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' }); expect(after.metadata!.activeRevision).toBe(before.metadata!.activeRevision);
    expect(await db.getRepository(Snapshot).count()).toBe(snapshotCount); expect(snapshots.resolve(undefined, 'GET', '/items')).toBeTruthy();
  });
});
