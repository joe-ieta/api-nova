import { getEventListeners } from 'node:events';
import { UpstreamCredentialRegistry } from '../credentials/registry';
import { createTrustedSingleHopNetworkExecution } from './trusted-single-hop-network-execution';
import { serializeBoundedNetworkRequest, decodeBoundedNetworkResponse } from './bounded-network-serialization';
import { transformToMCPTools } from '../transformer';
import { withRuntimeCallContext } from '../audit/runtime-call-audit';
import axios from 'axios';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createPinnedHttpTransport, PINNED_HTTP_MAX_REQUEST_BYTES, PINNED_HTTP_MAX_RESPONSE_BYTES } from './pinned-http-transport';
import { createNetworkPolicyCompiler } from './network-policy';

describe('logical operation Parser host bridge with real Registry/DNS/HTTP/TLS', () => {
  let ca: string, key: string, directory: string;
  let securityEpoch: string, callController: AbortController, dnsHook: (() => void) | undefined;
  let udp: dgram.Socket, plain: http.Server, secure: https.Server, proxy: net.Server;
  let dnsPort: number, httpPort: number, tlsPort: number, proxyPort: number;
  let handshakeDelay: number, handshakeTimers: ReturnType<typeof setTimeout>[];
  let dnsAddress: string, dnsQueries: number, requests: number, proxyConnections: number, connections: number, plaintextBytes: number;
  let sockets: Set<net.Socket>, lastAuthorization: string | undefined, lastHost: string | undefined, lastSni: string | false | null | undefined, seenBody: Buffer;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-nova-pinned-tls-'));
    const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:fixture.test,IP:127.0.0.1', '-keyout', path.join(directory, 'test.key'), '-out', path.join(directory, 'test.crt')], { stdio: 'ignore', windowsHide: true });
    ca = fs.readFileSync(path.join(directory, 'test.crt'), 'utf8'); key = fs.readFileSync(path.join(directory, 'test.key'), 'utf8');
  }, 30000);
  afterAll(() => { if (directory && path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    securityEpoch = 'security-1'; callController = new AbortController(); dnsHook = undefined;
    handshakeDelay = 0; handshakeTimers = []; dnsAddress = '127.0.0.1'; dnsQueries = requests = proxyConnections = connections = plaintextBytes = 0;
    sockets = new Set(); lastAuthorization = lastHost = lastSni = undefined; seenBody = Buffer.alloc(0);
    handler = (_req, res) => { res.setHeader('x-fixture', 'isolated'); res.end('ok'); };
    const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
      requests++; lastHost = req.headers.host; lastAuthorization = req.headers.authorization; const chunks: Buffer[] = [];
      req.on('data', data => chunks.push(Buffer.from(data))); req.on('end', () => { seenBody = Buffer.concat(chunks); handler(req, res); });
    };
    plain = http.createServer(serve); secure = https.createServer({ key, cert: ca, SNICallback: (_host, callback) => { const ready = () => callback(null, tls.createSecureContext({ key, cert: ca })); if (handshakeDelay) handshakeTimers.push(setTimeout(ready, handshakeDelay)); else ready(); } }, serve);
    const track = (socket: net.Socket) => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
    plain.on('connection', socket => { track(socket); socket.on('data', chunk => { plaintextBytes += chunk.length; }); });
    secure.on('connection', track); secure.on('tlsClientError', () => undefined);
    secure.on('secureConnection', socket => { lastSni = socket.servername; socket.on('data', chunk => { plaintextBytes += chunk.length; }); });
    proxy = net.createServer(socket => { proxyConnections++; socket.destroy(); });
    await Promise.all([new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => secure.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
    httpPort = (plain.address() as net.AddressInfo).port; tlsPort = (secure.address() as net.AddressInfo).port; proxyPort = (proxy.address() as net.AddressInfo).port;
    udp = dgram.createSocket('udp4');
    udp.on('message', (query, peer) => {
      dnsQueries++; dnsHook?.(); let at = 12; while (query[at]) at += query[at] + 1; at++; const type = query.readUInt16BE(at), end = at + 4;
      const header = Buffer.alloc(12); query.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(type === 1 ? 1 : 0, 6);
      const answer = Buffer.alloc(16); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(1, 2); answer.writeUInt16BE(1, 4); answer.writeUInt16BE(4, 10); Buffer.from(dnsAddress.split('.').map(Number)).copy(answer, 12);
      udp.send(Buffer.concat([header, query.subarray(12, end), ...(type === 1 ? [answer] : [])]), peer.port, peer.address);
    });
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve)); dnsPort = udp.address().port;
  });
  afterEach(async () => {
    jest.restoreAllMocks(); handshakeTimers.forEach(clearTimeout); sockets.forEach(socket => socket.destroy());
    await Promise.all([new Promise<void>(resolve => udp.close(resolve)), ...[plain, secure, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve())))]);
    expect(proxyConnections).toBe(0);
  });
  const binding = { method: 'POST', path: '/api/items/{id}', endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'asset' };
  async function setup(selection = 'api', useTls = false) {
    const origin = `${useTls ? 'https' : 'http'}://fixture.test:${useTls ? tlsPort : httpPort}`;
    const provider = jest.fn(async (_key: string) => 'synthetic-secret');
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: provider }) });
    const config = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } },
      credentials: { api: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'memory:KEY' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: useTls ? 'https' : 'http', host: 'fixture.test', port: useTls ? tlsPort : httpPort, basePath: '/api' }, allowedHosts: ['fixture.test'], credential: 'api', endpoints: selection === 'inherit' ? [] : [{ endpointDefinitionId: 'endpoint', credential: selection }] }] };
    const snapshot = await registry.reload(config); provider.mockClear();
    const capture = jest.fn(() => registry.captureSnapshot());
    const credentialPolicy = { mode: 'single-hop' as const, captureSnapshot: capture };
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const policy = compiler.compile({ version: 1, id: 'p', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, mode: 'private-exception', connection: 'direct',
      privateException: { id: 'test', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, addresses: ['127.0.0.1'], purpose: 'isolated test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() } });
    const input = { credentialPolicy, operationLifecycle: { readSecurityEpoch: () => securityEpoch, readProviderEpoch: (captured: typeof snapshot) => 'provider-' + captured.generation, captureSignal: () => callController.signal }, compiler, servers: [`127.0.0.1:${dnsPort}`], ca, registrations: [{ snapshot, sourceServiceAssetId: 'asset', siteId: 'site', policy }] };
    const execution = createTrustedSingleHopNetworkExecution(input);
    const spec: any = { openapi: '3.0.3', info: { title: 'bounded fixture', version: '1' }, servers: [{ url: origin }], paths: { '/api/items/{id}': { post: { operationId: 'items', responses: { '200': { description: 'ok' } },
      'x-source-service-asset-id': 'forged', 'x-network-policy': { revision: 'forged' },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'X-Private', in: 'header', schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } } } };
    const tool = (options = {}) => transformToMCPTools(spec, { includeFieldAnnotations: false, trustedOperationBindings: [binding], upstreamCredentialPolicy: credentialPolicy, upstreamNetworkExecution: execution, ...options })[0];
    const prepare = (body?: unknown) => execution.prepare(binding, serializeBoundedNetworkRequest(origin + '/api/items/7', { q: 'hello world' }, body), Date.now() + 5000);
    return { origin, provider, registry, config, capture, credentialPolicy, snapshot, execution, input, spec, tool, prepare };
  }
  const waitFor = async (ready: () => boolean) => { for (let i = 0; i < 1000 && !ready(); i++) await delay(1); expect(ready()).toBe(true); };
  it.each([false, true])('normal reload pins old credentials while a newly registered operation uses new Snapshot, TLS=%s', async useTls => {
    const f = await setup('api', useTls), old = await f.prepare(); expect(f.provider).toHaveBeenCalledTimes(1); f.provider.mockResolvedValue('rotated-secret');
    await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } });
    f.execution.register({ ...f.input.registrations[0], snapshot: f.registry.captureSnapshot() }); f.provider.mockClear();
    const next = await f.prepare(); expect(f.provider).toHaveBeenCalledTimes(1); const received: unknown[] = [];
    handler = (req, res) => { received.push(req.headers['x-private']); res.end('ok'); };
    await f.execution.send(old, {}); await f.execution.send(next, {});
    expect(received).toEqual(['synthetic-secret', 'rotated-secret']); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.capture).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('revocation during DNS aborts before connection, TLS=%s', async useTls => {
    const f = await setup('api', useTls), plan = await f.prepare(); dnsHook = () => f.execution.revoke('asset');
    await expect(f.execution.send(plan, {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(connections).toBe(0); expect(requests).toBe(0);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); securityEpoch = 'security-2'; dnsHook = undefined; expect((await f.execution.send(await f.prepare(), {})).statusCode).toBe(200);
  });
  it('revokes a pending TLS handshake without any HTTP bytes', async () => {
    handshakeDelay = 200; const f = await setup('api', true), plan = await f.prepare(); const pending = f.execution.send(plan, {}); const denied = expect(pending).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    await waitFor(() => connections > 0); f.execution.revoke('asset'); await denied; expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it.each(['revoke', 'cancel'])('actively %s a started response instead of waiting for deadline', async action => {
    const f = await setup(), plan = await f.prepare(); handler = (_req, res) => { res.write('pending'); };
    const pending = f.execution.send(plan, {}), denied = expect(pending).rejects.toMatchObject({ code: action === 'revoke' ? 'upstream_network_policy_denied' : 'ABORT_ERR' });
    await waitFor(() => requests > 0); if (action === 'revoke') f.execution.revoke('asset'); else callController.abort(); await denied; expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('None Transformer uses host lifecycle with context=%s and ignores args Signal/Verified', async context => {
    const f = await setup('none', context); handler = (req, res) => { expect(req.headers['x-private']).toBeUndefined(); expect(req.headers.authorization).toBeUndefined(); res.end('ok'); };
    const run = () => f.tool().handler({ id: '7', 'X-Private': 'forged', signal: { aborted: true }, Verified: true });
    expect((await (context ? withRuntimeCallContext({ transport: 'mcp', identitySource: 'anonymous', requestId: 'fixture' }, run) : run())).isError).toBe(false);
    expect(f.provider).not.toHaveBeenCalled(); expect(f.capture).toHaveBeenCalledTimes(1); expect(getEventListeners(callController.signal, 'abort')).toHaveLength(0);
  });
  it('deadline covers slow Resolver and late Secret result never sends', async () => {
    const f = await setup(); let complete!: () => void; f.provider.mockImplementationOnce(async () => { await new Promise<void>(resolve => complete = resolve); return 'late-secret'; });
    const result = await f.tool({ requestTimeout: 60 }).handler({ id: '7' }); expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('ETIMEDOUT'); expect(requests).toBe(0); expect(dnsQueries).toBe(0); complete(); await delay(10); expect(requests).toBe(0); expect(getEventListeners(callController.signal, 'abort')).toHaveLength(0);
  });
  it('revoked pending Secret cannot produce a plan after resolving late', async () => {
    const f = await setup(); let complete!: () => void; f.provider.mockImplementationOnce(async () => { await new Promise<void>(resolve => complete = resolve); return 'late-secret'; });
    const pending = f.prepare(), rejected = expect(pending).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); await waitFor(() => !!complete); f.execution.revoke('asset'); await rejected; complete(); await delay(5); expect(dnsQueries).toBe(0);
  });
  it('decode failure closes lifecycle listeners and no longer occupies operation capacity', async () => {
    const f = await setup(); handler = (_req, res) => { res.setHeader('content-encoding', 'gzip'); res.end('unsupported'); };
    expect((await f.tool().handler({ id: '7' })).isError).toBe(true); expect(getEventListeners(callController.signal, 'abort')).toHaveLength(0);
    handler = (_req, res) => res.end('ok'); expect((await f.tool().handler({ id: '7' })).isError).toBe(false);
  });
  it('concurrent replay cannot cancel the legitimate first send', async () => {
    const f = await setup(), plan = await f.prepare(); const first = f.execution.send(plan, {}); await expect(f.execution.send(plan, {})).rejects.toThrow(); expect((await first).statusCode).toBe(200); expect(requests).toBe(1);
  });
  it('security state failure during DNS stays unavailable and sanitized', async () => {
    const f = await setup(); const original = f.input.operationLifecycle.readSecurityEpoch;
    // A different factory captures this trusted callback, never request metadata.
    let unavailable = false; const execution = createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: { ...f.input.operationLifecycle, readSecurityEpoch: () => { if (unavailable) throw new Error('private backend path'); return original(); } } });
    const plan = await execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000); dnsHook = () => { unavailable = true; };
    await expect(execution.send(plan, {})).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); expect(connections).toBe(0); expect(requests).toBe(0);
  });
  it.each(['changed', 'unavailable'])('same-Snapshot Provider epoch %s before send fails with zero DNS', async mode => {
    const f = await setup(); let broken = false;
    const execution = createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: { ...f.input.operationLifecycle, readProviderEpoch: () => { if (broken && mode === 'unavailable') throw new Error('private provider path'); return broken ? 'changed' : 'original'; } } });
    const plan = await execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000); broken = true;
    await expect(execution.send(plan, {})).rejects.toMatchObject({ code: mode === 'changed' ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable' }); expect(dnsQueries).toBe(0); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('host Signal acquisition failure is unavailable with no Resolver or DNS', async () => {
    const f = await setup(), execution = createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: { ...f.input.operationLifecycle, captureSignal: () => { throw new Error('private'); } } });
    await expect(execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000)).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0);
  });

  it('total deadline also interrupts a pending custom-header callback and cleans plan', async () => {
    const f = await setup(); let complete!: (value: string) => void;
    const result = await f.tool({ requestTimeout: 80, customHeaders: { dynamic: { 'x-business': () => new Promise<string>(resolve => complete = resolve) } } }).handler({ id: '7' });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('ETIMEDOUT'); expect(dnsQueries).toBe(0); expect(getEventListeners(callController.signal, 'abort')).toHaveLength(0); complete('late'); await delay(5); expect(requests).toBe(0);
  });

  it.each([false, true])('C4 real tool reset has no automatic attempt or credential reread TLS=%s', async useTls => {
    const f = await setup('api', useTls); handler = req => req.socket.destroy();
    const result = await f.tool().handler({ id: '7', retry: 8, attempts: 8, cache: true });
    expect(result.isError).toBe(true); expect(requests).toBe(1); expect(connections).toBe(1); expect(dnsQueries).toBe(2);
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.provider).toHaveBeenCalledTimes(1); expect(getEventListeners(callController.signal, 'abort')).toHaveLength(0);
  });
  it.each([false, true])('C4 503 Retry-After is returned without retry or response caching TLS=%s', async useTls => {
    const f = await setup('api', useTls); handler = (_req, res) => { res.writeHead(503, { 'retry-after': '0', 'cache-control': 'public, max-age=600' }); res.end('unavailable'); };
    await f.tool().handler({ id: '7' }); expect(requests).toBe(1); expect(f.capture).toHaveBeenCalledTimes(1);
    await f.tool().handler({ id: '7' }); expect(requests).toBe(2); expect(connections).toBe(2); expect(f.capture).toHaveBeenCalledTimes(2); expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('C4 DNS refusal consumes plan; replay never resolves again TLS=%s', async useTls => {
    const f = await setup('api', useTls), plan = await f.prepare(); dnsAddress = '169.254.169.254';
    await expect(f.execution.send(plan, {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    const queries = dnsQueries; dnsAddress = '127.0.0.1';
    await expect(f.execution.send(plan, {})).rejects.toThrow(); expect(dnsQueries).toBe(queries); expect(queries).toBe(2); expect(connections).toBe(0); expect(requests).toBe(0); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('C4 transport receives the exact operation Signal and deadline TLS=%s', async useTls => {
    const original = createPinnedHttpTransport, sends: any[] = [];
    jest.spyOn(require('./pinned-http-transport'), 'createPinnedHttpTransport').mockImplementation((options: any) => {
      const transport = original(options); return { ...transport, send: (request: any) => { sends.push(request); return transport.send(request); } };
    });
    const f = await setup('api', useTls), deadline = Date.now() + 5000;
    const plan = await f.execution.prepare(binding, { url: f.origin + '/api/items/7' }, deadline);
    await f.execution.send(plan, {}); expect(sends).toHaveLength(1); expect(sends[0].signal).toBe(plan.signal); expect(sends[0].deadline).toBe(deadline);
    await expect(f.execution.send(plan, {})).rejects.toThrow(); expect(sends).toHaveLength(1); expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it('C4 rejected TLS certificate makes only one connection and consumes the plan', async () => {
    const f = await setup('api', true), execution = createTrustedSingleHopNetworkExecution({ ...f.input, ca: undefined });
    const plan = await execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000);
    await expect(execution.send(plan, {})).rejects.toThrow(); await expect(execution.send(plan, {})).rejects.toThrow();
    expect(connections).toBe(1); expect(requests).toBe(0); expect(dnsQueries).toBe(2); expect(f.capture).toHaveBeenCalledTimes(1); expect(f.provider).toHaveBeenCalledTimes(1);
  });

});
