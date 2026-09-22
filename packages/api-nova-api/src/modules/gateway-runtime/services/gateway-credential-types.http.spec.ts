import * as http from 'node:http';
import * as net from 'node:net';
import express = require('express');
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { transformOpenApiToMcpTools } from '../../../../../api-nova-server/src/transform/transformOpenApiToMcpTools';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const descriptions: Record<string, any> = {
  api: { type: 'apiKey', placement: { in: 'header', name: 'X-Upstream-Key' }, secretRef: 'env:TOKEN' },
  bearer: { type: 'bearer', secretRef: 'env:TOKEN' },
  basic: { type: 'basic', usernameRef: 'env:USERNAME', passwordRef: 'env:PASSWORD' },
  custom: { type: 'customHeader', name: 'X-Custom-Auth', secretRef: 'env:TOKEN' },
};
const consumerHeaders = { authorization: 'consumer-auth', 'x-api-key': 'consumer-key', cookie: 'consumer-session', 'x-upstream-key': 'consumer-old', 'x-custom-auth': 'consumer-custom' };

describe('C1 credential types through real Gateway and explicit MCP single-hop HTTP', () => {
  let upstream: http.Server, gateway: http.Server, gatewayPort: number, upstreamPort: number;
  let registry: UpstreamCredentialRegistry, candidate: any, values: Record<string, string>, selected: string;
  let hits: number, headerChecks: boolean[], failures: string[], expectedMethod: string;
  let adapter: ReturnType<typeof createGatewayUpstreamCredentialResolver>;
  const checkHeaders = (headers: http.IncomingHttpHeaders) => {
    const expected = selected === 'none' ? undefined : selected === 'api' ? values.TOKEN : selected === 'custom' ? values.TOKEN : selected === 'bearer' ? `Bearer ${values.TOKEN}` : `Basic ${Buffer.from(`${values.USERNAME}:${values.PASSWORD}`, 'utf8').toString('base64')}`;
    const field = selected === 'api' ? 'x-upstream-key' : selected === 'custom' ? 'x-custom-auth' : 'authorization';
    return headers[field] === expected && !JSON.stringify(headers).includes('consumer-') &&
      (field === 'authorization' || headers.authorization === undefined) &&
      (field === 'x-upstream-key' || headers['x-upstream-key'] === undefined) &&
      (field === 'x-custom-auth' || headers['x-custom-auth'] === undefined);
  };
  beforeEach(async () => {
    hits = 0; headerChecks = []; failures = []; selected = 'api'; expectedMethod = 'GET';
    values = { TOKEN: 'synthetic-upstream-token', USERNAME: 'synthetic-用户', PASSWORD: 'synthetic-password' };
    upstream = http.createServer((req, res) => { hits++; headerChecks.push(checkHeaders(req.headers) && req.method === expectedMethod); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    upstreamPort = await listen(upstream);
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: JSON.parse(JSON.stringify(descriptions)),
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'api', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'api' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async key => { if (!(key in values)) throw Error('synthetic-provider-secret'); return values[key]; } }) });
    await registry.reload(candidate);
    adapter = createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot());
    const route: any = { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, runtimeAsset: { id: 'runtime' }, membership: { id: 'membership' }, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'asset' }, sourceServiceInstance: { id: 'instance' },
      routeBinding: { id: 'route', upstreamPath: '/target', upstreamMethod: 'GET' }, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: {} } };
    const proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any, adapter);
    const app = express(); app.use((req, res) => { void proxy.forward(route, req, res).catch(error => { failures.push(error.message); if (!res.headersSent) res.status(error.getStatus?.() ?? 500).end(error.message); else res.destroy(); }); });
    gateway = http.createServer(app); gatewayPort = await listen(gateway);
  });
  afterEach(async () => { if (gateway) await close(gateway); if (upstream) await close(upstream); });
  async function activate(type: string, constraints: Record<string, unknown> = {}) {
    selected = type; candidate.metadata.revision = `r${Number(candidate.metadata.revision.slice(1)) + 1}`;
    if (type !== 'none') candidate.credentials[type] = { ...descriptions[type], ...constraints };
    candidate.sites[0].endpoints[0].credential = type; await registry.reload(candidate);
  }
  async function invoke(transport: string): Promise<boolean> {
    if (transport === 'gateway') return new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port: gatewayPort, path: '/public', headers: consumerHeaders, timeout: 3000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('fixture_timeout'))); });
    const spec = { openapi: '3.0.3', info: { title: 'isolated fixture', version: '1' }, servers: [{ url: `http://127.0.0.1:${upstreamPort}` }], paths: { '/target': { get: { operationId: 'target', parameters: Object.keys(consumerHeaders).map(name => ({ name, in: 'header', schema: { type: 'string' } })), responses: { '200': { description: 'ok' } } } } } };
    const tools = await transformOpenApiToMcpTools(undefined, undefined, spec, undefined, undefined, false, undefined, undefined,
      [{ method: 'GET', path: '/target', endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' }], { mode: 'single-hop', captureSnapshot: () => registry.captureSnapshot() });
    const result = await tools[0].handler({ ...consumerHeaders, requestMethod: 'POST', endpointDefinitionId: 'forged' });
    if (result.isError) failures.push(JSON.stringify(result));
    return !result.isError;
  }
  describe.each(['gateway', 'mcp'])('%s', transport => {
    it.each(['api', 'bearer', 'basic', 'custom'])('injects %s using trusted method and strips every consumer credential', async type => {
      await activate(type, { methods: ['GET'], endpointDefinitionIds: ['endpoint'], allowedHosts: ['127.0.0.1'], environment: 'test' });
      expect(await invoke(transport)).toBe(true); expect(hits).toBe(1); expect(headerChecks).toEqual([true]);
    });
    it.each([{ enabled: false }, { expiresAt: '2020-01-01T00:00:00Z' }, { notBefore: '2099-01-01T00:00:00Z' }, { methods: ['POST'] }, { endpointDefinitionIds: ['other'] }, { allowedHosts: ['other.example'] }])('rejects inactive or out of scope credential without networking (%j)', async constraints => {
      await activate('basic', constraints); expect(await invoke(transport)).toBe(false); expect(hits).toBe(0);
      expect(failures.join(' ')).not.toMatch(/synthetic-|Basic |USERNAME|PASSWORD/);
    });
    it('rereads both Provider refs and rejects either failure without partial output', async () => {
      await activate('basic'); expect(await invoke(transport)).toBe(true);
      values.USERNAME = 'changed-user'; values.PASSWORD = 'changed-password'; expect(await invoke(transport)).toBe(true);
      delete values.PASSWORD; expect(await invoke(transport)).toBe(false);
      values.PASSWORD = 'changed-password'; delete values.USERNAME; expect(await invoke(transport)).toBe(false);
      expect(hits).toBe(2); expect(headerChecks).toEqual([true, true]);
      expect(failures.join(' ')).not.toMatch(/synthetic-|changed-|Basic /);
    });
    it('retains previous snapshot on bad candidate, accepts disabled revision and rejects next call', async () => {
      await activate('custom'); const previous = registry.captureSnapshot(); candidate.metadata.revision = 'invalid'; candidate.credentials.custom.name = 'cookie';
      await expect(registry.reload(candidate)).rejects.toBeDefined(); expect(registry.captureSnapshot() === previous).toBe(true); expect(await invoke(transport)).toBe(true);
      candidate.metadata.revision = 'r90'; await activate('custom', { enabled: false }); expect(await invoke(transport)).toBe(false); expect(hits).toBe(1); expect(headerChecks).toEqual([true]);
    });
    it('removes deleted custom authentication names after switching to None', async () => {
      await activate('custom'); expect(await invoke(transport)).toBe(true);
      candidate.metadata.revision = 'removed'; candidate.credentials = {}; candidate.sites[0].credential = 'none'; candidate.sites[0].endpoints[0].credential = 'none'; selected = 'none';
      await registry.reload(candidate); expect(await invoke(transport)).toBe(true); expect(headerChecks).toEqual([true, true]);
    });
  });
  it('fails missing trusted method and isolates safe cache identity after activation', async () => {
    await activate('api', { methods: ['GET'] }); const route: any = { sourceServiceAsset: { id: 'asset' }, endpointDefinition: { id: 'endpoint' } };
    await expect(adapter.resolve(route, `http://127.0.0.1:${upstreamPort}/target`)).rejects.toBeDefined();
    const first = await adapter.resolve(route, `http://127.0.0.1:${upstreamPort}/target`, 'GET'); await activate('api', { methods: ['GET'] });
    const second = await adapter.resolve(route, `http://127.0.0.1:${upstreamPort}/target`, 'GET'); expect(first.cacheIdentity !== second.cacheIdentity).toBe(true); expect(second.cacheIdentity).not.toMatch(/synthetic-|TOKEN/); expect(hits).toBe(0);
  });
});
