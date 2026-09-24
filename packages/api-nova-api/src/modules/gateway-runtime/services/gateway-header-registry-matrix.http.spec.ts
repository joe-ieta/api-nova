import * as http from 'node:http';
import express = require('express');
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
function request(port: number, endpoint: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/' + endpoint, headers }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers })); });
    req.on('error', reject);
  });
}
describe('H04/H05/H06/H07 Registry and real HTTP matrix (explicit test opt-in only)', () => {
  let upstream: http.Server, gateway: http.Server, port: number, store: UpstreamCredentialRegistry, candidate: any, seen: http.IncomingHttpHeaders[], enabled: boolean;
  beforeEach(async () => {
    seen = []; enabled = true;
    upstream = http.createServer((req, res) => { seen.push(req.headers); res.setHeader('x-site-result', 'site'); res.setHeader('x-endpoint-result', 'endpoint'); res.setHeader('x-unknown', 'strip'); res.end('ok'); });
    const upstreamPort = await listen(upstream);
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: {
      key: { type: 'apiKey', placement: { in: 'header', name: 'x-old-key' }, secretRef: 'env:KEY' },
      other: { type: 'apiKey', placement: { in: 'header', name: 'x-other-key' }, secretRef: 'env:OTHER' },
    }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', headerPolicy: { version: 1, requestHeaders: ['x-site'], responseHeaders: ['x-site-result'] }, endpoints: [
      { endpointDefinitionId: 'inherit' },
      { endpointDefinitionId: 'empty', headerPolicy: { version: 1, requestHeaders: [], responseHeaders: [] } },
      { endpointDefinitionId: 'replace', headerPolicy: { version: 1, requestHeaders: ['x-endpoint'], responseHeaders: ['x-endpoint-result'] } },
      { endpointDefinitionId: 'none', credential: 'none' },
    ] }] };
    store = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic-managed' }) });
    await store.reload(candidate);
    const adapter = createGatewayUpstreamCredentialResolver(() => store.captureSnapshot(), { enableHeaderPolicy: true });
    const closed = createGatewayUpstreamCredentialResolver(() => store.captureSnapshot());
    const proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any, { headerPolicyEnabled: true, resolve: (...args) => (enabled ? adapter : closed).resolve(...args) });
    const app = express();
    app.use((req, res) => {
      const route: any = { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, runtimeAsset: { id: 'runtime' }, membership: { id: 'member' }, endpointDefinition: { id: req.path.slice(1) }, sourceServiceAsset: { id: 'asset' }, sourceServiceInstance: { id: 'instance' }, routeBinding: { id: 'route', upstreamPath: req.path, upstreamMethod: 'GET' }, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: {} } };
      void proxy.forward(route, req, res).catch(error => { if (!res.headersSent) res.status(error.getStatus?.() ?? 500).end(error.message); else res.destroy(); });
    });
    gateway = http.createServer(app); port = await listen(gateway);
  });
  afterEach(async () => { await close(gateway); await close(upstream); });
  it.each(['inherit', 'empty', 'replace'])('H04 %s selects the matching Endpoint in both wire directions', async endpoint => {
    const result = await request(port, endpoint, { 'x-site': 'site', 'x-endpoint': 'endpoint', 'x-unknown': 'strip' });
    expect(result.status).toBe(200); expect(seen).toHaveLength(1);
    expect(seen[0]['x-site']).toBe(endpoint === 'inherit' ? 'site' : undefined);
    expect(seen[0]['x-endpoint']).toBe(endpoint === 'replace' ? 'endpoint' : undefined);
    expect(seen[0]['x-unknown']).toBeUndefined(); expect(seen[0]['x-old-key']).toBe('synthetic-managed');
    expect(result.headers['x-site-result']).toBe(endpoint === 'inherit' ? 'site' : undefined);
    expect(result.headers['x-endpoint-result']).toBe(endpoint === 'replace' ? 'endpoint' : undefined);
    expect(result.headers['x-unknown']).toBeUndefined();
  });
  it.each(['x-old-key', 'connection', '*'])('H05 rejects invalid reload %s and retains the prior actual wire policy', async name => {
    const generation = store.captureSnapshot().generation;
    const invalid = JSON.parse(JSON.stringify(candidate)); invalid.metadata.revision = 'invalid'; invalid.sites[0].headerPolicy.requestHeaders = [name];
    await expect(store.reload(invalid)).rejects.toThrow(); expect(store.captureSnapshot().generation).toBe(generation);
    expect((await request(port, 'inherit', { 'x-site': 'retained' })).status).toBe(200); expect(seen[0]['x-site']).toBe('retained');
  });
  it('H06 None strips every current candidate authentication name without injection', async () => {
    expect((await request(port, 'none', { 'x-old-key': 'consumer', 'x-other-key': 'consumer', authorization: 'consumer' })).status).toBe(200);
    for (const key of ['x-old-key', 'x-other-key', 'authorization']) expect(seen[0][key]).toBeUndefined();
  });
  it('H07 rotation retains old names only in this Registry lifetime; cold state is not claimed durable', async () => {
    const rotated = JSON.parse(JSON.stringify(candidate)); rotated.metadata.revision = 'rotated'; rotated.credentials.key.placement.name = 'x-new-key';
    await store.reload(rotated);
    const invalid = JSON.parse(JSON.stringify(rotated)); invalid.metadata.revision = 'unsafe-old-extension'; invalid.sites[0].headerPolicy.requestHeaders = ['x-old-key'];
    await expect(store.reload(invalid)).rejects.toThrow();
    expect((await request(port, 'inherit', { 'x-old-key': 'old-consumer', 'x-new-key': 'forged' })).status).toBe(200);
    expect(seen[0]['x-old-key']).toBeUndefined(); expect(seen[0]['x-new-key']).toBe('synthetic-managed');
    expect(store.captureSnapshot().historicalAuthenticationHeaderNames).toContain('x-old-key');
    const fresh = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic-managed' }) });
    await fresh.reload(rotated);
    // Explicitly documents the remaining durable-history gap; this is not H07 completion.
    expect(fresh.captureSnapshot().historicalAuthenticationHeaderNames).not.toContain('x-old-key');
  });
  it('default adapter gate remains closed and makes zero upstream connections', async () => {
    enabled = false; expect((await request(port, 'inherit')).status).toBe(503); expect(seen).toHaveLength(0);
  });
});
