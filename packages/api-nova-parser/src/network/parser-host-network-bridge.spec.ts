import { createParserHostNetworkBridge } from './parser-host-network-bridge';
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

describe('D3 host composition with real Registry/DNS/HTTP/TLS', () => {
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
  const bridges: ReturnType<typeof createParserHostNetworkBridge>[] = [];
  afterEach(() => { bridges.splice(0).forEach(bridge => bridge.close()); });
  async function setup(selection = 'api', useTls = false, activated = true, adapter = true) {
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
    // Explicit simulated host attestation fixture, NOT an env/file atomic Provider issuer.
    const proofs = new WeakMap<object, { snapshot: typeof snapshot; epoch: string; expiresAt: number }>();
    const epochs = new WeakMap<object, string>(); epochs.set(snapshot, 'provider-1');
    const issue = (captured = registry.captureSnapshot(), expiresAt = Date.now() + 20000) => { const proof = Object.freeze({}); const epoch = epochs.get(captured) ?? 'provider-' + captured.generation; epochs.set(captured, epoch); proofs.set(proof, { snapshot: captured, epoch, expiresAt }); return proof; };
    const evidence = { readEpoch: (captured: typeof snapshot) => { const epoch = epochs.get(captured); if (!epoch) throw Error('private'); return epoch; },
      consume: (proof: unknown, context: { snapshot: typeof snapshot; sourceServiceAssetId: string; providerEpoch: string }) => {
        if (!proof || typeof proof !== 'object') return undefined; const receipt = proofs.get(proof); proofs.delete(proof);
        return receipt && receipt.snapshot === context.snapshot && context.sourceServiceAssetId === 'asset' && receipt.epoch === context.providerEpoch ? Object.freeze({ expiresAt: receipt.expiresAt }) : undefined;
      } };
    const input = { registry, sourceServiceAssetId: 'asset', compiler, servers: [`127.0.0.1:${dnsPort}`], ca, registrations: [{ snapshot, sourceServiceAssetId: 'asset', siteId: 'site', policy }], ...(adapter ? { providerEvidence: evidence } : {}) };
    const bridge = createParserHostNetworkBridge(input); bridges.push(bridge); const execution = bridge.execution;
    if (activated) bridge.activateCurrent(issue());
    const spec: any = { openapi: '3.0.3', info: { title: 'bounded fixture', version: '1' }, servers: [{ url: origin }], paths: { '/api/items/{id}': { post: { operationId: 'items', responses: { '200': { description: 'ok' } },
      'x-source-service-asset-id': 'forged', 'x-network-policy': { revision: 'forged' },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'X-Private', in: 'header', schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } } } };
    const tool = (options = {}) => transformToMCPTools(spec, { includeFieldAnnotations: false, trustedOperationBindings: [binding], upstreamCredentialPolicy: bridge.credentialPolicy, upstreamNetworkExecution: execution, ...options })[0];
    const prepare = (body?: unknown) => execution.prepare(binding, serializeBoundedNetworkRequest(origin + '/api/items/7', { q: 'hello world' }, body), Date.now() + 5000);
    return { origin, provider, registry, config, snapshot, execution, input, spec, tool, prepare, bridge, issue, epochs };
  }
  const waitFor = async (ready: () => boolean) => { for (let i = 0; i < 1000 && !ready(); i++) await delay(1); expect(ready()).toBe(true); };
  it.each([false, true])('ordinary reload preserves prepared version and requires new proof, TLS=%s', async useTls => {
    const f = await setup('api', useTls), old = await f.prepare(); expect(f.provider).toHaveBeenCalledTimes(1);
    await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } });
    await expect(f.prepare()).rejects.toThrow();
    f.bridge.registerCurrent([{ ...f.input.registrations[0], snapshot: f.registry.captureSnapshot() }]);
    await expect(f.prepare()).rejects.toThrow(); f.bridge.activateCurrent(f.issue()); f.provider.mockClear(); const next = await f.prepare();
    expect(f.provider).toHaveBeenCalledTimes(1); expect(old.credentials.revision).toBe('r1'); expect(next.credentials.revision).toBe('r2');
    expect((await f.execution.send(old, {})).statusCode).toBe(200); expect((await f.execution.send(next, {})).statusCode).toBe(200);
    expect(f.provider).toHaveBeenCalledTimes(1); expect(requests).toBe(2);
  });
  it('no proof/adapter, copied proof and replay cannot authorize; zero DNS', async () => {
    const f = await setup('api', false, false); await expect(f.prepare()).rejects.toThrow(); const proof = f.issue();
    expect(() => f.bridge.activateCurrent(JSON.parse(JSON.stringify(proof)))).toThrow(); f.bridge.activateCurrent(proof);
    expect(() => f.bridge.activateCurrent(proof)).toThrow(); expect(dnsQueries).toBe(0);
    const absent = await setup('api', false, false, false); expect(() => absent.bridge.activateCurrent({})).toThrow(); await expect(absent.prepare()).rejects.toThrow();
  });
  it('None works through Transformer without leaking a credential', async () => {
    const f = await setup('none'); const result = await f.tool().handler({ id: '7', body: { ok: true } }); expect(result.isError).not.toBe(true); expect(f.provider).not.toHaveBeenCalled(); expect(lastAuthorization).toBeUndefined(); expect(requests).toBe(1);
  });
  it('invalid reload preserves prepared and future operations', async () => {
    const f = await setup(), old = await f.prepare(); await expect(f.registry.reload({})).rejects.toThrow();
    expect((await f.execution.send(old, {})).statusCode).toBe(200); expect((await f.execution.send(await f.prepare(), {})).statusCode).toBe(200);
  });
  it('actual Registry security change cancels old plan before DNS', async () => {
    const f = await setup(), old = await f.prepare(); await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' }, sites: [{ ...f.config.sites[0], allowedHosts: ['fixture.test', 'other.test'] }] });
    expect(old.signal!.aborted).toBe(true); await expect(f.execution.send(old, {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(0);
  });
  it.each(['revoke', 'unavailable'] as const)('%s during DNS cancels before socket delivery', async action => {
    const f = await setup(); dnsHook = () => f.bridge[action]();
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: action === 'revoke' ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable' }); expect(requests).toBe(0); expect(connections).toBe(0);
  });
  it('revoke during delayed TLS handshake sends zero HTTP bytes', async () => {
    const f = await setup('api', true); handshakeDelay = 1000; const sending = f.execution.send(await f.prepare(), {}); const assertion = expect(sending).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    await waitFor(() => connections > 0); f.bridge.revoke(); await assertion; expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it.each(['revoke', 'unavailable', 'close'] as const)('%s interrupts an active response', async action => {
    const f = await setup(); handler = (_req, res) => { res.writeHead(200); res.write('pending'); };
    const sending = f.execution.send(await f.prepare(), {}); const assertion = expect(sending).rejects.toMatchObject({ code: action === 'revoke' ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable' });
    await waitFor(() => requests === 1); f.bridge[action](); await assertion;
  });
  it('trusted proof expiry synchronously aborts active response', async () => {
    const f = await setup('api', false, false); f.bridge.activateCurrent(f.issue(undefined, Date.now() + 300)); handler = (_req, res) => { res.writeHead(200); res.write('pending'); };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(requests).toBe(1);
  });
  it('Provider epoch mismatch rejects without DNS and does not re-resolve secret', async () => {
    const f = await setup(), old = await f.prepare(); f.epochs.set(f.snapshot, 'changed');
    await expect(f.execution.send(old, {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(0); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('foreign Snapshot evidence cannot authorize current registration', async () => {
    const f = await setup('api', false, false); const proof = f.issue(); await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } });
    f.bridge.registerCurrent([{ ...f.input.registrations[0], snapshot: f.registry.captureSnapshot() }]); f.issue();
    expect(() => f.bridge.activateCurrent(proof)).toThrow(); await expect(f.prepare()).rejects.toThrow(); expect(dnsQueries).toBe(0);
  });
  it('unreadable Provider evidence after prepare is unavailable and zero DNS', async () => {
    const f = await setup(), old = await f.prepare(); f.epochs.delete(f.snapshot);
    await expect(f.execution.send(old, {})).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); expect(dnsQueries).toBe(0);
  });
  it('expired old generation timer cannot revoke a recovered epoch', async () => {
    const f = await setup('api', false, false); f.bridge.activateCurrent(f.issue(undefined, Date.now() + 150)); f.bridge.revoke();
    f.bridge.activateCurrent(f.issue()); await delay(180); expect((await f.execution.send(await f.prepare(), {})).statusCode).toBe(200);
  });
  it('shutdown removes real Registry subscription and active source listeners', async () => {
    const f = await setup(), old = await f.prepare(); f.bridge.close(); expect(old.signal!.aborted).toBe(true);
    await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } });
    expect(() => f.bridge.activateCurrent(f.issue())).toThrow(); await expect(f.prepare()).rejects.toThrow(); expect(dnsQueries).toBe(0);
  });
  it('source mismatch and protected OpenAPI remain zero Resolver/HTTP', async () => {
    const f = await setup(); await expect(f.execution.prepare({ ...binding, sourceServiceAssetId: 'foreign' }, serializeBoundedNetworkRequest(f.origin + '/api/items/7', {}, undefined), Date.now() + 1000)).rejects.toThrow();
    f.spec.components = { securitySchemes: { required: { type: 'http', scheme: 'bearer' } } }; f.spec.security = [{ required: [] }];
    const result = await f.tool().handler({ id: '7', body: {} }); expect(result.isError).toBe(true); expect(f.provider).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0); expect(requests).toBe(0);
  });
  it('clone or foreign registration fails before authorization', async () => {
    const f = await setup(); expect(() => f.bridge.registerCurrent([{ ...f.input.registrations[0], snapshot: Object.freeze({ ...f.snapshot }) }])).toThrow();
    expect(() => f.bridge.registerCurrent([{ ...f.input.registrations[0], sourceServiceAssetId: 'foreign' }])).toThrow(); expect(dnsQueries).toBe(0);
  });
});
