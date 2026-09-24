import { gzipSync } from 'node:zlib';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import * as http from 'node:http';
import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { UpstreamCredentialRegistry, createNetworkPolicyCompiler } from 'api-nova-parser';
import { GatewayRuntimeController } from '../gateway-runtime.controller';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
import { createGatewayTrustedNetworkProvider, GatewayTrustedNetworkProvider } from './gateway-trusted-network.provider';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
describe.each(['http', 'https'])('explicit host Gateway network stream through real Nest runtime %s', scheme => {
  let ca: string, key: string, directory: string;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-network-tls-'));
    const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:fixture.test', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { windowsHide: true, stdio: 'ignore' });
    key = fs.readFileSync(path.join(directory, 'key.pem'), 'utf8'); ca = fs.readFileSync(path.join(directory, 'cert.pem'), 'utf8');
  }, 30000);
  afterAll(() => { if (directory && path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true }); });
  let app: INestApplication, upstream: http.Server, udp: dgram.Socket, port: number, upstreamPort: number, dnsPort: number;
  let route: any, activeBinding: any, candidate: any, registry: UpstreamCredentialRegistry, network: GatewayTrustedNetworkProvider, proxy: GatewayProxyEngineService;
  let cache: GatewayCacheService, hits: number, connections: number, dnsQueries: number, dnsAddress: string, dnsFailure: boolean, dnsSilent: boolean, captureFailure: boolean, dnsGate: (() => void) | undefined;
  let seen: http.IncomingHttpHeaders[], handler: http.RequestListener, provider: jest.Mock;
  beforeEach(async () => {
    hits = connections = dnsQueries = 0; dnsAddress = '127.0.0.1'; dnsFailure = dnsSilent = captureFailure = false; dnsGate = undefined; seen = [];
    handler = (req, res) => { req.resume(); req.on('end', () => { res.setHeader('x-safe', 'yes'); res.setHeader('x-drop', 'secret'); res.end('ok'); }); };
    const serve: http.RequestListener = (req, res) => { hits++; seen.push(req.headers); handler(req, res); }; upstream = scheme === 'https' ? https.createServer({ key, cert: ca }, serve) : http.createServer(serve); upstream.on('connection', () => connections++); upstreamPort = await listen(upstream);
    udp = dgram.createSocket('udp4'); udp.on('message', (query, peer) => {
      dnsQueries++; if (dnsSilent) return; dnsGate?.(); let at = 12; while (query[at]) at += query[at] + 1; at++; const type = query.readUInt16BE(at), end = at + 4;
      const header = Buffer.alloc(12); query.copy(header, 0, 0, 2); header.writeUInt16BE(dnsFailure ? 0x8182 : 0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(type === 1 ? 1 : 0, 6);
      const answer = Buffer.alloc(16); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(1, 2); answer.writeUInt16BE(1, 4); answer.writeUInt16BE(4, 10); Buffer.from(dnsAddress.split('.').map(Number)).copy(answer, 12);
      udp.send(Buffer.concat([header, query.subarray(12, end), ...(type === 1 ? [answer] : [])]), peer.port, peer.address);
    }); await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve)); dnsPort = udp.address().port;
    route = { runtimeAsset: { id: 'runtime' }, membership: { id: 'member' }, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'asset' }, sourceServiceInstance: { id: 'instance' }, params: {}, upstreamBaseUrl: `${scheme}://fixture.test:${upstreamPort}`,
      routeBinding: { id: 'binding', routePath: '/wire', routeMethod: 'GET', upstreamPath: '/upstream', upstreamMethod: 'GET', routeVisibility: 'external' },
      policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 5000, retryPolicy: { attempts: 3 } }, cache: { enabled: true, methods: ['GET'], ttlMs: 60000, maxBodyBytes: 8192, varyHeaderKeys: [], varyQueryKeys: [] }, upstream: {} } };
    activeBinding = route.routeBinding;
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
      secretProviders: { memory: { type: 'env' } }, credentials: { api: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'memory:KEY' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme, host: 'fixture.test', port: upstreamPort, basePath: '/' }, allowedHosts: ['fixture.test'], credential: 'api', headerPolicy: { version: 1, requestHeaders: ['x-safe'], responseHeaders: ['x-safe', 'content-type'] }, endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    provider = jest.fn(async () => 'synthetic'); registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: provider }) }); await registry.reload(candidate); provider.mockClear();
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' }), origin = route.upstreamBaseUrl;
    const policy = compiler.compile({ version: 1, id: 'p', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, mode: 'private-exception', connection: 'direct', privateException: { id: 'e', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, addresses: ['127.0.0.1'], purpose: 'test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } });
    network = createGatewayTrustedNetworkProvider({ compiler, ca, servers: [`127.0.0.1:${dnsPort}`], registrations: [{ route, snapshot: registry.captureSnapshot(), siteId: 'site', policy, captureSnapshot: () => { if (captureFailure) throw new Error('private host detail'); return registry.captureSnapshot(); }, captureRouteBinding: () => activeBinding }] });
    const resolver = createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot(), { enableHeaderPolicy: true });
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(name => [name, jest.fn().mockResolvedValue(undefined)]));
    const traffic: any = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure', 'recordRetryAttempt'].map(name => [name, jest.fn().mockResolvedValue(undefined)])); traffic.admit = async () => ({ release() {} });
    cache = new GatewayCacheService(); jest.spyOn(cache, 'resolve'); jest.spyOn(cache, 'store');
    proxy = new GatewayProxyEngineService(new GatewayRequestCaptureService(), resolver, metrics, undefined, network);
    const runtime = new GatewayRuntimeService({ resolve: () => route } as any, { authorize: async () => ({ mode: 'anonymous' }) } as any, traffic, cache, proxy, { recordRequest: async () => undefined } as any, metrics);
    const module = await Test.createTestingModule({ controllers: [GatewayRuntimeController], providers: [{ provide: GatewayRuntimeService, useValue: runtime }] }).compile(); app = module.createNestApplication({ bodyParser: false }); await app.listen(0, '127.0.0.1'); port = app.getHttpServer().address().port;
  });
  afterEach(async () => { jest.restoreAllMocks(); app.getHttpServer().closeAllConnections(); await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await new Promise<void>(resolve => udp.close(resolve)); });
  async function request(headers: http.OutgoingHttpHeaders = {}, body?: Buffer) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: '/v1/gateway/wire', method: 'GET', headers }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })); }); req.on('error', reject); req.end(body); });
  }
  it('uses trusted Registry/DNS transport, D1 filtering and no cache lookup/store', async () => {
    for (let i = 0; i < 2; i++) { const result = await request({ 'x-safe': 'yes', 'x-drop': 'blocked', 'x-private': 'consumer' }); expect(result.status).toBe(200); expect(result.body.toString()).toBe('ok'); expect(result.headers['x-safe']).toBe('yes'); expect(result.headers['x-drop']).toBeUndefined(); }
    expect(hits).toBe(2); expect(dnsQueries).toBe(4); expect(seen[0]['x-private']).toBe('synthetic'); expect(seen[0]['x-drop']).toBeUndefined(); expect(cache.resolve).not.toHaveBeenCalled(); expect(cache.store).not.toHaveBeenCalled();
  });
  it.each(['revoke', 'reload', 'clone', 'mutation', 'id-mutation', 'id-clone', 'protected'])('rejects %s before any further connection or cached hit', async mode => {
    expect((await request()).status).toBe(200); const oldHits = hits;
    if (mode === 'revoke') network.revoke('binding');
    if (mode === 'reload') await registry.reload({ ...candidate, metadata: { revision: 'r2', environment: 'test' } });
    if (mode === 'clone') { activeBinding = { ...route.routeBinding }; route = { ...route, routeBinding: activeBinding }; }
    if (mode === 'id-mutation') route.routeBinding.id = 'changed';
    if (mode === 'id-clone') { activeBinding = { ...route.routeBinding, id: 'changed' }; route = { ...route, routeBinding: activeBinding }; }
    if (mode === 'mutation') route.routeBinding.upstreamPath = '/changed';
    if (mode === 'protected') route.endpointDefinition.rawOperation = { security: [{ Missing: [] }] };
    expect((await request()).status).toBe(mode === 'protected' ? 503 : 502); expect(hits).toBe(oldHits); expect(cache.resolve).not.toHaveBeenCalled();
  });
  it('revocation during DNS prevents socket handoff and all upstream bytes', async () => { dnsGate = () => network.revoke('binding'); expect((await request()).status).toBe(502); expect(connections).toBe(0); });
  it('rejects forbidden DNS answer and never retries', async () => { dnsAddress = '127.0.0.2'; expect((await request()).status).toBe(502); expect(dnsQueries).toBe(2); expect(connections).toBe(0); });
  it.each(['fixed', 'chunked'])('streams >8MiB upload/download with %s D1 framing', async mode => {
    const body = Buffer.alloc(9 * 1024 * 1024, 65); let uploaded = 0;
    handler = (req, res) => { expect(req.headers['content-length']).toBe(mode === 'fixed' ? String(body.length) : undefined); expect(req.headers['transfer-encoding']).toBe(mode === 'chunked' ? 'chunked' : undefined); req.on('data', chunk => uploaded += chunk.length); req.on('end', () => { res.setHeader('content-length', String(body.length)); res.end(body); }); };
    const result = await request(mode === 'fixed' ? { 'content-length': body.length } : { 'transfer-encoding': 'chunked' }, body); expect(result.status).toBe(200); expect(result.body.equals(body)).toBe(true); expect(uploaded).toBe(body.length);
  });
  it('D1 declared Trailer rejects before DNS', async () => { expect((await request({ trailer: 'x-late', 'transfer-encoding': 'chunked' })).status).toBe(400); expect(dnsQueries).toBe(0); expect(connections).toBe(0); });
  it('mismatched real peer receives zero HTTP bytes', async () => {
    let trapRequests = 0, trapBytes = 0, trapConnections = 0;
    const onRequest: http.RequestListener = (_req, res) => { trapRequests++; res.end('trap'); };
    const trap = scheme === 'https' ? https.createServer({ key, cert: ca }, onRequest) : http.createServer(onRequest);
    const sockets = new Set<net.Socket>(); trap.on('connection', socket => { trapConnections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (scheme === 'http') socket.on('data', chunk => trapBytes += chunk.length); });
    if (scheme === 'https') (trap as https.Server).on('secureConnection', socket => socket.on('data', chunk => trapBytes += chunk.length));
    const trapPort = await listen(trap), originalNet = net.createConnection, originalTls = tls.connect;
    try {
      if (scheme === 'https') jest.spyOn(require('node:tls'), 'connect').mockImplementation((options: any) => originalTls({ ...options, port: trapPort }));
      else jest.spyOn(require('node:net'), 'createConnection').mockImplementation((options: any) => originalNet(Number(options.port) === upstreamPort ? { ...options, port: trapPort } : options));
      expect((await request()).status).toBe(502); expect(hits).toBe(0); expect(trapConnections).toBe(1); expect(trapRequests).toBe(0); expect(trapBytes).toBe(0);
    } finally { jest.restoreAllMocks(); sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => trap.close(() => resolve())); }
  });
  it('client disconnect cancels an active upstream response', async () => {
    let upstreamClosed!: () => void; const closed = new Promise<void>(resolve => upstreamClosed = resolve);
    handler = (req, res) => { req.resume(); req.on('end', () => { res.once('close', upstreamClosed); res.write('partial'); }); };
    await new Promise<void>((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port, path: '/v1/gateway/wire' }, res => { res.once('data', () => { res.destroy(); resolve(); }); }); req.on('error', reject); });
    await closed; expect(hits).toBe(1); expect(cache.store).not.toHaveBeenCalled();
  });

  it('old prepared request and copied Resolver fields cannot authorize after revoke', async () => {
    const req = new http.IncomingMessage(new net.Socket()) as any; req.originalUrl = '/wire'; req.headers = { host: 'consumer.test' }; req.rawHeaders = ['Host', 'consumer.test'];
    const prepared = await proxy.prepareRequest(route, req);
    expect(() => network.authorize(route, prepared.url.href, { ...prepared.credentials })).toThrow();
    await expect(network.send({ strict: true }, { deadline: Date.now() + 5000, framing: { mode: 'none' } })).rejects.toThrow();
    network.revoke('binding');
    await expect(proxy.forward(route, req, {} as any, { preparedRequest: prepared })).rejects.toThrow();
    expect(dnsQueries).toBe(0); expect(connections).toBe(0); req.destroy();
  });
  it('single-use lease cannot retarget or replay', async () => {
    const req = new http.IncomingMessage(new net.Socket()) as any; req.originalUrl = '/wire'; req.headers = { host: 'consumer.test' }; req.rawHeaders = ['Host', 'consumer.test'];
    const prepared = await proxy.prepareRequest(route, req);
    const response = await network.send(prepared.networkLease!, { deadline: Date.now() + 5000, framing: { mode: 'none' } }); response.body.resume(); await response.completed;
    await expect(network.send(prepared.networkLease!, { deadline: Date.now() + 5000, framing: { mode: 'none' } })).rejects.toThrow(); expect(hits).toBe(1); req.destroy();
  });

  it('preserves compressed bytes and discards upstream authentication trailers', async () => {
    const zipped = gzipSync(Buffer.from('compressed representation'.repeat(200)));
    handler = (req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-encoding', 'gzip'); res.setHeader('trailer', 'X-Private'); res.write(zipped); res.addTrailers({ 'X-Private': 'never-forward' }); res.end(); }); };
    const result = await request({ 'accept-encoding': 'gzip' }); expect(result.status).toBe(200); expect(result.body.equals(zipped)).toBe(true); expect(result.headers['content-encoding']).toBe('gzip'); expect(result.headers.trailer).toBeUndefined(); expect(result.headers['x-private']).toBeUndefined();
  });

  it.each([100, 103])('rejects informational %s before any response body reaches consumer', async status => {
    handler = (req, res) => { req.resume(); req.on('end', () => { if (status === 100) res.writeContinue(); else res.writeEarlyHints({ link: '</must-not-forward>; rel=preload' }); res.end('must-not-forward'); }); };
    const result = await request(); expect(result.status).toBe(502); expect(result.body.toString()).not.toContain('must-not-forward'); expect(result.headers.link).toBeUndefined(); expect(hits).toBe(1);
  });

  it.each(['unavailable', 'timeout'])('retains %s status distinct from policy denial', async mode => {
    dnsFailure = mode === 'unavailable'; dnsSilent = mode === 'timeout'; if (dnsSilent) route.policies.traffic.timeoutMs = 100;
    const result = await request(); expect(result.status).toBe(mode === 'unavailable' ? 503 : 504); expect(result.body.toString()).not.toContain('fixture.test'); expect(connections).toBe(0);
  });

  it('host capture failure after DNS remains unavailable rather than denial', async () => {
    dnsGate = () => { captureFailure = true; };
    const result = await request(); expect(result.status).toBe(503); expect(result.body.toString()).toContain('upstream_network_policy_unavailable'); expect(result.body.toString()).not.toContain('private host detail'); expect(connections).toBe(0); expect(hits).toBe(0); expect(cache.resolve).not.toHaveBeenCalled(); expect(cache.store).not.toHaveBeenCalled();
  });

});
