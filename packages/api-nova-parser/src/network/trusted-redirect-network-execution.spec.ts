import * as redirectTargets from './trusted-redirect-target';
import * as pinnedTransport from './pinned-http-transport';
import { createHostCredentialGenerationStore } from '../credentials/host-credential-generations';
import { createRegistryProviderEvidence } from '../credentials/registry-provider-evidence';
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

describe('generation-bound safe-read redirects over real DNS/HTTP/TLS', () => {
  let ca: string, key: string, directory: string;
  let udp: dgram.Socket, plain: http.Server, secure: https.Server, proxy: net.Server;
  let dnsPort: number, httpPort: number, tlsPort: number, proxyPort: number;
  let handshakeDelay: number, handshakeTimers: ReturnType<typeof setTimeout>[];
  let dnsAddress: string, dnsQueries: number, requests: number, proxyConnections: number, connections: number, plaintextBytes: number;
  let sockets: Set<net.Socket>, lastAuthorization: string | undefined, lastHost: string | undefined, lastSni: string | false | null | undefined, seenBody: Buffer;
  const cleanup: (() => void)[] = [];
  const visits: { url: string; method: string; headers: http.IncomingHttpHeaders }[] = [];
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
    visits.length = 0;
    handshakeDelay = 0; handshakeTimers = []; dnsAddress = '127.0.0.1'; dnsQueries = requests = proxyConnections = connections = plaintextBytes = 0;
    sockets = new Set(); lastAuthorization = lastHost = lastSni = undefined; seenBody = Buffer.alloc(0);
    handler = (_req, res) => { res.setHeader('x-fixture', 'isolated'); res.end('ok'); };
    const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
      visits.push({ url: req.url!, method: req.method!, headers: { ...req.headers } });
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
    cleanup.splice(0).forEach(close => close());
    jest.restoreAllMocks(); handshakeTimers.forEach(clearTimeout); sockets.forEach(socket => socket.destroy());
    await Promise.all([new Promise<void>(resolve => udp.close(resolve)), ...[plain, secure, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve())))]);
    expect(proxyConnections).toBe(0);
  });
  async function setup(useTls = false, enabled = true) {
    const store = createHostCredentialGenerationStore();
    const material = (value: string) => ({ providers: { memory: { TOKEN: value + '-bearer', KEY: value + '-key' } }, expiresAt: Date.now() + 60000 });
    const generation = store.activate(store.stage(material('old')), null), evidence = createRegistryProviderEvidence(store);
    cleanup.push(() => { evidence.close(); store.close(); });
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: evidence });
    const origin = `${useTls ? 'https' : 'http'}://fixture.test:${useTls ? tlsPort : httpPort}`;
    const otherOrigin = `${useTls ? 'http' : 'https'}://fixture.test:${useTls ? httpPort : tlsPort}`;
    const site = (id: string, target: string, basePath: string, credential: string, endpoints: any[]) => {
      const parsed = new URL(target); return { id, sourceServiceAssetId: 'asset', match: { scheme: parsed.protocol.slice(0, -1), host: 'fixture.test', port: Number(parsed.port), basePath }, allowedHosts: ['fixture.test'], credential, endpoints };
    };
    const config: any = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } },
      credentials: { bearer: { type: 'bearer', secretRef: 'memory:TOKEN' }, key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'memory:KEY' } },
      sites: [site('root', origin, '/', 'bearer', [...Array.from({ length: 7 }, (_, index) => ({ endpointDefinitionId: 'e' + index })), { endpointDefinitionId: 'public', credential: 'none' }]),
        site('deep', origin, '/deep', 'key', [{ endpointDefinitionId: 'deep-end' }]), site('other', otherOrigin, '/', 'key', [{ endpointDefinitionId: 'other-end' }])] };
    const snapshot = await registry.reload(config), compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const policy = (siteId: string, target: string) => compiler.compile({ version: 1, id: 'p-' + siteId, revision: '1', sourceServiceAssetId: 'asset', siteId, origin: target, mode: 'private-exception', connection: 'direct',
      privateException: { id: 'test-' + siteId, revision: '1', sourceServiceAssetId: 'asset', siteId, origin: target, addresses: ['127.0.0.1'], purpose: 'isolated redirect test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() } });
    const root = policy('root', origin), deep = policy('deep', origin), other = policy('other', otherOrigin);
    const targets = ['GET', 'HEAD'].flatMap(method => [
      ...Array.from({ length: 6 }, (_, index) => ({ siteId: 'root', method: method as 'GET' | 'HEAD', path: '/' + (index + 1), endpointDefinitionId: 'e' + (index + 1), policy: root, headers: { 'X-Target': 'root' } })),
      { siteId: 'root', method: method as 'GET' | 'HEAD', path: '/public', endpointDefinitionId: 'public', policy: root, headers: { 'X-Target': 'public', Authorization: 'must-strip', Cookie: 'must-strip' } },
      { siteId: 'deep', method: method as 'GET' | 'HEAD', path: '/deep/item', endpointDefinitionId: 'deep-end', policy: deep },
      { siteId: 'other', method: method as 'GET' | 'HEAD', path: '/other', endpointDefinitionId: 'other-end', policy: other, headers: { 'X-Target': 'other' } },
    ]);
    const controller = new AbortController(), capture = jest.fn(() => registry.captureSnapshot());
    const input = { credentialPolicy: { mode: 'single-hop' as const, captureSnapshot: capture }, compiler, ca, servers: [`127.0.0.1:${dnsPort}`],
      operationLifecycle: { readSecurityEpoch: () => 'epoch', readProviderEpoch: (value: any) => evidence.readEpoch(value, 'asset'), captureSignal: () => controller.signal },
      registrations: [{ snapshot, sourceServiceAssetId: 'asset', siteId: 'root', policy: root }],
      ...(enabled ? { redirect: { mode: 'safe-read' as const, providerEvidence: evidence, targets } } : {}) };
    const execution = createTrustedSingleHopNetworkExecution(input);
    const prepare = (method = 'GET', body?: Buffer, deadline = Date.now() + 3000) => execution.prepare(
      { sourceServiceAssetId: 'asset', endpointDefinitionId: 'e0', method, path: '/0' }, { url: origin + '/0', body }, deadline);
    return { execution, prepare, input, origin, otherOrigin, registry, config, snapshot, store, generation, evidence, controller, capture, material };
  }
  it.each([false, true])('five authorized follows use separate verified connections TLS=%s', async useTls => {
    const f = await setup(useTls); handler = (req, res) => { const hop = Number(req.url!.slice(1)); if (hop < 5) { res.statusCode = 302; res.setHeader('Location', '/' + (hop + 1)); } res.end('bounded'); };
    const result = await f.execution.send(await f.prepare(), { 'X-Initial-Only': 'private-business' });
    expect(result.statusCode).toBe(200); expect(visits).toHaveLength(6); expect(connections).toBe(6); expect(dnsQueries).toBeGreaterThanOrEqual(12);
    expect(visits.slice(1).every(item => item.headers['x-initial-only'] === undefined && item.headers['x-target'] === 'root')).toBe(true);
    expect(f.capture).toHaveBeenCalledTimes(1); if (useTls) expect(lastSni).toBe('fixture.test');
  });
  it('sixth follow is rejected before a seventh connection', async () => {
    const f = await setup(); handler = (req, res) => { res.writeHead(302, { location: '/' + (Number(req.url!.slice(1)) + 1) }); res.end(); };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(visits).toHaveLength(6);
  });
  it.each(['missing', 'duplicate', 'loop', 'unknown', 'foreign'])('rejects %s Location with zero next request', async mode => {
    const f = await setup(); handler = (_req, res) => {
      if (mode === 'duplicate') res.writeHead(302, ['Location', '/1', 'lOcAtIoN', '/1']);
      else res.writeHead(302, mode === 'missing' ? {} : { location: mode === 'loop' ? '/0' : mode === 'unknown' ? '/missing' : 'http://foreign.test/1' }); res.end();
    };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(visits).toHaveLength(1);
  });
  it.each(['GET', 'HEAD'])('303 preserves %s through the chain', async method => {
    const f = await setup(); handler = (req, res) => { if (req.url === '/0') res.writeHead(303, { location: '/1' }); res.end(); };
    await f.execution.send(await f.prepare(method), {}); expect(visits.map(item => item.method)).toEqual([method, method]);
  });
  it.each(['POST', 'body', 'default'])('keeps %s single-hop and returns original body', async mode => {
    const f = await setup(false, mode !== 'default'); handler = (_req, res) => { res.writeHead(303, { location: '/1' }); res.end('original'); };
    const result = await f.execution.send(await f.prepare(mode === 'POST' ? 'POST' : 'GET', mode === 'body' ? Buffer.from('') : undefined), {});
    expect(result.statusCode).toBe(303); expect(result.body.toString()).toBe('original'); expect(visits).toHaveLength(1);
  });
  it('selects more specific Site then cross-origin and None without old headers', async () => {
    const f = await setup(); handler = (req, res) => {
      const next = req.url === '/0' ? '/deep/item' : req.url === '/deep/item' ? '/public' : req.url === '/public' ? f.otherOrigin + '/other' : undefined;
      if (next) res.writeHead(302, { location: next }); res.end();
    };
    await f.execution.send(await f.prepare(), { Cookie: 'consumer-cookie', 'X-Initial-Only': 'private' });
    expect(visits).toHaveLength(4); expect(visits[0].headers.authorization).toBe('Bearer old-bearer');
    expect(visits[1].headers['x-key']).toBe('old-key'); expect(visits[1].headers.authorization).toBeUndefined(); expect(visits[1].headers['x-target']).toBeUndefined();
    expect(visits[2].headers.authorization).toBeUndefined(); expect(visits[2].headers['x-key']).toBeUndefined(); expect(visits[2].headers.cookie).toBeUndefined();
    expect(visits[3].headers['x-key']).toBe('old-key'); expect(visits.slice(1).every(v => v.headers['x-initial-only'] === undefined)).toBe(true);
  });
  it('rejects HTTPS downgrade before an HTTP connection', async () => {
    const f = await setup(true); handler = (_req, res) => { res.writeHead(302, { location: f.otherOrigin + '/other' }); res.end(); };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(visits).toHaveLength(1);
  });
  it('ordinary Registry/store rotation cannot mix credentials into the pinned chain', async () => {
    const f = await setup(); handler = (req, res) => { void (async () => {
      if (req.url === '/0') { f.store.activate(f.store.stage(f.material('new')), f.generation); await f.registry.reload({ ...f.config, metadata: { revision: 'r2', environment: 'test' } }); res.writeHead(302, { location: '/deep/item' }); }
      res.end();
    })(); };
    await f.execution.send(await f.prepare(), {}); expect(visits[1].headers['x-key']).toBe('old-key'); expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it.each(['revoke', 'unavailable', 'issuer-close', 'cancel'] as const)('%s during redirect body aborts immediately with exact reason and no next hop', async action => {
    const f = await setup(); handler = (_req, res) => {
      res.writeHead(302, { location: '/1' }); res.write('partial');
      setTimeout(() => { if (action === 'issuer-close') f.evidence.close(); else if (action === 'cancel') f.controller.abort(); else f.store[action](f.generation); }, 10);
    };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: action === 'cancel' ? 'ABORT_ERR' : action === 'revoke' ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable' });
    expect(visits).toHaveLength(1);
  });
  it.each(['oversize', 'timeout'])('bounds redirect %s body and never sends the next request', async mode => {
    const f = await setup(); handler = (_req, res) => {
      res.writeHead(302, { location: '/1', ...(mode === 'oversize' ? { 'Content-Length': String(PINNED_HTTP_MAX_RESPONSE_BYTES + 1) } : {}) }); res.write('partial');
    };
    await expect(f.execution.send(await f.prepare('GET', undefined, Date.now() + 150), {})).rejects.toMatchObject({ code: mode === 'timeout' ? 'ETIMEDOUT' : 'upstream_network_policy_denied' }); expect(visits).toHaveLength(1);
  });
  it('requires genuine generation evidence and lifecycle before any network work', async () => {
    const f = await setup();
    expect(() => createTrustedSingleHopNetworkExecution({ ...f.input, redirect: { ...f.input.redirect!, providerEvidence: { ...f.evidence } } })).toThrow();
    expect(() => createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: undefined })).toThrow();
    const wrong = createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: { ...f.input.operationLifecycle, readProviderEpoch: () => 'invented' } });
    await expect(wrong.prepare({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'e0', method: 'GET', path: '/0' }, { url: f.origin + '/0' }, Date.now() + 1000)).rejects.toThrow(); expect(dnsQueries).toBe(0);
  });
  it('rejects plan copy and replay without new outbound requests', async () => {
    const f = await setup(), plan = await f.prepare();
    await expect(f.execution.send({ ...plan }, {})).rejects.toThrow(); expect(visits).toHaveLength(0);
    await f.execution.send(plan, {}); await expect(f.execution.send(plan, {})).rejects.toThrow(); expect(visits).toHaveLength(1);
  });
  it('changed next-hop DNS answer is reauthorized and denied before another HTTP request', async () => {
    const f = await setup(); handler = (_req, res) => { dnsAddress = '169.254.169.254'; res.writeHead(302, { location: '/1' }); res.end(); };
    await expect(f.execution.send(await f.prepare(), {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(visits).toHaveLength(1); expect(connections).toBe(1); expect(dnsQueries).toBeGreaterThanOrEqual(4);
  });
  it('next-hop TLS certificate failure writes zero HTTP requests to that target', async () => {
    const f = await setup(), execution = createTrustedSingleHopNetworkExecution({ ...f.input, ca: undefined });
    handler = (_req, res) => { res.writeHead(302, { location: f.otherOrigin + '/other' }); res.end(); };
    const plan = await execution.prepare({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'e0', method: 'GET', path: '/0' }, { url: f.origin + '/0' }, Date.now() + 2000);
    await expect(execution.send(plan, {})).rejects.toThrow(); expect(visits).toHaveLength(1); expect(connections).toBe(2);
  });
  it('next-hop Provider epoch mismatch refuses before DNS', async () => {
    const f = await setup(), execution = createTrustedSingleHopNetworkExecution({ ...f.input, operationLifecycle: {
      ...f.input.operationLifecycle, readProviderEpoch: (snapshot: any, binding: any) => binding.endpointDefinitionId === 'deep-end' ? 'mismatch' : f.evidence.readEpoch(snapshot, 'asset'),
    } });
    handler = (_req, res) => { res.writeHead(302, { location: '/deep/item' }); res.end(); };
    const plan = await execution.prepare({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'e0', method: 'GET', path: '/0' }, { url: f.origin + '/0' }, Date.now() + 2000);
    await expect(execution.send(plan, {})).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(visits).toHaveLength(1); expect(dnsQueries).toBe(2);
  });
  it('target template mutation after construction cannot change the captured headers', async () => {
    const f = await setup(), plan = await f.prepare();
    (f.input.redirect!.targets[0].headers as any)['X-Target'] = 'mutated';
    handler = (req, res) => { if (req.url === '/0') res.writeHead(302, { location: '/1' }); res.end(); };
    await f.execution.send(plan, {}); expect(visits[1].headers['x-target']).toBe('root');
  });
  it('operation expiry detaches input signal listeners even if a prepared plan is never sent', async () => {
    const f = await setup(), signal = f.evidence.readSignal(f.snapshot, 'asset');
    const remove = jest.spyOn(signal, 'removeEventListener');
    const plan = await f.prepare('GET', undefined, Date.now() + 50); await delay(80);
    expect(plan.signal!.aborted).toBe(true); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(dnsQueries).toBe(0);
  });
  it('ordinary live-provider Registry lacks generation association and cannot enable safe-read', async () => {
    const f = await setup(), live = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => 'live-secret' }) });
    const snapshot = await live.reload(f.config);
    const execution = createTrustedSingleHopNetworkExecution({ ...f.input, credentialPolicy: { mode: 'single-hop', captureSnapshot: () => snapshot },
      registrations: f.input.registrations.map(item => ({ ...item, snapshot })) });
    await expect(execution.prepare({ sourceServiceAssetId: 'asset', endpointDefinitionId: 'e0', method: 'GET', path: '/0' }, { url: f.origin + '/0' }, Date.now() + 2000)).rejects.toThrow();
    expect(dnsQueries).toBe(0);
  });

  it('all real hops share exactly one authority signal and absolute deadline', async () => {
    const original = pinnedTransport.createPinnedHttpTransport;
    const sent: { signal?: AbortSignal; deadline: number }[] = [];
    jest.spyOn(pinnedTransport, 'createPinnedHttpTransport').mockImplementation(options => {
      const transport = original(options); return Object.freeze({ ...transport, send: async request => {
        sent.push({ signal: request.signal, deadline: request.deadline }); return transport.send(request);
      } });
    });
    const f = await setup(); handler = (req, res) => { if (req.url === '/0') res.writeHead(302, { location: '/1' }); res.end(); };
    const deadline = Date.now() + 2000, plan = await f.prepare('GET', undefined, deadline);
    await f.execution.send(plan, {});
    expect(sent).toHaveLength(2); expect(sent.every(item => item.signal === plan.signal && item.deadline === deadline)).toBe(true);
  });
  it('total deadline is not renewed after successful intermediate responses', async () => {
    const f = await setup(); handler = (req, res) => {
      const timer = setTimeout(() => { const hop = Number(req.url!.slice(1)); if (hop < 5) res.writeHead(302, { location: '/' + (hop + 1) }); res.end(); }, 80);
      handshakeTimers.push(timer);
    };
    await expect(f.execution.send(await f.prepare('GET', undefined, Date.now() + 220), {})).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(visits.length).toBeLessThan(6);
  });
  it.each(['revoke', 'timeout'])('waiting for a real selected target is interruptible by %s', async mode => {
    const original = redirectTargets.createTrustedRedirectTargetSelector;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(redirectTargets, 'createTrustedRedirectTargetSelector').mockImplementation(options => {
      const selector = original(options); return Object.freeze({ ...selector, select: async (...args) => {
        const target = await selector.select(...args); entered(); await held; return target;
      } });
    });
    const f = await setup(); handler = (_req, res) => { res.writeHead(302, { location: '/deep/item' }); res.end(); };
    const pending = f.execution.send(await f.prepare('GET', undefined, Date.now() + 250), {});
    await ready;
    try {
      if (mode === 'revoke') f.store.revoke(f.generation);
      await expect(pending).rejects.toMatchObject({ code: mode === 'revoke' ? 'upstream_network_policy_denied' : 'ETIMEDOUT' });
      expect(visits).toHaveLength(1); expect(dnsQueries).toBe(2);
    } finally { release(); }
  });

});
