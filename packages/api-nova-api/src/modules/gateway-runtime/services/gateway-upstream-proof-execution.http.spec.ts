import * as http from 'node:http';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { createUpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from '../../publication/security/upstream-authentication-challenge-transport';
import { createUpstreamAuthenticationChallengeOrchestrator } from '../../publication/security/upstream-authentication-challenge-orchestrator';
import { createUpstreamSecurityAuthorizationAdapter } from '../../publication/security/upstream-security-authorization-adapter';
import { GatewayUpstreamProofExecutionGuard } from './gateway-upstream-proof-execution.guard';
import { GatewayUpstreamSecurityRuntimeGuard } from './gateway-upstream-security-runtime.guard';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayCacheService } from './gateway-cache.service';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
describe('G5 independent pre-Runtime proof guard with real HTTP and G1 capability', () => {
  let db: DataSource, upstream: http.Server, gateway: http.Server, port: number, hits: number, route: any, context: any, row: any, result: any, secret: string;
  let session: object, held: any, sequence: string[], resolver: jest.Mock, read: jest.Mock, auth: jest.Mock, cache: GatewayCacheService;
  let service: ReturnType<typeof createUpstreamAuthenticationChallengeOrchestrator>;
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities: [Endpoint, Membership, Evidence], synchronize: true }).initialize();
    hits = 0; sequence = []; secret = 'synthetic-only'; session = Object.freeze({});
    upstream = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.setHeader('content-type', 'text/plain'); res.end('ok'); });
    const upstreamPort = await listen(upstream);
    const endpoint = await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target', rawOperation: { security: [{ Key: [] }] } });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET', target: `http://127.0.0.1:${upstreamPort}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
    const authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    const transport = createUpstreamAuthenticationChallengeTransport(authority), intent = Object.freeze({});
    service = createUpstreamAuthenticationChallengeOrchestrator({ authority, transport, repository: db.getRepository(Evidence), intents: { resolve: async token => { if (token !== intent) throw Error(); return { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', actorId: 'actor', intentId: 'intent' }; } } });
    result = await service.execute(intent);
    const { credentialType: ignored, ...captured } = authority.inspect(await authority.issue({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' })); context = { ...captured, actorId: 'actor' };
    const g1 = createUpstreamSecurityAuthorizationAdapter(service, { read: async (input, selector) => {
      if (input !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selector.runtimeMembershipId, runtimeAssetId: selector.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? context : undefined;
    } });
    const capabilities = new WeakMap<object, any>(); held = { proof: result.proof, session };
    read = jest.fn(async (request, scope) => { sequence.push('host-proof'); return capabilities.get(request); });
    auth = jest.fn(async (...args: Parameters<typeof g1.authorize>) => { sequence.push('g1'); return g1.authorize(...args); });
    const guard = new GatewayUpstreamProofExecutionGuard(db.getRepository(Endpoint), { read }, { authorize: auth });
    route = { routeBinding: { id: 'route', routePath: '/public', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' }, runtimeAsset: { id: 'runtime' }, membership: { id: 'membership' }, endpointDefinition: endpoint, sourceServiceAsset: { id: 'asset' }, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } }, cache: { enabled: true, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 4096 }, upstream: {} } };
    resolver = jest.fn(async () => { sequence.push('resolver'); return { headers: { 'x-key': 'synthetic-only' }, credentialHeaderNames: ['x-key'], managedHeaderNames: ['x-key'] }; });
    cache = new GatewayCacheService(); jest.spyOn(cache, 'resolve');
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)])); traffic.admit = jest.fn().mockResolvedValue({ release: jest.fn() });
    const proxy = new GatewayProxyEngineService(new GatewayRequestCaptureService(), { resolve: resolver }, metrics, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint)));
    const runtime = new GatewayRuntimeService({ resolve: () => route } as any, { authorize: async () => ({ mode: 'anonymous' }) } as any, traffic, cache, proxy, { recordRequest: async () => {} } as any, metrics);
    gateway = http.createServer((req, res) => {
      (req as any).originalUrl = req.url; (res as any).status = status => { res.statusCode = status; return res; };
      if (held) capabilities.set(req, held);
      // Explicit test composition only. Production module/runtime are deliberately untouched.
      void (async () => { await guard.assertCurrent(route, req); sequence.push('after-guard'); await runtime.forwardResolvedRoute(route, req as any, res as any); })()
        .catch(error => { if (!res.headersSent) { res.statusCode = error.getStatus?.() ?? 500; res.end(error.message); } else res.destroy(); });
    }); port = await listen(gateway);
  });
  afterEach(async () => { jest.restoreAllMocks(); await close(gateway); await close(upstream); await db.destroy(); });
  const invoke = (headers = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => http.get({ hostname: '127.0.0.1', port, path: '/public', headers }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body })); }).on('error', reject));
  it.each(['missing', 'forged', 'row', 'expired', 'revoked', 'scope', 'actor', 'epoch'])('rejects %s before resolver/cache/outbound', async failure => {
    if (failure === 'missing') held = undefined;
    if (failure === 'forged') held = { ...held, proof: JSON.parse(JSON.stringify(result.proof)) };
    if (failure === 'row') held = { ...held, proof: await db.getRepository(Evidence).findOneByOrFail({ id: result.evidenceId }) };
    if (failure === 'expired') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
    if (failure === 'revoked') await service.revoke(result);
    if (failure === 'scope') route.membership = { id: 'other-membership' };
    if (failure === 'actor') held = { ...held, session: {} };
    if (failure === 'epoch') secret = 'rotated';
    expect(await invoke({ 'x-security-proof': 'Verified', authorization: 'Bearer forged' })).toEqual({ status: 503, body: 'gateway_upstream_proof_unavailable' });
    expect(sequence).not.toContain('after-guard'); expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(4);
  });
  it('valid host proof is consumed but cannot bypass the existing E1 Verified gate', async () => {
    expect((await invoke()).status).toBe(503); expect(sequence).toEqual(['host-proof', 'g1', 'g1', 'after-guard']);
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(4);
  });
  it('blocks a populated cache before lookup when current declaration becomes protected and proof is absent', async () => {
    await db.getRepository(Endpoint).update('endpoint', { rawOperation: {} }); route.endpointDefinition = await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }); held = undefined;
    expect((await invoke()).status).toBe(200); expect(hits).toBe(5);
    resolver.mockClear(); (cache.resolve as jest.Mock).mockClear(); sequence = [];
    await db.getRepository(Endpoint).update('endpoint', { rawOperation: { security: [{ Key: [] }] } });
    expect((await invoke()).status).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(5);
  });
  it('does not trust snapshot protection removal and rejects host reader failures without leaking details', async () => {
    await db.getRepository(Endpoint).update('endpoint', { rawOperation: {} });
    read.mockRejectedValue(Error('secret-private-path')); expect(await invoke()).toEqual({ status: 503, body: 'gateway_upstream_proof_unavailable' });
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(4);
  });
});
