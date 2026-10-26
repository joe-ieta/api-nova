import 'reflect-metadata';
import * as http from 'node:http';
import * as net from 'node:net';
import express = require('express');
import axios from 'axios';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { transformOpenApiToMcpTools } from '../../../../../api-nova-server/src/transform/transformOpenApiToMcpTools';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayRuntimeService } from './gateway-runtime.service';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

const endpoints = {
  inherit: 'endpoint-inherit',
  unlisted: 'endpoint-unlisted',
  override: 'endpoint-override',
  none: 'endpoint-none',
  missing: 'endpoint-missing',
  scoped: 'endpoint-scoped',
  unresolved: 'endpoint-unresolved',
  elsewhere: 'endpoint-elsewhere',
} as const;

const operationNames = Object.keys(endpoints) as Array<keyof typeof endpoints>;
const headerParameters = ['Authorization', 'Proxy-Authorization', 'X-Api-Key', 'Cookie', 'X-Override-Key', 'X-Business'];

const registryDocument = (upstreamPort: number) => ({
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
  metadata: { revision: 'c4-r1', environment: 'test' },
  reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
  secretProviders: { env: { type: 'env' } },
  credentials: {
    parent: { type: 'bearer', secretRef: 'env:C4_PARENT_TOKEN' },
    override: { type: 'apiKey', placement: { in: 'header', name: 'X-Override-Key' }, secretRef: 'env:C4_OVERRIDE_TOKEN' },
    missing: { type: 'apiKey', placement: { in: 'header', name: 'X-Missing-Key' }, secretRef: 'env:C4_REMOVED_ROW' },
    scoped: { type: 'bearer', secretRef: 'env:C4_SCOPED_TOKEN', methods: ['POST'] },
  },
  sites: [
    {
      id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' },
      allowedHosts: ['127.0.0.1'], credential: 'parent',
      endpoints: [
        { endpointDefinitionId: endpoints.inherit },
        { endpointDefinitionId: endpoints.override, credential: 'override' },
        { endpointDefinitionId: endpoints.none, credential: 'none' },
        { endpointDefinitionId: endpoints.missing, credential: 'missing' },
        { endpointDefinitionId: endpoints.scoped, credential: 'scoped' },
      ],
    },
    {
      id: 'site-unresolved', sourceServiceAssetId: 'asset-unresolved',
      match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' },
      allowedHosts: ['127.0.0.1'], endpoints: [],
    },
  ],
});

const specDocument = (upstreamPort: number) => ({
  openapi: '3.0.3', info: { title: 'c4-01-fixture', version: '1' },
  servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
  paths: Object.fromEntries(operationNames.map(name => [`/${name}`, {
    get: {
      operationId: name,
      parameters: headerParameters.map(header => ({ in: 'header', name: header, schema: { type: 'string' } })),
      responses: { 200: { description: 'ok' } },
    },
  }])),
});

const bindings = operationNames.map(name => ({
  method: 'GET',
  path: `/${name}`,
  endpointDefinitionId: endpoints[name],
  sourceServiceAssetId: name === 'unresolved' ? 'asset-unresolved' : name === 'elsewhere' ? 'asset-elsewhere' : 'asset',
}));

const consumerHeaders = {
  authorization: 'consumer-auth',
  'proxy-authorization': 'consumer-proxy',
  cookie: 'consumer-cookie',
  'x-api-key': 'consumer-key',
  'x-override-key': 'consumer-override',
  'x-business': 'business-value',
};

const consumerArgs = {
  Authorization: 'consumer-auth',
  'Proxy-Authorization': 'consumer-proxy',
  Cookie: 'consumer-cookie',
  'X-Api-Key': 'consumer-key',
  'X-Override-Key': 'consumer-override',
  'X-Business': 'business-value',
  endpointDefinitionId: 'forged-endpoint',
  sourceServiceAssetId: 'forged-asset',
};

const ambientCustomHeaders = {
  static: { 'X-Override-Key': 'custom-override-must-not-win', 'X-Business': 'business-value' },
  env: { 'X-Legacy-Token': 'C4_LEGACY_AMBIENT' },
};

const credentialProjection = (headers: http.IncomingHttpHeaders) => Object.fromEntries(
  Object.entries(headers).filter(([name]) => ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'x-override-key', 'x-missing-key'].includes(name)),
);

describe('C4-01 joint runtime Resolver execution semantics over real loopback HTTP', () => {
  let upstream: http.Server, upstreamPort: number, connections: number;
  let requests: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders }>;
  let registry: UpstreamCredentialRegistry, values: Record<string, string>, reads: string[];
  let routes: Record<string, any>, currentRoute: any;
  let gatewayServer: http.Server, gatewayPort: number, cacheService: GatewayCacheService;
  let tools: any[];

  const routeFor = (name: string, endpointId: string, assetId: string) => ({
    routeBinding: { id: `route-${name}`, routePath: `/${name}`, routeMethod: 'GET', upstreamPath: `/${name}`, upstreamMethod: 'GET', timeoutMs: 2000 },
    runtimeAsset: { id: 'runtime' }, membership: { id: 'membership', publicationRevision: 1 },
    endpointDefinition: { id: endpointId, sourceServiceAssetId: assetId, method: 'GET', path: `/${name}`, rawOperation: {} },
    sourceServiceAsset: { id: assetId },
    sourceServiceInstance: { id: 'instance', credentialRef: 'env-headers:Authorization=C4_LEGACY_AMBIENT;X-Api-Key=C4_LEGACY_AMBIENT' },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    params: {},
    policies: {
      auth: { mode: 'anonymous' },
      traffic: { timeoutMs: 2000, retryPolicy: { attempts: 1 } },
      cache: { enabled: false, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 4096 },
      upstream: {},
    },
  });

  const buildGateway = (trustedResolver: boolean) => {
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult',
      'recordPolicyObservabilityEvent', 'recordRouteMiss'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt']
      .map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    traffic.admit = jest.fn().mockResolvedValue({ release: jest.fn() });
    const cache = new GatewayCacheService();
    const adapter = trustedResolver
      ? createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot(), { enableHeaderPolicy: true })
      : undefined;
    const proxy = new GatewayProxyEngineService(new GatewayRequestCaptureService(), adapter, metrics);
    const runtime = new GatewayRuntimeService(
      { resolve: () => currentRoute } as any,
      { authorize: jest.fn().mockResolvedValue({ mode: 'anonymous' }) } as any,
      traffic, cache, proxy,
      { recordRequest: jest.fn(), recordUnmatchedRequest: jest.fn() } as any,
      metrics,
    );
    const app = express();
    app.use((req, res) => {
      void runtime.forwardResolvedRoute(currentRoute, req, res).catch(error => {
        if (!res.headersSent) res.status(error.getStatus?.() ?? 500).end(error.message);
        else res.destroy();
      });
    });
    return { runtime, cache, app };
  };

  const buildMcpTools = async (withPolicy: boolean, authConfig?: any, customHeaders?: any) => transformOpenApiToMcpTools(
    undefined, undefined, specDocument(upstreamPort), authConfig, customHeaders, false, undefined, undefined,
    bindings,
    withPolicy ? { mode: 'single-hop' as const, captureSnapshot: () => registry.captureSnapshot() } : undefined,
  );

  const toolFor = (list: any[], operationId: string) => {
    const tool = list.find(item => item.metadata?.operationId === operationId) ?? list.find(item => item.name === operationId);
    if (!tool) throw new Error(`tool missing: ${operationId}`);
    return tool;
  };

  const invokeGateway = (name: string, headers: Record<string, string> = consumerHeaders) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    currentRoute = routes[name];
    const request = http.get({ host: '127.0.0.1', port: gatewayPort, path: `/${name}`, headers, timeout: 3000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('gateway_fixture_timeout')));
  });

  const callTool = async (name: string, list: any[] = tools, args: Record<string, string> = consumerArgs) => {
    const result = await toolFor(list, name).handler(args);
    return JSON.parse(JSON.stringify(result));
  };

  beforeEach(async () => {
    values = {
      C4_PARENT_TOKEN: 'synthetic-parent-secret',
      C4_OVERRIDE_TOKEN: 'synthetic-override-secret',
      C4_REMOVED_ROW: 'synthetic-removed-row-secret',
      C4_SCOPED_TOKEN: 'synthetic-scoped-secret',
    };
    reads = []; connections = 0; requests = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests.push({ path: request.url || '', method: request.method || '', headers: { ...request.headers } });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
      });
    });
    upstream.on('connection', () => { connections += 1; });
    upstreamPort = await listen(upstream);
    registry = new UpstreamCredentialRegistry({
      environment: 'test',
      providerFactory: description => ({
        type: description.type,
        resolve: async (key: string) => {
          reads.push(key);
          if (!(key in values)) throw new Error('synthetic-provider-unavailable');
          return values[key];
        },
      }),
    });
    await registry.reload(registryDocument(upstreamPort));
    reads.length = 0;
    routes = Object.fromEntries(operationNames.map(name => [name,
      routeFor(name, endpoints[name], name === 'unresolved' ? 'asset-unresolved' : name === 'elsewhere' ? 'asset-elsewhere' : 'asset')]));
    const gateway = buildGateway(true);
    cacheService = gateway.cache;
    gatewayServer = http.createServer(gateway.app);
    gatewayPort = await listen(gatewayServer);
    tools = await buildMcpTools(true);
  });

  afterEach(async () => {
    if (gatewayServer) await close(gatewayServer);
    if (upstream) await close(upstream);
  });

  it('applies Site/Endpoint inheritance identically on Gateway and MCP for the same binding', async () => {
    for (const name of ['inherit', 'unlisted']) {
      const before = requests.length;
      const gateway = await invokeGateway(name);
      expect(gateway.status).toBe(200);
      expect(gateway.body).toContain('ok');
      const gatewayRequest = requests[before];
      const mcp = await callTool(name);
      expect(mcp.isError).not.toBe(true);
      const mcpRequest = requests[before + 1];
      expect(gatewayRequest.headers.authorization).toBe('Bearer synthetic-parent-secret');
      expect(credentialProjection(mcpRequest.headers)).toEqual(credentialProjection(gatewayRequest.headers));
      expect(gatewayRequest.headers['x-override-key']).toBeUndefined();
      expect(gatewayRequest.headers['x-business']).toBe('business-value');
      expect(mcpRequest.headers['x-business']).toBe('business-value');
      const wire = JSON.stringify([gatewayRequest, mcpRequest]);
      expect(wire).not.toContain('consumer-');
      expect(wire).not.toContain('synthetic-override-secret');
      expect(wire).not.toContain('synthetic-scoped-secret');
      expect(wire).not.toContain('synthetic-removed-row-secret');
    }
    expect(requests.map(request => request.path)).toEqual(['/inherit', '/inherit', '/unlisted', '/unlisted']);
  });

  it('endpoint override wins over inherited values and the inherited secret never reaches the upstream', async () => {
    const before = requests.length;
    const gateway = await invokeGateway('override');
    expect(gateway.status).toBe(200);
    const mcp = await callTool('override');
    expect(mcp.isError).not.toBe(true);
    const [gatewayRequest, mcpRequest] = requests.slice(before, before + 2);
    expect(gatewayRequest.headers['x-override-key']).toBe('synthetic-override-secret');
    expect(mcpRequest.headers['x-override-key']).toBe('synthetic-override-secret');
    expect(gatewayRequest.headers.authorization).toBeUndefined();
    expect(mcpRequest.headers.authorization).toBeUndefined();
    for (const request of [gatewayRequest, mcpRequest]) {
      const wire = JSON.stringify(request);
      expect(wire).not.toContain('synthetic-parent-secret');
      expect(wire).not.toContain('consumer-');
      expect(wire).not.toContain('synthetic-scoped-secret');
      expect(wire).not.toContain('synthetic-removed-row-secret');
    }
  });

  it('None sends no credential and never falls back to consumer, ambient axios, legacy env or custom-header values', async () => {
    process.env.C4_LEGACY_AMBIENT = 'synthetic-legacy-ambient';
    const previousAuthorization = axios.defaults.headers.common.Authorization;
    axios.defaults.headers.common.Authorization = 'Bearer synthetic-axios-ambient';
    const ambientTools = await buildMcpTools(true, { type: 'bearer', bearer: { token: 'synthetic-legacy-auth', source: 'static' } }, ambientCustomHeaders);
    try {
      const before = requests.length;
      const gateway = await invokeGateway('none');
      expect(gateway.status).toBe(200);
      const mcp = await callTool('none', ambientTools);
      expect(mcp.isError).not.toBe(true);
      const [gatewayRequest, mcpRequest] = requests.slice(before, before + 2);
      for (const request of [gatewayRequest, mcpRequest]) {
        for (const name of ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'x-override-key', 'x-missing-key', 'x-legacy-token']) {
          expect(request.headers[name]).toBeUndefined();
        }
        expect(request.headers['x-business']).toBe('business-value');
        const wire = JSON.stringify(request);
        for (const marker of ['consumer-', 'synthetic-legacy-ambient', 'synthetic-axios-ambient', 'synthetic-legacy-auth',
          'custom-override-must-not-win', 'synthetic-parent-secret', 'synthetic-override-secret']) {
          expect(wire).not.toContain(marker);
        }
      }
      expect(reads).toEqual([]);
    } finally {
      if (previousAuthorization === undefined) delete axios.defaults.headers.common.Authorization;
      else axios.defaults.headers.common.Authorization = previousAuthorization;
      delete process.env.C4_LEGACY_AMBIENT;
    }
  });

  it('denies a removed provider row before network and cache on both runtimes, leaves no partial state and recovers', async () => {
    delete values.C4_REMOVED_ROW;
    currentRoute = routes.missing;
    currentRoute.policies.cache.enabled = true;
    const resolveSpy = jest.spyOn(cacheService, 'resolve');
    const storeSpy = jest.spyOn(cacheService, 'store');
    const before = { connections, requests: requests.length };
    const gateway = await invokeGateway('missing');
    expect(gateway.status).toBe(503);
    expect(gateway.body).toBe('gateway_upstream_credential_unavailable');
    const mcp = await callTool('missing');
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toMatchObject({ text: 'UPSTREAM_CREDENTIAL_UNAVAILABLE', _meta: { code: 'UPSTREAM_CREDENTIAL_UNAVAILABLE' } });
    expect(JSON.stringify(mcp)).not.toMatch(/synthetic-|synthetic-provider-unavailable|stack/);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
    expect((cacheService as any).cache.size).toBe(0);
    expect(connections).toBe(before.connections);
    expect(requests.length).toBe(before.requests);
    expect(reads).toEqual(['C4_REMOVED_ROW', 'C4_REMOVED_ROW']);

    values.C4_REMOVED_ROW = 'synthetic-removed-row-secret';
    reads.length = 0;
    const recoveredGateway = await invokeGateway('missing');
    expect(recoveredGateway.status).toBe(200);
    const recoveredMcp = await callTool('missing');
    expect(recoveredMcp.isError).not.toBe(true);
    const [gatewayRequest, mcpRequest] = requests.slice(before.requests);
    expect(gatewayRequest.headers['x-missing-key']).toBe('synthetic-removed-row-secret');
    expect(mcpRequest.headers['x-missing-key']).toBe('synthetic-removed-row-secret');
    expect(reads).toEqual(['C4_REMOVED_ROW', 'C4_REMOVED_ROW', 'C4_REMOVED_ROW']);
  });

  const denyCases = [
    {
      name: 'unresolved',
      expectedReads: 0,
      setup: () => undefined,
    },
    {
      name: 'scoped',
      expectedReads: 0,
      setup: () => undefined,
    },
    {
      name: 'elsewhere',
      expectedReads: 0,
      setup: () => undefined,
    },
    {
      name: 'missing',
      expectedReads: 2,
      setup: () => { delete values.C4_REMOVED_ROW; },
    },
  ];

  it.each(denyCases)('$name is denied before secret read, network and cache on both runtimes', async scenario => {
    scenario.setup();
    reads.length = 0;
    currentRoute = routes[scenario.name];
    currentRoute.policies.cache.enabled = true;
    const resolveSpy = jest.spyOn(cacheService, 'resolve');
    const before = { connections, requests: requests.length };
    const gateway = await invokeGateway(scenario.name);
    expect(gateway.status).toBe(503);
    expect(gateway.body).toBe('gateway_upstream_credential_unavailable');
    const mcp = await callTool(scenario.name);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toMatchObject({ text: 'UPSTREAM_CREDENTIAL_UNAVAILABLE', _meta: { code: 'UPSTREAM_CREDENTIAL_UNAVAILABLE' } });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(connections).toBe(before.connections);
    expect(requests.length).toBe(before.requests);
    expect(reads.length).toBe(scenario.expectedReads);
  });

  it('rejects an unsupported provider reference at activation without replacing the active snapshot or networking', async () => {
    const unsupported = JSON.parse(JSON.stringify(registryDocument(upstreamPort)));
    unsupported.metadata.revision = 'c4-r2';
    unsupported.credentials.parent.secretRef = 'vault:C4_PARENT_TOKEN';
    const previous = registry.captureSnapshot();
    await expect(registry.reload(unsupported)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(registry.captureSnapshot()).toBe(previous);
    const unsupportedType = JSON.parse(JSON.stringify(registryDocument(upstreamPort)));
    unsupportedType.metadata.revision = 'c4-r3';
    unsupportedType.credentials.extra = { type: 'oauth2', secretRef: 'env:C4_PARENT_TOKEN' };
    await expect(registry.reload(unsupportedType)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(registry.captureSnapshot()).toBe(previous);
    expect(connections).toBe(0);
    expect(requests.length).toBe(0);
    expect((await invokeGateway('inherit')).status).toBe(200);
    expect(requests[0].headers.authorization).toBe('Bearer synthetic-parent-secret');
  });

  it('default-off parity keeps the legacy paths unchanged and the trusted semantics opt-in', async () => {
    process.env.C4_LEGACY_AMBIENT = 'synthetic-legacy-ambient';
    try {
      const legacyGateway = buildGateway(false);
      const legacyServer = http.createServer(legacyGateway.app);
      const legacyPort = await listen(legacyServer);
      try {
        currentRoute = routes.none;
        const status = await new Promise<number>((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: legacyPort, path: '/none' }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode!));
          }).on('error', reject);
        });
        expect(status).toBe(200);
      } finally { await close(legacyServer); }
      expect(requests[0].headers.authorization).toBe('synthetic-legacy-ambient');
      expect(requests[0].headers['x-api-key']).toBe('synthetic-legacy-ambient');

      const before = requests.length;
      const legacyTools = await buildMcpTools(false, { type: 'bearer', bearer: { token: 'synthetic-legacy-mcp-auth', source: 'static' } });
      const mcp = await callTool('none', legacyTools);
      expect(mcp.isError).not.toBe(true);
      expect(requests[before].headers.authorization).toBe('Bearer synthetic-legacy-mcp-auth');
      expect(requests[before].headers['x-override-key']).toBe('consumer-override');
      expect(requests[before].headers['x-missing-key']).toBeUndefined();
    } finally {
      delete process.env.C4_LEGACY_AMBIENT;
    }
  });
});
