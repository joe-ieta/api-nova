import 'reflect-metadata';
import * as http from 'node:http';
import * as net from 'node:net';
import { inspect } from 'node:util';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { GatewayRuntimeController } from '../gateway-runtime.controller';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';
import { GatewayUpstreamSecurityRuntimeGuard } from './gateway-upstream-security-runtime.guard';
import { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } from './gateway-upstream-credential-resolver';
import { createUpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from '../../publication/security/upstream-authentication-challenge-transport';
import { createTrustedChallengeIntentAuthority } from '../../publication/security/trusted-challenge-intent-authority';
import { GATEWAY_UPSTREAM_PROOF_EXECUTION, createGatewayUpstreamProofExecution } from './gateway-upstream-proof-execution.wiring';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('Gateway proof guard registration over real Nest HTTP', () => {
  let db: DataSource, upstream: http.Server, hits: number, secret: string, session: object, context: any, route: any, clock: number;
  let registry: UpstreamCredentialRegistry, candidate: any, execution: ReturnType<typeof createGatewayUpstreamProofExecution>;
  let app: INestApplication, port: number, cache: GatewayCacheService, resolver: jest.Mock;
  let accessLog: { recordRequest: jest.Mock; recordUnmatchedRequest: jest.Mock }, metrics: Record<string, jest.Mock>;
  let bindRequest: (req: any) => Promise<void>;
  const selector = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
  const grantIds = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' };

  beforeEach(async () => {
    hits = 0; clock = 0; secret = 'synthetic-only';
    db = await new DataSource({ type: 'sqljs', entities: [Endpoint, Membership, Evidence], synchronize: true }).initialize();
    upstream = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.setHeader('content-type', 'text/plain'); res.end('ok'); });
    const upstreamPort = await listen(upstream);
    const endpoint = await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target', rawOperation: { security: [{ Key: [] }] } });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    const row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET' as 'GET' | 'HEAD', target: `http://127.0.0.1:${upstreamPort}/target`, declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    await registry.reload(candidate);
    const authority = createUpstreamSecurityContextAuthority({ read: async () => row }, () => registry.captureSnapshot());
    const transport = createUpstreamAuthenticationChallengeTransport(authority);
    session = Object.freeze({});
    const intentAuthority = createTrustedChallengeIntentAuthority({
      sessions: { resolve: async value => value === session ? { actorId: 'actor', authenticationEpoch: 'e1' } : undefined },
      users: { findUserById: async (id: string) => id === 'actor' ? { id: 'actor', isActive: true, isLocked: false,
        roles: [{ id: 'role', enabled: true, updatedAt: new Date(0), permissions: [{ id: 'permission', name: 'upstream:challenge', enabled: true, conditions: null, updatedAt: new Date(0) }] }] } as any : undefined },
      ownership: { resolve: async () => ({ revision: 'ownership-r1' }) },
      audit: { record: async () => undefined },
    });
    context = { ...authority.inspect(await authority.issue(grantIds)), actorId: 'actor' };
    const contexts = { read: async (value: unknown, selected: { runtimeAssetId: string; runtimeMembershipId: string }) => {
      if (value !== session) return undefined;
      const member = await db.getRepository(Membership).findOneBy({ id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId });
      return member?.endpointDefinitionId === context.endpointDefinitionId ? { ...context } : undefined;
    } };
    execution = createGatewayUpstreamProofExecution({ endpoints: db.getRepository(Endpoint), authority, transport, intents: intentAuthority,
      repository: db.getRepository(Evidence), contexts, ttlMs: 60000, now: () => clock });
    route = { routeBinding: { id: 'route', routePath: '/public', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' },
      runtimeAsset: { id: 'runtime' }, membership: { id: 'membership' }, endpointDefinition: endpoint, sourceServiceAsset: { id: 'asset' },
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {},
      policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } }, cache: { enabled: true, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 4096 }, upstream: {} } };
    resolver = jest.fn(async () => ({ headers: { 'x-key': secret }, credentialHeaderNames: ['x-key'], managedHeaderNames: ['x-key'] }));
    bindRequest = async () => undefined;
  });

  afterEach(async () => { await execution?.close(); if (app) { app.getHttpServer().closeAllConnections(); await app.close(); } await close(upstream); if (db?.isInitialized) await db.destroy(); });

  async function boot(proofExecution: unknown) {
    metrics = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent', 'recordRouteMiss'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    accessLog = { recordRequest: jest.fn(), recordUnmatchedRequest: jest.fn() };
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)])); traffic.admit = jest.fn().mockResolvedValue({ release: jest.fn() });
    const module = await Test.createTestingModule({
      controllers: [GatewayRuntimeController],
      providers: [
        GatewayRuntimeService,
        GatewayRequestCaptureService,
        GatewayProxyEngineService,
        { provide: GatewayRouteSnapshotService, useValue: { resolve: () => route } },
        { provide: GatewaySecurityService, useValue: { authorize: jest.fn().mockResolvedValue({ mode: 'anonymous' }) } },
        { provide: GatewayTrafficControlService, useValue: traffic },
        GatewayCacheService,
        { provide: GatewayAccessLogService, useValue: accessLog },
        { provide: GatewayRuntimeMetricsService, useValue: metrics },
        { provide: GatewayHeaderLegacyRuntimeGuard, useValue: { assertAllowed: jest.fn().mockResolvedValue(undefined) } },
        { provide: GatewayUpstreamSecurityRuntimeGuard, useValue: new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint)) },
        { provide: GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER, useValue: { resolve: resolver } },
        { provide: GATEWAY_UPSTREAM_PROOF_EXECUTION, useValue: proofExecution },
      ],
    }).compile();
    cache = module.get(GatewayCacheService); jest.spyOn(cache, 'resolve');
    app = module.createNestApplication({ bodyParser: false }); app.useLogger(false);
    app.getHttpAdapter().getInstance().use((req: any, _res: any, next: any) => { void bindRequest(req).then(() => next(), () => next()); });
    await app.listen(0, '127.0.0.1');
    port = app.getHttpServer().address().port;
  }

  const invoke = () => new Promise<{ status: number; message: string; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/gateway/public', method: 'GET' }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => { let message = body; try { message = JSON.parse(body).message; } catch { /* non-JSON */ } resolve({ status: response.statusCode!, message, body }); });
    }).on('error', reject);
  });

  it('keeps the current E1 behavior with the default-off provider', async () => {
    await boot(null);
    const result = await invoke();
    expect(result.status).toBe(503);
    expect(result.message).toBe('gateway_upstream_security_unverified');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });

  it('rejects a missing proof before resolver, cache or upstream', async () => {
    await boot(execution);
    const result = await invoke();
    expect(result.status).toBe(503);
    expect(result.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(0);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    const channels = [inspect(accessLog.recordRequest.mock.calls, { depth: 4 }), inspect(metrics.recordForwardResult.mock.calls, { depth: 4 }),
      inspect(metrics.recordPolicyObservabilityEvent.mock.calls, { depth: 4 })];
    for (const channel of channels) {
      expect(channel).not.toContain(secret); expect(channel).not.toContain('x-key');
      expect(channel).not.toContain('"proof"'); expect(channel).not.toContain('"session"');
      expect(channel).not.toContain('contextDigest'); expect(channel).not.toContain('providerEpoch');
    }
  });

  it('rejects an out-of-scope proof before resolver, cache or upstream', async () => {
    await boot(execution);
    route.membership = { id: 'other-membership' };
    const result = await invoke();
    expect(result.status).toBe(503);
    expect(result.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });

  it('rejects expired evidence and an expired request-bound capability before resolver, cache or upstream', async () => {
    await boot(execution);
    const expired = await execution.lifecycle.issue(session, grantIds);
    clock = 60001;
    bindRequest = async req => { await execution.lifecycle.bind(req, expired, selector, execution.capabilities, req.method); };
    const result = await invoke();
    expect(result.status).toBe(503);
    expect(result.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(4);

    clock = 120000;
    const bound = await execution.lifecycle.issue(session, grantIds);
    bindRequest = async req => { if (await execution.lifecycle.bind(req, bound, selector, execution.capabilities, req.method)) clock = 200000; };
    const expiredCapability = await invoke();
    expect(expiredCapability.status).toBe(503);
    expect(expiredCapability.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(8);
  });

  it('consumes a valid host proof once, rejects its replay, and never bypasses the E1 Verified gate', async () => {
    await boot(execution);
    const grant = await execution.lifecycle.issue(session, grantIds);
    bindRequest = async req => { expect(await execution.lifecycle.bind(req, grant, selector, execution.capabilities, req.method)).toBe(true); };
    const first = await invoke();
    expect(first.status).toBe(503);
    expect(first.message).toBe('gateway_upstream_security_unverified');
    expect(await execution.lifecycle.isCurrent(grant)).toBe(false);
    expect(first.body).not.toContain(secret);
    expect(inspect(accessLog.recordRequest.mock.calls, { depth: 4 })).not.toContain(secret);
    expect(inspect(metrics.recordForwardResult.mock.calls, { depth: 4 })).not.toContain(secret);
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(4);

    bindRequest = async req => { expect(await execution.lifecycle.bind(req, grant, selector, execution.capabilities, req.method)).toBe(false); };
    const replay = await invoke();
    expect(replay.status).toBe(503);
    expect(replay.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(cache.resolve).not.toHaveBeenCalled();
    expect(hits).toBe(4);
  });
});
