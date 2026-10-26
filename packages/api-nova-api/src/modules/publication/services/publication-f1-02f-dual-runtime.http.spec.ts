import 'reflect-metadata';
import * as http from 'node:http';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity, transformToMCPTools } from 'api-nova-parser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { GatewayRuntimeController } from '../../gateway-runtime/gateway-runtime.controller';
import { GatewayRuntimeService } from '../../gateway-runtime/services/gateway-runtime.service';
import { GatewayProxyEngineService } from '../../gateway-runtime/services/gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from '../../gateway-runtime/services/gateway-request-capture.service';
import { GatewayCacheService } from '../../gateway-runtime/services/gateway-cache.service';
import { GatewayAccessLogService } from '../../gateway-runtime/services/gateway-access-log.service';
import { GatewayRuntimeMetricsService } from '../../gateway-runtime/services/gateway-runtime-metrics.service';
import { GatewayRouteSnapshotService } from '../../gateway-runtime/services/gateway-route-snapshot.service';
import { GatewaySecurityService } from '../../gateway-runtime/services/gateway-security.service';
import { GatewayTrafficControlService } from '../../gateway-runtime/services/gateway-traffic-control.service';
import { GatewayHeaderLegacyRuntimeGuard } from '../../gateway-runtime/services/gateway-header-legacy-runtime.guard';
import { GatewayUpstreamSecurityRuntimeGuard } from '../../gateway-runtime/services/gateway-upstream-security-runtime.guard';
import { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } from '../../gateway-runtime/services/gateway-upstream-credential-resolver';
import { GATEWAY_UPSTREAM_PROOF_EXECUTION, createGatewayUpstreamProofExecution } from '../../gateway-runtime/services/gateway-upstream-proof-execution.wiring';
import { createUpstreamSecurityContextAuthority } from '../security/upstream-security-context-authority';
import { createUpstreamAuthenticationChallengeTransport } from '../security/upstream-authentication-challenge-transport';
import { createTrustedChallengeIntentAuthority } from '../security/trusted-challenge-intent-authority';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

const selector = { runtimeAssetId: 'runtime', runtimeMembershipId: 'membership' };
const grantIds = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint' };
const protectedDeclaration = normalizeUpstreamSecurity({ security: [{ Key: [] }],
  components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {});

describe('F1-02F Gateway upstream path over real Nest HTTP', () => {
  let db: DataSource, upstream: http.Server, hits: number, secret: string, session: object, context: any;
  let routeProtected: any, routeOpen: any, route: any;
  let execution: ReturnType<typeof createGatewayUpstreamProofExecution>;
  let app: INestApplication, port: number, resolver: jest.Mock, cache: GatewayCacheService;
  let accessLog: { recordRequest: jest.Mock; recordUnmatchedRequest: jest.Mock }, metrics: Record<string, jest.Mock>;
  let bindRequest: (req: any) => Promise<void>;

  beforeEach(async () => {
    hits = 0; secret = 'synthetic-only';
    db = await new DataSource({ type: 'sqljs', entities: [Endpoint, Membership, Evidence], synchronize: true }).initialize();
    upstream = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.setHeader('content-type', 'text/plain'); res.end('ok'); });
    const upstreamPort = await listen(upstream);
    const endpoint = await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target',
      rawOperation: { security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } } });
    const openEndpoint = await db.getRepository(Endpoint).save({ id: 'open-endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/open-target', rawOperation: {} });
    await db.getRepository(Membership).save({ id: 'membership', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint' });
    const row = { sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint', bindingId: 'binding', bindingRevision: 'r1', method: 'GET' as 'GET' | 'HEAD', target: `http://127.0.0.1:${upstreamPort}/target`, declaration: protectedDeclaration };
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
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
      repository: db.getRepository(Evidence), contexts, ttlMs: 60000 });
    const policies = { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } }, cache: { enabled: true, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 4096 }, upstream: {} };
    routeProtected = { routeBinding: { id: 'route', routePath: '/public', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' },
      runtimeAsset: { id: 'runtime' }, membership: { id: 'membership', publicationRevision: 1 }, endpointDefinition: endpoint, sourceServiceAsset: { id: 'asset' },
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, policies };
    routeOpen = { ...routeProtected, endpointDefinition: openEndpoint };
    route = routeProtected;
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

  it('executes the open route end-to-end with the proof provider enabled while the protected route stays Verified-closed', async () => {
    await boot(execution);
    route = routeOpen;
    const before = hits;
    const open = await invoke();
    expect(open.status).toBe(200); expect(open.body).toBe('ok'); expect(hits).toBe(before + 1);
    expect(resolver).toHaveBeenCalled();

    route = routeProtected;
    const grant = await execution.lifecycle.issue(session, grantIds);
    const challengeHits = hits;
    bindRequest = async req => { expect(await execution.lifecycle.bind(req, grant, selector, execution.capabilities, req.method)).toBe(true); };
    resolver.mockClear(); (cache.resolve as jest.Mock).mockClear();
    const result = await invoke();
    expect(result.status).toBe(503); expect(result.message).toBe('gateway_upstream_security_unverified');
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(challengeHits);
    expect(await execution.lifecycle.isCurrent(grant)).toBe(false);
  });

  it('keeps default-off parity for the open route and never opens the protected route without the provider', async () => {
    await boot(null);
    route = routeOpen;
    const before = hits;
    const open = await invoke();
    expect(open.status).toBe(200); expect(open.body).toBe('ok'); expect(hits).toBe(before + 1);

    route = routeProtected;
    resolver.mockClear(); (cache.resolve as jest.Mock).mockClear();
    const result = await invoke();
    expect(result.status).toBe(503); expect(result.message).toBe('gateway_upstream_security_unverified');
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(before + 1);
  });

  it('rejects missing proofs and a same-revision Provider secret change before resolver, cache or upstream', async () => {
    await boot(execution);
    route = routeProtected;
    const missing = await invoke();
    expect(missing.status).toBe(503); expect(missing.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled();

    const grant = await execution.lifecycle.issue(session, grantIds);
    bindRequest = async req => { await execution.lifecycle.bind(req, grant, selector, execution.capabilities, req.method); };
    secret = 'rotated-synthetic';
    const before = hits;
    const rotated = await invoke();
    expect(rotated.status).toBe(503); expect(rotated.message).toBe('gateway_upstream_proof_unavailable');
    expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled(); expect(hits).toBe(before);
  });
});

describe('F1-02F MCP endpoint path over real Streamable HTTP', () => {
  let db: DataSource, upstream: http.Server, registry: UpstreamCredentialRegistry;
  let mcpHttp: http.Server, mcpPort: number, mcpServer: McpServer;
  let hits: number, secret: string, seen: string[];

  const specDocument = (upstreamPort: number) => ({
    openapi: '3.0.3', info: { title: 'f1-02f-mcp-fixture', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
    components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
    paths: {
      '/open': { get: { operationId: 'open', responses: { 200: { description: 'ok' } } } },
      '/protected': { get: { operationId: 'protected', security: [{ Key: [] }], responses: { 200: { description: 'ok' } } } },
    },
  });
  const bindings = [
    { method: 'GET', path: '/open', sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint-open' },
    { method: 'GET', path: '/protected', sourceServiceAssetId: 'asset', endpointDefinitionId: 'endpoint-protected' },
  ];
  const tools = (withCredentialPolicy: boolean) => transformToMCPTools(specDocument((upstream.address() as net.AddressInfo).port) as any,
    withCredentialPolicy
      ? { trustedOperationBindings: bindings, upstreamCredentialPolicy: { mode: 'single-hop' as const, captureSnapshot: () => registry.captureSnapshot() } }
      : { trustedOperationBindings: bindings });
  const toolFor = (list: any[], operationId: string) => list.find(tool => tool.metadata?.operationId === operationId) ?? list.find(tool => tool.name?.includes(operationId));

  const startMcp = async (list: any[]) => {
    mcpServer = new McpServer({ name: 'f1-02f-mcp', version: '1.0.0' });
    for (const tool of list) {
      mcpServer.registerTool(tool.name, { description: `fixture ${tool.name}`, inputSchema: {} }, async (args: any) => tool.handler(args));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer.connect(transport);
    mcpHttp = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        await transport.handleRequest(req, res, body);
      })().catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    });
    mcpPort = await listen(mcpHttp);
  };

  const callTool = async (client: Client, name: string) => {
    const result = await client.callTool({ name, arguments: {} });
    return JSON.parse(JSON.stringify(result));
  };
  const connectClient = async () => {
    const client = new Client({ name: 'f1-02f-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
    await client.connect(transport);
    return client;
  };

  beforeEach(async () => {
    hits = 0; secret = 'synthetic-only'; seen = [];
    db = await new DataSource({ type: 'sqljs', entities: [Endpoint], synchronize: true }).initialize();
    upstream = http.createServer((req, res) => {
      const provided = req.headers['x-key'];
      hits++; seen.push(String(provided ?? ''));
      res.statusCode = !provided || provided === secret ? 200 : 401;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    });
    await listen(upstream);
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => secret }) });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: (upstream.address() as net.AddressInfo).port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key',
        endpoints: [{ endpointDefinitionId: 'endpoint-open' }, { endpointDefinitionId: 'endpoint-protected' }] }] });
  });

  afterEach(async () => { if (mcpHttp) await close(mcpHttp); await mcpServer?.close().catch(() => undefined); await close(upstream); if (db?.isInitialized) await db.destroy(); });

  it('executes an explicit Unsecured tool through real MCP HTTP with trusted single-hop credentials', async () => {
    const list = await tools(true);
    await startMcp(list);
    const client = await connectClient();
    try {
      const result = await callTool(client, toolFor(list, 'open').name);
      expect(result.isError).not.toBe(true);
      expect(hits).toBe(1); expect(seen).toEqual([secret]);

      const before = hits;
      const protectedResult = await callTool(client, toolFor(list, 'protected').name);
      expect(protectedResult.isError).toBe(true);
      expect(JSON.stringify(protectedResult)).toContain('UPSTREAM_SECURITY_UNVERIFIED');
      expect(hits).toBe(before);
    } finally { await client.close().catch(() => undefined); }
  });

  it('keeps default parity without the trusted credential policy and never opens the protected tool', async () => {
    const list = await tools(false);
    await startMcp(list);
    const client = await connectClient();
    try {
      const result = await callTool(client, toolFor(list, 'open').name);
      expect(result.isError).not.toBe(true);
      expect(hits).toBe(1); expect(seen).toEqual(['']);

      const before = hits;
      const protectedResult = await callTool(client, toolFor(list, 'protected').name);
      expect(protectedResult.isError).toBe(true);
      expect(JSON.stringify(protectedResult)).toContain('UPSTREAM_SECURITY_UNVERIFIED');
      expect(hits).toBe(before);
    } finally { await client.close().catch(() => undefined); }
  });

  it('never serves a cached old secret after a same-revision Provider change through the MCP path', async () => {
    const list = await tools(true);
    await startMcp(list);
    const client = await connectClient();
    try {
      const first = await callTool(client, toolFor(list, 'open').name);
      expect(first.isError).not.toBe(true);
      secret = 'rotated-synthetic';
      const second = await callTool(client, toolFor(list, 'open').name);
      expect(second.isError).not.toBe(true);
      expect(hits).toBe(2);
      expect(seen).toEqual(['synthetic-only', 'rotated-synthetic']);
    } finally { await client.close().catch(() => undefined); }
  });
});
