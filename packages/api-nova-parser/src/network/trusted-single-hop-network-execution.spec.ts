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

describe('trusted host network bridge with real Registry and isolated DNS/HTTP/TLS', () => {
  let ca: string, key: string, directory: string;
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
      dnsQueries++; let at = 12; while (query[at]) at += query[at] + 1; at++; const type = query.readUInt16BE(at), end = at + 4;
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
    const input = { credentialPolicy, compiler, servers: [`127.0.0.1:${dnsPort}`], ca, registrations: [{ snapshot, sourceServiceAssetId: 'asset', siteId: 'site', policy }] };
    const execution = createTrustedSingleHopNetworkExecution(input);
    const spec: any = { openapi: '3.0.3', info: { title: 'bounded fixture', version: '1' }, servers: [{ url: origin }], paths: { '/api/items/{id}': { post: { operationId: 'items', responses: { '200': { description: 'ok' } },
      'x-source-service-asset-id': 'forged', 'x-network-policy': { revision: 'forged' },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'X-Private', in: 'header', schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } } } };
    const tool = (options = {}) => transformToMCPTools(spec, { includeFieldAnnotations: false, trustedOperationBindings: [binding], upstreamCredentialPolicy: credentialPolicy, upstreamNetworkExecution: execution, ...options })[0];
    const prepare = (body?: unknown) => execution.prepare(binding, serializeBoundedNetworkRequest(origin + '/api/items/7', { q: 'hello world' }, body), Date.now() + 5000);
    return { origin, provider, registry, config, capture, credentialPolicy, snapshot, execution, input, spec, tool, prepare };
  }
  it.each(['api', 'none', 'inherit'])('uses real Resolver Site/Endpoint/None selection=%s and immutable identity', async selection => {
    const f = await setup(selection);
    const plan = await f.prepare({ value: 'body' });
    expect(plan.credentials).toMatchObject({ siteId: 'site', generation: 1, revision: 'r1' });
    handler = (req, res) => { expect(req.headers['x-private']).toBe(selection === 'none' ? undefined : 'synthetic-secret'); expect(req.headers['accept-encoding']).toBe('identity'); res.end('ok'); };
    await f.execution.send(plan, { 'X-Private': 'consumer-secret', 'Accept-Encoding': 'gzip' });
    expect(seenBody.toString()).toBe('{"value":"body"}'); expect(requests).toBe(1); expect(f.capture).toHaveBeenCalledTimes(1);
    await expect(f.execution.send(plan, {})).rejects.toThrow(); expect(requests).toBe(1);
  });
  it.each([false, true])('Transformer actual HTTP/TLS path ignores Axios ambient credentials, context=%s', async context => {
    const f = await setup('none', context), ambient = jest.fn(); const old = axios.defaults.adapter; axios.defaults.adapter = ambient;
    handler = (req, res) => { expect(req.url).toBe('/api/items/7?q=hello+world'); expect(req.headers['x-private']).toBeUndefined(); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); };
    try {
      const run = () => f.tool({ defaultHeaders: { 'X-Private': 'ambient' } }).handler({ id: '7', q: 'hello world', 'X-Private': 'consumer', body: { name: 'test' }, siteId: 'forged' });
      const result = await (context ? withRuntimeCallContext({ transport: 'mcp', identitySource: 'anonymous', requestId: 'fixture' }, run) : run());
      expect(result.isError).toBe(false); expect(requests).toBe(1); expect(ambient).not.toHaveBeenCalled(); expect(f.capture).toHaveBeenCalledTimes(1);
      if (context) expect(lastSni).toBe('fixture.test');
    } finally { axios.defaults.adapter = old; }
  });
  it.each(['clone', 'reload'])('rejects %s Snapshot even matching public metadata before provider or DNS', async mode => {
    const f = await setup();
    if (mode === 'clone') f.capture.mockReturnValue(Object.freeze({ ...f.snapshot }));
    else await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } });
    f.provider.mockClear(); await expect(f.prepare()).rejects.toThrow(); expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0); expect(connections).toBe(0);
  });
  it('rejects forged execution, plan, foreign plan and concurrent replay', async () => {
    const f = await setup(); expect(() => f.tool({ upstreamNetworkExecution: { prepare: jest.fn(), send: jest.fn() } })).toThrow();
    const plan = await f.prepare(); const other = createTrustedSingleHopNetworkExecution(f.input);
    await expect(other.send(plan, {})).rejects.toThrow(); await expect(f.execution.send(JSON.parse(JSON.stringify(plan)), {})).rejects.toThrow();
    const outcomes = await Promise.allSettled([f.execution.send(plan, {}), f.execution.send(plan, {})]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(requests).toBe(1);
  });
  it('serializes body/query before capture and cannot change captured target/body during Secret resolution', async () => {
    const f = await setup(); let release!: () => void; f.provider.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'synthetic-secret'; });
    const body = { name: 'original' }, query = { q: 'original' }; const request = serializeBoundedNetworkRequest(f.origin + '/api/items/7', query, body);
    const pending = f.execution.prepare(binding, request, Date.now() + 5000); body.name = 'changed'; query.q = 'changed'; request.body!.fill(0); release();
    handler = (req, res) => { expect(req.url).toBe('/api/items/7?q=original'); res.end('ok'); };
    await f.execution.send(await pending, {}); expect(seenBody.toString()).toBe('{"name":"original"}');
  });
  it('F1 protected declaration denies before capture, Secret, DNS and HTTP', async () => {
    const f = await setup(); f.spec.security = [{ key: [] }]; f.spec.components = { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Private' } } };
    const result = await f.tool().handler({ id: '7', Verified: true }); expect(result.isError).toBe(true); expect(f.capture).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0); expect(requests).toBe(0);
  });
  it.each(['gzip', 'br', 'application/octet-stream', 'invalid-json'])('rejects unsupported response %s before interpretation', async kind => {
    const f = await setup(); handler = (_req, res) => { if (kind === 'gzip' || kind === 'br') res.setHeader('content-encoding', kind); else res.setHeader('content-type', kind === 'invalid-json' ? 'application/json' : kind); res.end('invalid bytes'); };
    expect((await f.tool().handler({ id: '7' })).isError).toBe(true); expect(requests).toBe(1);
  });
  it('redirect is single hop and rebinding cannot reach another peer', async () => {
    const f = await setup(); handler = (_req, res) => { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${proxyPort}/trap`); res.end('redirect'); };
    expect((await f.execution.send(await f.prepare(), {})).statusCode).toBe(302); dnsAddress = '127.0.0.2'; await expect(f.execution.send(await f.prepare(), {})).rejects.toThrow(); expect(requests).toBe(1);
  });
  it('invalid bounded values never execute hooks', () => {
    const hook = jest.fn(() => 'bad'), array: any[] = []; Object.defineProperty(array, '0', { get: hook });
    for (const body of [{ toJSON: hook }, Object.defineProperty({}, 'x', { get: hook }), Buffer.alloc(PINNED_HTTP_MAX_REQUEST_BYTES + 1)]) expect(() => serializeBoundedNetworkRequest('http://fixture.test/api', {}, body)).toThrow();
    expect(() => serializeBoundedNetworkRequest('http://fixture.test/api', { q: array }, undefined)).toThrow(); expect(hook).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0);
  });
  it('requires exact host registration source/site/origin and compiler capability', async () => {
    const f = await setup();
    for (const registration of [
      { ...f.input.registrations[0], sourceServiceAssetId: 'other' },
      { ...f.input.registrations[0], siteId: 'other' },
      { ...f.input.registrations[0], policy: JSON.parse(JSON.stringify(f.input.registrations[0].policy)) },
    ]) expect(() => createTrustedSingleHopNetworkExecution({ ...f.input, registrations: [registration] })).toThrow();
    await expect(f.execution.prepare(undefined, { url: f.origin + '/api/items/7' }, Date.now() + 5000)).rejects.toThrow();
    expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0);
  });
  it('rejects an untrusted TLS certificate without HTTP bytes', async () => {
    const f = await setup('api', true);
    const execution = createTrustedSingleHopNetworkExecution({ ...f.input, ca: undefined });
    const plan = await execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000);
    await expect(execution.send(plan, {})).rejects.toThrow(); expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it('rejects oversized Transformer body before Snapshot capture and Resolver', async () => {
    const f = await setup();
    const result = await f.tool().handler({ id: '7', body: 'x'.repeat(PINNED_HTTP_MAX_REQUEST_BYTES + 1) });
    expect(result.isError).toBe(true); expect(f.capture).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0);
  });

  it('explicit host mode ignores proxy environment and never forwards consumer auth', async () => {
    const saved = process.env.HTTP_PROXY; process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    try { const f = await setup('none'); await f.execution.send(await f.prepare(), { Authorization: 'consumer', Cookie: 'consumer' }); expect(lastAuthorization).toBeUndefined(); expect(requests).toBe(1); }
    finally { if (saved === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved; }
  });
  it('late send cannot use expired deadline and cannot override Host', async () => {
    const f = await setup();
    const plan = await f.execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000);
    await expect(f.execution.send(plan, { Host: 'other.invalid' })).rejects.toThrow(); expect(dnsQueries).toBe(0);
    const expired = await f.execution.prepare(binding, { url: f.origin + '/api/items/7' }, Date.now() + 5000);
    const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 10000);
    await expect(f.execution.send(expired, {})).rejects.toThrow(); expect(dnsQueries).toBe(0);
  });

});
