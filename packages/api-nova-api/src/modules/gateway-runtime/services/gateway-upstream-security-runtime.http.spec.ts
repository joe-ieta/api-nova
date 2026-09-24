import * as http from 'node:http';
import * as net from 'node:net';
import express = require('express');
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { GatewayUpstreamSecurityRuntimeGuard } from './gateway-upstream-security-runtime.guard';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('Gateway current declaration and prepared-request enforcement over real HTTP', () => {
  let db: DataSource, upstream: http.Server, gateway: http.Server, port: number;
  let proxy: GatewayProxyEngineService, route: any, registry: UpstreamCredentialRegistry, candidate: any;
  let values: Record<string, string>, resolver: jest.Mock, hits: number;
  let beforeWire: (req: any, prepared: any) => Promise<void>;
  let replayError: string | undefined, replay: boolean;
  beforeEach(async () => {
    hits = 0; replay = false; replayError = undefined; beforeWire = async () => undefined;
    db = new DataSource({ type: 'sqljs', entities: [EndpointDefinitionEntity], synchronize: true }); await db.initialize();
    const endpoint = await db.getRepository(EndpointDefinitionEntity).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/target', rawOperation: {} });
    upstream = http.createServer((_req, res) => { hits++; res.end('ok'); });
    const upstreamPort = await listen(upstream); values = { TOKEN: 'synthetic-only' };
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { api: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'api', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'api' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: definition => ({ type: definition.type, resolve: async key => { if (!(key in values)) throw Error('unavailable'); return values[key]; } }) });
    await registry.reload(candidate);
    const adapter = createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot()); resolver = jest.fn(adapter.resolve.bind(adapter));
    route = { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, runtimeAsset: { id: 'runtime' }, membership: { id: 'membership', publicationRevision: 1 }, endpointDefinition: endpoint, sourceServiceAsset: { id: 'asset' }, sourceServiceInstance: { id: 'instance' }, routeBinding: { id: 'route', upstreamPath: '/target', upstreamMethod: 'GET' }, policies: { upstream: {}, traffic: { timeoutMs: 2000 } } };
    proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any, { resolve: resolver }, undefined, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(EndpointDefinitionEntity)));
    const app = express(); app.use((req, res) => { void (async () => {
      const prepared = await proxy.prepareRequest(route, req);
      await beforeWire(req, prepared);
      await proxy.forward(route, req, res, { preparedRequest: prepared });
      if (replay) try { await proxy.forward(route, req, res, { preparedRequest: prepared }); } catch (error) { replayError = error.message; }
    })().catch(error => { if (!res.headersSent) res.status(error.getStatus?.() ?? 500).end(error.message); else res.destroy(); }); });
    gateway = http.createServer(app); port = await listen(gateway);
  });
  afterEach(async () => { await close(gateway); await close(upstream); await db.destroy(); });
  const invoke = () => new Promise<number>((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/public' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); }).on('error', reject); });
  it('preserves undeclared legacy while checking current declaration before cache preparation', async () => {
    expect(proxy.requiresPreparation(route)).toBe(true); expect(await invoke()).toBe(200); expect(hits).toBe(1); expect(resolver).toHaveBeenCalledTimes(2);
  });
  it('rejects a stale snapshot after the persisted endpoint acquires protection without resolving or networking', async () => {
    await db.getRepository(EndpointDefinitionEntity).update('endpoint', { rawOperation: { security: [{ Unknown: [] }] } });
    expect(route.endpointDefinition.rawOperation).toEqual({}); expect(await invoke()).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(hits).toBe(0);
  });
  it('rejects a protected snapshot even if storage becomes undeclared', async () => {
    route.endpointDefinition.rawOperation = { security: [{ Unknown: [] }] };
    expect(await invoke()).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(hits).toBe(0);
  });
  it('rejects a disappeared endpoint before resolving or networking', async () => {
    await db.getRepository(EndpointDefinitionEntity).delete('endpoint'); expect(await invoke()).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(hits).toBe(0);
  });
  it('rechecks declaration between prepare and wire before a second resolver invocation', async () => {
    beforeWire = async () => { await db.getRepository(EndpointDefinitionEntity).update('endpoint', { rawOperation: { security: [{ Unknown: [] }] } }); };
    expect(await invoke()).toBe(503); expect(resolver).toHaveBeenCalledTimes(1); expect(hits).toBe(0);
  });
  it.each(['rotation', 'missing', 'disabled', 'generation'])('rejects current Registry %s after preparation without an upstream request', async change => {
    beforeWire = async () => {
      if (change === 'rotation') values.TOKEN = 'rotated-synthetic';
      if (change === 'missing') delete values.TOKEN;
      if (change === 'disabled') { candidate.metadata.revision = 'r2'; candidate.credentials.api.enabled = false; await registry.reload(candidate); }
      if (change === 'generation') { candidate.metadata.revision = 'r2'; await registry.reload(candidate); }
    };
    expect(await invoke()).toBe(503); expect(resolver).toHaveBeenCalledTimes(2); expect(hits).toBe(0);
  });
  it.each(['request', 'route', 'resolver'])('rejects prepared %s identity substitution before re-resolution', async change => {
    beforeWire = async (req, prepared) => {
      if (change === 'request') await proxy.forward(route, { ...req } as any, {} as any, { preparedRequest: prepared });
      if (change === 'route') route.membership.publicationRevision = 2;
      if (change === 'resolver') (proxy as any).upstreamCredentialResolver = { resolve: resolver };
    };
    expect(await invoke()).toBe(503); expect(resolver).toHaveBeenCalledTimes(1); expect(hits).toBe(0);
  });
  it('never reuses a consumed preparation', async () => {
    replay = true; expect(await invoke()).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(replayError).toBe('gateway_prepared_request_reused'); expect(hits).toBe(1); expect(resolver).toHaveBeenCalledTimes(2);
  });
});
