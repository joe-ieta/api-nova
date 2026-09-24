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

describe('pinned single-hop transport over real isolated DNS/HTTP/TLS', () => {
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
  function setup(options: { tls?: boolean; trust?: boolean; host?: string; addresses?: string[]; expiry?: number; public?: boolean } = {}) {
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const host = options.host ?? 'fixture.test', port = options.tls ? tlsPort : httpPort, origin = `${options.tls ? 'https' : 'http'}://${host}:${port}`;
    const base = { version: 1, id: 'p', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, mode: options.public ? 'public' : 'private-exception', connection: 'direct' };
    const policy = compiler.compile(options.public ? base : { ...base, privateException: { id: 'test', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, addresses: options.addresses ?? ['127.0.0.1'], purpose: 'isolated test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(options.expiry ?? Date.now() + 30000).toISOString() } });
    const transport = createPinnedHttpTransport({ compiler, servers: [`127.0.0.1:${dnsPort}`], ...(options.trust ? { ca } : {}) });
    const input = { policy, target: { sourceServiceAssetId: 'asset', siteId: 'site', url: origin + '/path?secret=not-for-errors' }, deadline: Date.now() + 2000, method: 'POST', headers: { Authorization: 'synthetic-secret' }, body: Buffer.from('synthetic-body') };
    return { compiler, transport, input };
  }
  it.each([false, true])('success with literal pin, Host, raw bytes and verified TLS=%s', async useTls => {
    const { transport, input } = setup({ tls: useTls, trust: useTls });
    const result = await transport.send(input);
    expect(result.statusCode).toBe(200); expect(result.body.toString()).toBe('ok'); expect(result.headers['x-fixture']).toBe('isolated');
    expect(lastHost).toBe(`fixture.test:${useTls ? tlsPort : httpPort}`); expect(seenBody.toString()).toBe('synthetic-body');
    if (useTls) expect(lastSni).toBe('fixture.test'); expect(dnsQueries).toBe(2); expect(requests).toBe(1);
  });
  it('snapshots URL, headers and Buffer before asynchronous DNS', async () => {
    const { transport, input } = setup(); const pending = transport.send(input);
    input.target.url = `http://127.0.0.1:${proxyPort}/trap`; input.headers.Authorization = 'changed'; input.body.fill(0);
    expect((await pending).statusCode).toBe(200); expect(lastAuthorization).toBe('synthetic-secret'); expect(seenBody.toString()).toBe('synthetic-body'); expect(proxyConnections).toBe(0);
  });
  it('rejects invalid deadline without executing coercion hooks or DNS', async () => {
    const { transport, input } = setup(), valueOf = jest.fn(() => Date.now() + 1000);
    await expect(transport.send({ ...input, deadline: { valueOf } } as any)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(valueOf).not.toHaveBeenCalled(); expect(dnsQueries).toBe(0);
  });
  it('never automatically follows redirect or repeats a request', async () => {
    handler = (_req, res) => { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${proxyPort}/trap`); res.end('redirect'); };
    const { transport, input } = setup(); expect((await transport.send(input)).statusCode).toBe(302); expect(requests).toBe(1); expect(dnsQueries).toBe(2);
  });
  it('new request uses fresh DNS and socket; a rebound destination is refused', async () => {
    const { transport, input } = setup(); await transport.send(input); await transport.send(input);
    expect(connections).toBe(2); expect(dnsQueries).toBe(4);
    dnsAddress = '127.0.0.2'; await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(connections).toBe(2); expect(requests).toBe(2); expect(dnsQueries).toBe(6);
  });
  it.each([false, true])('real different peer receives zero HTTP bytes (fault-injected dial), TLS=%s', async useTls => {
    dnsAddress = '127.0.0.2'; const { transport, input } = setup({ tls: useTls, trust: true, addresses: ['127.0.0.2'] });
    if (useTls) { const original = tls.connect; jest.spyOn(require('node:tls') as typeof tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => original({ ...options, host: '127.0.0.1' })) as typeof tls.connect); }
    else { const original = net.createConnection; jest.spyOn(require('node:net') as typeof net, 'createConnection').mockImplementation(((options: net.NetConnectOpts) => original({ ...options as net.TcpNetConnectOpts, host: '127.0.0.1' })) as typeof net.createConnection); }
    await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); await delay(20);
    expect(connections).toBe(1); expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it.each(['untrusted', 'wrong-host'])('rejects %s certificate before HTTP write', async mode => {
    const { transport, input } = setup({ tls: true, trust: mode !== 'untrusted', host: mode === 'wrong-host' ? 'other.test' : undefined });
    await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); await delay(20);
    expect(connections).toBe(1); expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it('public policy/private answer refuses before connecting', async () => {
    const { transport, input } = setup({ public: true }); await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(connections).toBe(0);
  });
  it('request limit is enforced before DNS and writes', async () => {
    const { transport, input } = setup(); await expect(transport.send({ ...input, body: Buffer.alloc(PINNED_HTTP_MAX_REQUEST_BYTES + 1) })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(0); expect(connections).toBe(0);
  });
  it.each(['declared', 'chunked'])('response limit %s destroys socket and never returns partial bytes', async mode => {
    let closed = false; handler = (_req, res) => {
      res.once('close', () => { closed = true; });
      if (mode === 'declared') { res.setHeader('Content-Length', String(PINNED_HTTP_MAX_RESPONSE_BYTES + 1)); res.flushHeaders(); }
      else { res.write(Buffer.alloc(PINNED_HTTP_MAX_RESPONSE_BYTES)); res.end(Buffer.from('overflow')); }
    };
    const { transport, input } = setup(); await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); await delay(20); expect(closed).toBe(true);
  });
  it.each(['HEAD', '304'])('retains representation Content-Length for bodyless %s', async mode => {
    handler = (_req, res) => { res.statusCode = mode === '304' ? 304 : 200; res.setHeader('Content-Length', String(PINNED_HTTP_MAX_RESPONSE_BYTES + 1)); res.end(); };
    const { transport, input } = setup(); const result = await transport.send({ ...input, method: mode === 'HEAD' ? 'HEAD' : 'GET', body: undefined });
    expect(result.body.length).toBe(0); expect(result.headers['content-length']).toBe(String(PINNED_HTTP_MAX_RESPONSE_BYTES + 1));
  });
  it('abort and absolute deadline destroy an active response', async () => {
    let closed = 0; handler = (_req, res) => { res.on('close', () => closed++); res.write('partial'); };
    const { transport, input } = setup(), controller = new AbortController();
    const aborted = transport.send({ ...input, signal: controller.signal }); setTimeout(() => controller.abort(), 40);
    await expect(aborted).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await expect(transport.send({ ...input, deadline: Date.now() + 50 })).rejects.toMatchObject({ code: 'ETIMEDOUT' }); await delay(20); expect(closed).toBe(2);
  });
  it('exception expiry during a real delayed TLS handshake prevents HTTP release', async () => {
    handshakeDelay = 150;
    const { transport, input } = setup({ tls: true, trust: true, expiry: Date.now() + 60 });
    await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    await delay(20); expect(connections).toBe(1); expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it('cancel and deadline during TLS negotiation leak zero HTTP bytes', async () => {
    handshakeDelay = 200;
    const { transport, input } = setup({ tls: true, trust: true }), controller = new AbortController();
    const pending = transport.send({ ...input, signal: controller.signal }); setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await expect(transport.send({ ...input, deadline: Date.now() + 50 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(requests).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it('allows exact 8 MiB request/response bounds', async () => {
    handler = (_req, res) => res.end(Buffer.alloc(PINNED_HTTP_MAX_RESPONSE_BYTES));
    const { transport, input } = setup();
    const result = await transport.send({ ...input, deadline: Date.now() + 5000, body: Buffer.alloc(PINNED_HTTP_MAX_REQUEST_BYTES) });
    expect(seenBody.length).toBe(PINNED_HTTP_MAX_REQUEST_BYTES); expect(result.body.length).toBe(PINNED_HTTP_MAX_RESPONSE_BYTES);
  });
  it('explicit TLS verification cannot be disabled by process environment', async () => {
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try { const { transport, input } = setup({ tls: true }); await expect(transport.send(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(requests).toBe(0); }
    finally { if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved; }
  });
  it('pre-aborted call never resolves or connects', async () => {
    const { transport, input } = setup(), controller = new AbortController(); controller.abort();
    await expect(transport.send({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' }); expect(dnsQueries).toBe(0); expect(connections).toBe(0);
  });
  it.each(['agent', 'socket', 'lookup', 'proxy', 'transport', 'rejectUnauthorized'])('rejects external %s override before DNS', async key => {
    const { transport, input } = setup(); await expect(transport.send({ ...input, [key]: true } as any)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(0);
  });
  it.each([false, true])('ignores startup env proxy in a fresh child, TLS=%s', async useTls => {
    const { input } = setup({ tls: useTls, trust: true });
    const origin = new URL(input.target.url).origin;
    const rawPolicy = { version: 1, id: 'child', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, mode: 'private-exception', connection: 'direct',
      privateException: { id: 'test', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, addresses: ['127.0.0.1'], purpose: 'child fixture', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() } };
    const script = `const {createNetworkPolicyCompiler}=require(${JSON.stringify(path.join(__dirname, 'network-policy.ts'))});
      const {createPinnedHttpTransport}=require(${JSON.stringify(path.join(__dirname, 'pinned-http-transport.ts'))});
      const compiler=createNetworkPolicyCompiler({deniedDestinations:[],loopback:'test-only'});
      const transport=createPinnedHttpTransport({compiler,servers:${JSON.stringify([`127.0.0.1:${dnsPort}`])},ca:${JSON.stringify(ca)}});
      transport.send({policy:compiler.compile(${JSON.stringify(rawPolicy)}),target:${JSON.stringify(input.target)},method:'GET',deadline:Date.now()+5000})
      .then(result=>process.stdout.write(String(result.statusCode)+':'+result.body.toString())).catch(()=>{process.exitCode=1;});`;
    const env = { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json'), NODE_USE_ENV_PROXY: '1' };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) (env as NodeJS.ProcessEnv)[name] = `http://127.0.0.1:${proxyPort}`;
    for (const name of ['NO_PROXY', 'no_proxy']) (env as NodeJS.ProcessEnv)[name] = 'unrelated.test';
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', script], { env, windowsHide: true, timeout: 15000, maxBuffer: 16384 }, (failure, stdout) => failure ? reject(new Error('isolated child failed')) : resolve(stdout)));
    expect(output).toBe('200:ok'); expect(requests).toBe(1); expect(proxyConnections).toBe(0);
  }, 20000);
  it('ignores all proxy environment names and NODE_USE_ENV_PROXY without changing the environment', async () => {
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
    const saved = names.map(name => [name, process.env[name]] as const);
    try {
      for (const name of names) process.env[name] = name === 'NODE_USE_ENV_PROXY' ? '1' : name.toLowerCase() === 'no_proxy' ? 'unrelated.test' : `http://127.0.0.1:${proxyPort}`;
      const { transport, input } = setup({ tls: true, trust: true }); await transport.send(input);
      expect(process.env.NODE_USE_ENV_PROXY).toBe('1'); expect(requests).toBe(1); expect(proxyConnections).toBe(0);
    } finally { for (const [name, original] of saved) { if (original === undefined) delete process.env[name]; else process.env[name] = original; } }
  });
});
