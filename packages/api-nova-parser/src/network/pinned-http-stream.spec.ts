import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createPinnedHttpStreamTransport } from './pinned-http-stream';
import { createNetworkPolicyCompiler } from './network-policy';

describe('pinned streaming single-hop transport over real isolated DNS/HTTP/TLS', () => {
  let ca: string, key: string, directory: string;
  let udp: dgram.Socket, plain: http.Server, secure: https.Server, proxy: net.Server;
  let dnsPort: number, httpPort: number, tlsPort: number, proxyPort: number;
  let uploadPauseMs: number, handshakeDelay: number, handshakeTimers: ReturnType<typeof setTimeout>[];
  let dnsSilent: boolean, dnsAddress: string, dnsQueries: number, requests: number, proxyConnections: number, connections: number, plaintextBytes: number;
  let sockets: Set<net.Socket>, lastAuthorization: string | undefined, lastHost: string | undefined, lastSni: string | false | null | undefined, seenBody: Buffer;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-nova-pinned-stream-tls-'));
    const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:fixture.test,IP:127.0.0.1', '-keyout', path.join(directory, 'test.key'), '-out', path.join(directory, 'test.crt')], { stdio: 'ignore', windowsHide: true });
    ca = fs.readFileSync(path.join(directory, 'test.crt'), 'utf8'); key = fs.readFileSync(path.join(directory, 'test.key'), 'utf8');
  }, 30000);
  afterAll(() => { if (directory && path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    uploadPauseMs = 0; handshakeDelay = 0; handshakeTimers = []; dnsSilent = false; dnsAddress = '127.0.0.1'; dnsQueries = requests = proxyConnections = connections = plaintextBytes = 0;
    sockets = new Set(); lastAuthorization = lastHost = lastSni = undefined; seenBody = Buffer.alloc(0);
    handler = (_req, res) => { res.setHeader('x-fixture', 'isolated'); res.end('ok'); };
    const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
      requests++; lastHost = req.headers.host; lastAuthorization = req.headers.authorization; const chunks: Buffer[] = [];
      req.on('data', data => chunks.push(Buffer.from(data))); if (uploadPauseMs) { req.pause(); handshakeTimers.push(setTimeout(() => req.resume(), uploadPauseMs)); } req.on('end', () => { seenBody = Buffer.concat(chunks); handler(req, res); });
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
      dnsQueries++; if (dnsSilent) return; let at = 12; while (query[at]) at += query[at] + 1; at++; const type = query.readUInt16BE(at), end = at + 4;
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
    const transport = createPinnedHttpStreamTransport({ compiler, servers: [`127.0.0.1:${dnsPort}`], ...(options.trust ? { ca } : {}) });
    const input = { policy, target: { sourceServiceAssetId: 'asset', siteId: 'site', url: origin + '/path?secret=not-for-errors' }, deadline: Date.now() + 2000, method: 'POST', headers: { Authorization: 'synthetic-secret' }, body: Readable.from([Buffer.from('synthetic-body')], { objectMode: false }), framing: { mode: 'fixed' as const, length: 14 } };
    return { compiler, transport, input };
  }
  function source(bytes: number, produced?: (bytes: number) => void): Readable {
    let offset = 0;
    return new Readable({ highWaterMark: 65536, read() {
      if (offset >= bytes) { this.push(null); return; }
      const size = Math.min(65536, bytes - offset); offset += size; produced?.(offset); this.push(Buffer.alloc(size, 97));
    } });
  }
  async function consume(body: Readable): Promise<{ bytes: number; digest: string }> {
    let bytes = 0; const hash = createHash('sha256');
    for await (const chunk of body) { bytes += chunk.length; hash.update(chunk); }
    return { bytes, digest: hash.digest('hex') };
  }
  it.each([false, true])('uploads/downloads 24 MiB with backpressure, TLS=%s', async useTls => {
    const size = 24 * 1024 * 1024; let uploadProduced = 0, downloadProduced = 0;
    uploadPauseMs = 150;
    handler = (_req, res) => { res.setHeader('Content-Length', String(size)); const output = source(size, n => { downloadProduced = n; }); res.once('close', () => output.destroy()); output.pipe(res); };
    const { transport, input } = setup({ tls: useTls, trust: useTls });
    const upload = source(size, n => { uploadProduced = n; });
    const pending = transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: size }, deadline: Date.now() + 10000 });
    await delay(60); expect(uploadProduced).toBeLessThan(size);
    const response = await pending; await delay(60); expect(downloadProduced).toBeLessThan(size); expect(response.body.readableLength).toBeLessThanOrEqual(131072);
    const downloaded = await consume(response.body), complete = await response.completed;
    expect(downloaded.bytes).toBe(size); expect(seenBody.length).toBe(size); expect(downloaded.digest).toBe(createHash('sha256').update(seenBody).digest('hex'));
    expect(complete).toMatchObject({ requestBytes: size, responseBytes: size }); expect(lastAuthorization).toBe('synthetic-secret');
    expect(lastHost).toBe(`fixture.test:${useTls ? tlsPort : httpPort}`); if (useTls) expect(lastSni).toBe('fixture.test');
  }, 15000);
  it.each(['fixed', 'chunked'])('preserves framing for streamed GET: %s', async mode => {
    let framing: http.IncomingHttpHeaders = {}; handler = (req, res) => { framing = req.headers; res.end('ok'); };
    const { transport, input } = setup();
    const response = await transport.send({ ...input, method: 'GET', framing: mode === 'fixed' ? { mode: 'fixed', length: 14 } : { mode: 'chunked' } });
    await consume(response.body); await response.completed;
    expect(seenBody.toString()).toBe('synthetic-body');
    expect(framing['content-length']).toBe(mode === 'fixed' ? '14' : undefined); expect(framing['transfer-encoding']).toBe(mode === 'chunked' ? 'chunked' : undefined);
  });
  it.each(['none', 'fixed', 'chunked'])('empty request framing %s', async mode => {
    const { transport, input } = setup();
    const response = await transport.send({ ...input, method: 'GET', body: mode === 'chunked' ? source(0) : undefined, framing: mode === 'fixed' ? { mode: 'fixed', length: 0 } : { mode } as any });
    await consume(response.body); expect((await response.completed).requestBytes).toBe(0);
  });
  it('does not read any body before DNS authorization', async () => {
    let reads = 0; const upload = source(32, () => reads++), { transport, input } = setup({ public: true });
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(reads).toBe(0); expect(upload.destroyed).toBe(true); expect(connections).toBe(0); expect(plaintextBytes).toBe(0);
  });
  it('does not read during a pending TLS handshake and destroys source on cancellation', async () => {
    handshakeDelay = 200; let reads = 0; const upload = source(32, () => reads++), controller = new AbortController();
    const { transport, input } = setup({ tls: true, trust: true });
    const pending = transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 }, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await delay(60); expect(reads).toBe(0); expect(requests).toBe(0); expect(plaintextBytes).toBe(0); controller.abort(); await rejected; expect(upload.destroyed).toBe(true);
  });
  it.each([false, true])('different real peer gets zero body reads and HTTP bytes, TLS=%s', async useTls => {
    dnsAddress = '127.0.0.2'; let reads = 0; const upload = source(32, () => reads++);
    const { transport, input } = setup({ tls: useTls, trust: true, addresses: ['127.0.0.2'] });
    if (useTls) { const original = tls.connect; jest.spyOn(require('node:tls') as typeof tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => original({ ...options, host: '127.0.0.1' })) as typeof tls.connect); }
    else { const original = net.createConnection; jest.spyOn(require('node:net') as typeof net, 'createConnection').mockImplementation(((options: net.NetConnectOpts) => original({ ...options as net.TcpNetConnectOpts, host: '127.0.0.1' })) as typeof net.createConnection); }
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    await delay(20); expect(connections).toBe(1); expect(reads).toBe(0); expect(requests).toBe(0); expect(plaintextBytes).toBe(0); expect(upload.destroyed).toBe(true);
  });
  it.each(['untrusted', 'wrong-host', 'expired'])('TLS/expiry denial %s reads zero body', async mode => {
    if (mode === 'expired') handshakeDelay = 150;
    let reads = 0; const upload = source(32, () => reads++);
    const { transport, input } = setup({ tls: true, trust: mode !== 'untrusted', host: mode === 'wrong-host' ? 'wrong.test' : undefined, expiry: mode === 'expired' ? Date.now() + 60 : undefined });
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(reads).toBe(0); expect(plaintextBytes).toBe(0); expect(upload.destroyed).toBe(true);
  });
  it.each([13, 15])('rejects fixed-length mismatch %s and stops source', async length => {
    const { transport, input } = setup(); await expect(transport.send({ ...input, framing: { mode: 'fixed', length } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(input.body.destroyed).toBe(true);
  });
  it('destroys an in-flight upload on cancellation and never retries a source', async () => {
    uploadPauseMs = 1000; const upload = source(512 * 1024 * 1024), controller = new AbortController(), { transport, input } = setup();
    const pending = transport.send({ ...input, body: upload, framing: { mode: 'chunked' }, signal: controller.signal }); const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await delay(60); controller.abort(); await rejected; expect(upload.destroyed).toBe(true);
    const queries = dnsQueries; await expect(transport.send({ ...input, body: upload, framing: { mode: 'chunked' } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(queries);
  });
  it.each(['abort', 'deadline', 'consumer-close'])('destroys response and upstream on %s', async mode => {
    let closed = false; handler = (_req, res) => { res.on('close', () => { closed = true; }); res.write('partial'); };
    const { transport, input } = setup(), controller = new AbortController();
    const response = await transport.send({ ...input, signal: controller.signal, deadline: Date.now() + 250 });
    const rejected = expect(response.completed).rejects.toMatchObject({ code: mode === 'deadline' ? 'ETIMEDOUT' : 'ABORT_ERR' });
    if (mode === 'abort') controller.abort(); else if (mode === 'consumer-close') response.body.destroy();
    await rejected; await delay(20); expect(response.body.destroyed).toBe(true); expect(closed).toBe(true);
  });
  it('DNS timeout cancels ownership with no body read or target connection', async () => {
    dnsSilent = true; let reads = 0; const upload = source(32, () => reads++), { transport, input } = setup();
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 }, deadline: Date.now() + 40 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(reads).toBe(0); expect(upload.destroyed).toBe(true); expect(connections).toBe(0);
  });
  it('pre-aborted input destroys owned body without DNS or reading', async () => {
    let reads = 0; const upload = source(32, () => reads++), { transport, input } = setup(), controller = new AbortController(); controller.abort();
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 32 }, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(reads).toBe(0); expect(upload.destroyed).toBe(true); expect(dnsQueries).toBe(0);
  });
  it('source failures are sanitized and destroy the upload', async () => {
    const upload = new Readable({ read() { this.destroy(new Error('synthetic-secret-private-url')); } }), { transport, input } = setup();
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'chunked' } })).rejects.toMatchObject({ message: 'upstream_network_policy_unavailable' }); expect(upload.destroyed).toBe(true);
  });
  it('early upstream response cancels a still-active upload without exposing a success', async () => {
    plain.removeAllListeners('request'); plain.on('request', (_req, res) => { res.writeHead(413); res.flushHeaders(); res.write('stop'); });
    const upload = source(512 * 1024 * 1024), { transport, input } = setup();
    await expect(transport.send({ ...input, body: upload, framing: { mode: 'chunked' } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(upload.destroyed).toBe(true);
  });
  it('truncated upstream body fails body/completion and closes the exchange', async () => {
    handler = (_req, res) => { res.setHeader('Content-Length', '100'); res.end('short'); };
    const { transport, input } = setup(), response = await transport.send(input);
    const completion = expect(response.completed).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' });
    await expect(consume(response.body)).rejects.toMatchObject({ code: 'upstream_network_policy_unavailable' }); await completion;
  });
  it.each(['HEAD', '304'])('preserves bodyless %s representation metadata', async mode => {
    handler = (_req, res) => { res.statusCode = mode === '304' ? 304 : 200; res.setHeader('Content-Length', '99999999'); res.end(); };
    const { transport, input } = setup(), response = await transport.send({ ...input, method: mode === 'HEAD' ? 'HEAD' : 'GET', body: undefined, framing: { mode: 'none' } });
    expect((await consume(response.body)).bytes).toBe(0); expect((await response.completed).responseBytes).toBe(0); expect(response.headers['content-length']).toBe('99999999');
  });
  it.each(['agent', 'socket', 'lookup', 'proxy', 'transport'])('rejects external %s before DNS', async key => {
    const { transport, input } = setup(); await expect(transport.send({ ...input, [key]: true } as any)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(dnsQueries).toBe(0); input.body.destroy();
  });
  it('returns one 3xx and never consumes a second destination', async () => {
    handler = (_req, res) => { res.statusCode = 307; res.setHeader('Location', `http://127.0.0.1:${proxyPort}/trap`); res.end('one-hop'); };
    const { transport, input } = setup(), response = await transport.send(input); await consume(response.body); await response.completed;
    expect(response.statusCode).toBe(307); expect(requests).toBe(1); expect(dnsQueries).toBe(2);
  });
  it('does not put a private writable connection in the caller-owned source pipe state', async () => {
    let emitted = false; const pipeCounts: number[] = [];
    const upload = new Readable({ read() { pipeCounts.push((this as any)._readableState.pipes.length); if (emitted) this.push(null); else { emitted = true; this.push(Buffer.from('body')); } } });
    const { transport, input } = setup(), response = await transport.send({ ...input, body: upload, framing: { mode: 'fixed', length: 4 } });
    await consume(response.body); await response.completed; expect(pipeCounts.length).toBeGreaterThan(0); expect(pipeCounts.every(count => count === 0)).toBe(true);
  });
  it('exposes only a Readable byte stream, never the private IncomingMessage through unpipe events', async () => {
    const { transport, input } = setup(), response = await transport.send(input), unpipe = jest.fn();
    response.body.on('unpipe', unpipe); await consume(response.body); await response.completed;
    expect(unpipe).not.toHaveBeenCalled(); expect((response.body as any).socket).toBeUndefined(); expect((response.body as any).write).toBeUndefined();
    expect(Object.keys(response).sort()).toEqual(['body', 'completed', 'headers', 'rawHeaders', 'statusCode']);
  });
  it('provides trailers as completion metadata without adding them to response headers', async () => {
    handler = (_req, res) => { res.setHeader('Trailer', 'X-Tail'); res.write('body'); res.addTrailers({ 'X-Tail': 'tail' }); res.end(); };
    const { transport, input } = setup(), response = await transport.send(input); await consume(response.body);
    expect((await response.completed).rawTrailers).toEqual(['X-Tail', 'tail']); expect(response.headers['x-tail']).toBeUndefined();
  });
  it('strict headers/framing reject before DNS without reading source', async () => {
    const { transport, input } = setup(); let reads = 0; const upload = source(32, () => reads++);
    await expect(transport.send({ ...input, body: upload, headers: { 'Transfer-Encoding': 'chunked' }, framing: { mode: 'fixed', length: 32 } })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(reads).toBe(0); expect(dnsQueries).toBe(0); upload.destroy();
  });
  it('ignores proxy environment for real TLS streams', async () => {
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']; const saved = names.map(name => [name, process.env[name]] as const);
    try {
      for (const name of names) process.env[name] = name === 'NODE_USE_ENV_PROXY' ? '1' : name.toLowerCase() === 'no_proxy' ? 'unrelated.test' : `http://127.0.0.1:${proxyPort}`;
      const { transport, input } = setup({ tls: true, trust: true }), response = await transport.send(input); await consume(response.body); await response.completed; expect(requests).toBe(1); expect(proxyConnections).toBe(0);
    } finally { for (const [name, old] of saved) if (old === undefined) delete process.env[name]; else process.env[name] = old; }
  });
});
