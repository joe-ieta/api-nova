import * as http from 'node:http';
import * as net from 'node:net';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import express = require('express');
import { compileHeaderPolicyV1, UpstreamCredentialRegistry } from 'api-nova-parser';
import { createGatewayUpstreamCredentialResolver, GatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';

const listen = (server: net.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: net.Server) => new Promise<void>(resolve => { (server as http.Server).closeAllConnections?.(); server.close(() => resolve()); });
const request = (port: number, method = 'GET', headers: http.OutgoingHttpHeaders = {}, body?: Buffer) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: '/wire', headers }, res => {
    const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
  }); req.on('error', reject); req.end(body);
});

describe('Gateway explicit compiled Header v1 real wire', () => {
  let upstream: http.Server; let gateway: http.Server; let port: number;
  let handler: http.RequestListener; let route: any; let hits: number; let errors: any[]; let trailerAudit: jest.Mock; let noCredential: boolean; let resolverFailure: boolean; let actualRegistry: GatewayUpstreamCredentialResolver | undefined; let registryPolicy: any; let resolverCalls: number; let preparationRequired: boolean;
  beforeEach(async () => {
    hits = 0; errors = []; actualRegistry = undefined; registryPolicy = undefined; resolverCalls = 0; preparationRequired = false; noCredential = false; resolverFailure = false; trailerAudit = jest.fn().mockResolvedValue(undefined); handler = (_req, res) => res.end('ok');
    upstream = http.createServer((req, res) => { hits++; handler(req, res); });
    const upstreamPort = await listen(upstream);
    route = { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, params: {}, runtimeAsset: { id: 'r' }, membership: { id: 'm' },
      endpointDefinition: { id: 'e' }, sourceServiceAsset: { id: 's' }, sourceServiceInstance: { id: 'i' },
      routeBinding: { id: 'binding', upstreamPath: '/target', upstreamMethod: 'GET' },
      policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: { compiledHeaderPolicy: compileHeaderPolicyV1({
        sourceId: 'test', policy: { version: 1, requestHeaders: ['x-business'], responseHeaders: ['x-result'] },
      }) } } };
    const capture = { createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) };
    const proxy = new GatewayProxyEngineService(capture as any, { headerPolicyEnabled: true, resolve: async (resolved, target, method) => { resolverCalls++; if (actualRegistry) return actualRegistry.resolve(resolved, target, method); if (resolverFailure) throw new Error('sensitive-provider-detail'); return { compiledHeaderPolicy: registryPolicy, historicalAuthenticationHeaderNames: ['x-retired'], headers: noCredential ? {} : { authorization: 'Bearer private-upstream' }, credentialHeaderNames: noCredential ? [] : ['authorization'], managedHeaderNames: ['authorization', 'x-old-key'] }; } }, { recordPolicyObservabilityEvent: trailerAudit } as any);
    const app = express();
    app.use((req, res) => { preparationRequired = proxy.requiresPreparation(route); void (async () => { const preparedRequest = preparationRequired ? await proxy.prepareRequest(route, req) : undefined; return proxy.forward(route, req, res, { preparedRequest }); })().catch(error => { errors.push(error); if (!res.headersSent) res.status(error.getStatus?.() ?? 500).end(error.message); else res.destroy(); }); });
    gateway = http.createServer(app); port = await listen(gateway);
  });
  afterEach(async () => { if (gateway) await close(gateway); if (upstream) await close(upstream); });

  it('filters both directions and rebuilds peer metadata before trusted credential injection', async () => {
    let seen: http.IncomingHttpHeaders = {};
    handler = (req, res) => { seen = req.headers; res.setHeader('x-result', 'yes'); res.setHeader('x-secret', 'hidden'); res.setHeader('set-cookie', ['a=1', 'b=2']); res.setHeader('authorization', 'hidden'); res.end('ok'); };
    const output = await request(port, 'GET', { authorization: 'consumer', cookie: 'session', 'x-old-key': 'old', 'x-business': 'yes', 'x-secret': 'no', 'x-forwarded-for': 'forged', 'x-forwarded-proto': 'https' });
    expect(output.status).toBe(200); expect(seen.authorization === 'Bearer private-upstream').toBe(true);
    expect(seen['x-business']).toBe('yes'); expect(seen['x-secret']).toBeUndefined(); expect(seen.cookie).toBeUndefined(); expect(seen['x-old-key']).toBeUndefined();
    expect(seen['x-forwarded-for']).toBe('127.0.0.1'); expect(seen['x-forwarded-proto']).toBe('http');
    expect(output.headers['x-result']).toBe('yes'); expect(output.headers['x-secret']).toBeUndefined(); expect(output.headers['set-cookie']).toBeUndefined(); expect(output.headers.authorization).toBeUndefined();
  });
  it('real Registry opt-in enforces Endpoint allowlist and injected credential on HTTP', async () => {
    const store = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'registry-secret' }) });
    const address = new URL(route.upstreamBaseUrl);
    await store.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'wire-v1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'x-managed' }, secretRef: 'env:FIXTURE' } }, sites: [{ id: 'site', sourceServiceAssetId: 's', match: { scheme: 'http', host: '127.0.0.1', port: Number(address.port), basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', headerPolicy: { version: 1, requestHeaders: ['x-site'], responseHeaders: ['x-result'] }, endpoints: [{ endpointDefinitionId: 'e', headerPolicy: { version: 1, requestHeaders: ['x-business'] } }] }] });
    actualRegistry = createGatewayUpstreamCredentialResolver(() => store.captureSnapshot(), { enableHeaderPolicy: true });
    delete route.policies.upstream.compiledHeaderPolicy;
    let seen: http.IncomingHttpHeaders = {};
    handler = (req, res) => { seen = req.headers; res.setHeader('x-result', 'yes'); res.setHeader('x-hidden', 'no'); res.end('ok'); };
    const output = await request(port, 'GET', { 'x-business': 'yes', 'x-site': 'no', 'x-managed': 'forged' });
    expect(output.status).toBe(200); expect(resolverCalls).toBe(1);
    expect(seen['x-business']).toBe('yes'); expect(seen['x-site']).toBeUndefined(); expect(seen['x-managed']).toBe('registry-secret');
    expect(output.headers['x-result']).toBe('yes'); expect(output.headers['x-hidden']).toBeUndefined();
  });
  it('consumes one Registry exchange for both wire directions without mutating route', async () => {
    registryPolicy = route.policies.upstream.compiledHeaderPolicy;
    delete route.policies.upstream.compiledHeaderPolicy;
    let seen: http.IncomingHttpHeaders = {};
    handler = (req, res) => { seen = req.headers; res.setHeader('x-result', 'allowed'); res.setHeader('x-secret', 'stripped'); res.end('ok'); };
    const output = await request(port, 'GET', { 'x-business': 'yes', 'x-secret': 'no', 'x-retired': 'never-forward' });
    expect(output.status).toBe(200); expect(preparationRequired).toBe(true); expect(resolverCalls).toBe(1);
    expect(seen['x-business']).toBe('yes'); expect(seen['x-secret']).toBeUndefined(); expect(seen['x-retired']).toBeUndefined();
    expect(output.headers['x-result']).toBe('allowed'); expect(output.headers['x-secret']).toBeUndefined();
    expect(route.policies.upstream.compiledHeaderPolicy).toBeUndefined();
  });
  it('rejects simultaneous Registry and route policy before an upstream connection', async () => {
    registryPolicy = route.policies.upstream.compiledHeaderPolicy;
    expect((await request(port)).status).toBe(503); expect(hits).toBe(0);
    expect(errors[0].message).toBe('gateway_header_policy_source_conflict');
  });
  it('retired Registry authentication names cannot become extensions', async () => {
    registryPolicy = compileHeaderPolicyV1({ sourceId: 'stale-policy', policy: { version: 1, requestHeaders: ['x-retired'] } });
    delete route.policies.upstream.compiledHeaderPolicy;
    let seen: http.IncomingHttpHeaders = {}; handler = (req, res) => { seen = req.headers; res.end('ok'); };
    expect((await request(port, 'GET', { 'x-retired': 'secret' })).status).toBe(200); expect(seen['x-retired']).toBeUndefined();
  });
  it('preserves compressed request and response bytes without decoding', async () => {
    const payload = gzipSync(Buffer.from('compressed-原文'.repeat(300))); let observed = Buffer.alloc(0);
    route.routeBinding.upstreamMethod = 'POST';
    handler = (req, res) => { const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { observed = Buffer.concat(chunks); res.setHeader('content-encoding', 'gzip'); res.setHeader('content-length', payload.length); res.end(payload); }); };
    const output = await request(port, 'POST', { 'content-encoding': 'gzip', 'content-length': payload.length }, payload);
    expect(observed.equals(payload)).toBe(true); expect(output.body.equals(payload)).toBe(true); expect(output.headers['content-encoding']).toBe('gzip');
  });
  it.each([['HEAD', 200, '99'], ['GET', 304, '99'], ['GET', 204, undefined]])('handles %s %s metadata without expecting body bytes', async (method, status, length) => {
    route.routeBinding.upstreamMethod = method;
    handler = (_req, res) => { res.statusCode = status; if (length) res.setHeader('content-length', length); res.end(); };
    const output = await request(port, method); expect(output.status).toBe(status); expect(output.body.length).toBe(0); expect(output.headers['content-length']).toBe(length); expect(errors).toHaveLength(0);
  });
  it('rejects duplicate singleton before connecting upstream', async () => {
    const output = await request(port, 'GET', { 'x-business': ['a', 'b'] });
    expect(output.status).toBe(400); expect(hits).toBe(0);
  });
  it('rejects invalid upstream 204 framing before headers reach client', async () => {
    handler = (_req, res) => { res.statusCode = 204; res.setHeader('content-length', '2'); res.end(); };
    const output = await request(port); expect(output.status).toBe(502);
  });
  it('rejects duplicate allowed upstream singleton before forwarding', async () => {
    handler = (_req, res) => { res.setHeader('x-result', ['a', 'b']); res.end('ok'); };
    const output = await request(port); expect(output.status).toBe(502);
  });
  it('drops undeclared response trailers', async () => {
    handler = (_req, res) => { res.write('ok'); res.addTrailers({ 'x-tail': 'not-forwarded' }); res.end(); };
    const output = await request(port); expect(output.status).toBe(200); expect(output.body.toString()).toBe('ok'); expect(output.headers['x-tail']).toBeUndefined(); expect(trailerAudit).toHaveBeenCalledWith(expect.objectContaining({ policyName: 'gateway.header_trailers_discarded', errorMessage: 'response_trailers_discarded' }));
  });
  it('fails a truncated upstream stream without appending a second response', async () => {
    handler = (_req, res) => { res.setHeader('content-length', '20'); res.write('short'); setTimeout(() => res.destroy(), 20); };
    await expect(request(port)).rejects.toBeDefined();
  });
  it('rejects an early final response while the request body is incomplete', async () => {
    route.routeBinding.upstreamMethod = 'POST';
    handler = (_req, res) => res.end('premature-success');
    const result = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/wire', headers: { 'content-length': '20' } }, res => {
        res.resume(); res.on('end', () => { resolve(res.statusCode!); req.destroy(); });
      }); req.on('error', reject); req.write('short');
    });
    expect(result).toBe(502); expect(errors[0].message).toBe('gateway_header_early_response');
  });
  it('maps native malformed upstream framing to a fixed 502', async () => {
    handler = (_req, res) => res.socket!.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nab');
    const output = await request(port); expect(output.status).toBe(502); expect(output.body.toString()).toBe('gateway_header_upstream_parse');
  });
  it('refuses nonfinal upstream responses and never forwards their final success', async () => {
    handler = (_req, res) => { res.writeEarlyHints({ link: '</a>; rel=preload' }); res.end('must-not-forward'); };
    const output = await request(port); expect(output.status).toBe(502); expect(output.body.toString()).not.toContain('must-not-forward');
  });

  it('strips Connection-nominated business fields but injects trusted credentials last', async () => {
    let seen: http.IncomingHttpHeaders = {};
    handler = (req, res) => { seen = req.headers; res.end('ok'); };
    const output = await request(port, 'GET', { connection: 'x-business, authorization', 'x-business': 'discard', authorization: 'consumer' });
    expect(output.status).toBe(200); expect(seen['x-business']).toBeUndefined(); expect(seen.authorization === 'Bearer private-upstream').toBe(true);
  });
  it('None removes all managed names without injecting credentials', async () => {
    noCredential = true; let seen: http.IncomingHttpHeaders = {};
    handler = (req, res) => { seen = req.headers; res.end('ok'); };
    const output = await request(port, 'GET', { authorization: 'consumer', 'x-old-key': 'retired' });
    expect(output.status).toBe(200); expect(seen.authorization).toBeUndefined(); expect(seen['x-old-key']).toBeUndefined();
  });
  it('resolver failure returns fixed 503 with no upstream connection', async () => {
    resolverFailure = true; const output = await request(port); expect(output.status).toBe(503); expect(hits).toBe(0);
    expect(output.body.toString()).toBe('gateway_upstream_credential_unavailable');
  });
  it.each(['Content-Length: 2\r\nTransfer-Encoding: chunked', 'Content-Length: 2\r\nContent-Length: 2'])('rejects ambiguous ingress framing before upstream connection: %s', async framing => {
    const output = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1'); let data = '';
      socket.on('data', chunk => { data += chunk.toString(); }); socket.on('error', reject); socket.on('close', () => resolve(data));
      socket.on('connect', () => socket.write('POST /wire HTTP/1.1\r\nHost: localhost\r\n' + framing + '\r\nConnection: close\r\n\r\nab'));
    });
    expect(output).toContain('400 Bad Request'); expect(hits).toBe(0);
  });

  it('streams large chunked bodies in both directions with bounded producers and backpressure', async () => {
    route.routeBinding.upstreamMethod = 'POST'; route.policies.traffic.timeoutMs = 5000;
    const chunk = Buffer.alloc(64 * 1024); for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
    const count = 64, total = chunk.length * count;
    const expectedHash = createHash('sha256'); for (let i = 0; i < count; i++) expectedHash.update(chunk);
    const digest = expectedHash.digest('hex');
    let upstreamBytes = 0, upstreamDigest = '', upstreamHeaders: http.IncomingHttpHeaders = {};
    let requestBackpressure = 0, responseBackpressure = 0;
    handler = (req, res) => {
      upstreamHeaders = req.headers; const hash = createHash('sha256');
      req.on('data', data => { upstreamBytes += data.length; hash.update(data); });
      req.on('end', () => {
        upstreamDigest = hash.digest('hex'); let remaining = count;
        const produce = () => {
          while (remaining > 0) { remaining--; if (!res.write(chunk)) { responseBackpressure++; res.once('drain', produce); return; } }
          res.end();
        }; produce();
      });
    };
    const output = await new Promise<{ bytes: number; digest: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/wire', headers: { 'content-type': 'application/octet-stream' } }, res => {
        let bytes = 0; const hash = createHash('sha256');
        res.on('data', data => { bytes += data.length; hash.update(data); }); res.on('error', reject);
        res.on('end', () => resolve({ bytes, digest: hash.digest('hex'), headers: res.headers }));
      }); req.on('error', reject); let remaining = count;
      const produce = () => {
        while (remaining > 0) { remaining--; if (!req.write(chunk)) { requestBackpressure++; req.once('drain', produce); return; } }
        req.end();
      }; produce();
    });
    expect(upstreamHeaders['content-length']).toBeUndefined(); expect(upstreamHeaders['transfer-encoding']).toBe('chunked');
    expect(output.headers['content-length']).toBeUndefined(); expect(output.headers['transfer-encoding']).toBe('chunked');
    expect(upstreamBytes).toBe(total); expect(output.bytes).toBe(total); expect(upstreamDigest).toBe(digest); expect(output.digest).toBe(digest);
    expect(requestBackpressure).toBeGreaterThan(0); expect(responseBackpressure).toBeGreaterThan(0); expect(errors).toHaveLength(0);
  });
  it('terminates a live upstream stream promptly after the client disconnects', async () => {
    let timer: ReturnType<typeof setInterval> | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false; let writes = 0; let closed!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    handler = (_req, res) => {
      res.once('close', () => { if (timer) clearInterval(timer); stopped = true; closed(); });
      timer = setInterval(() => { writes++; res.write(Buffer.alloc(4096, 1)); }, 5);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/wire' }, res => {
          res.once('data', () => { res.destroy(); req.destroy(); resolve(); }); res.on('error', () => undefined);
        }); req.on('error', reject);
      });
      await Promise.race([upstreamClosed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('upstream did not close')), 1500); })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(true); expect(writes).toBeGreaterThan(0); expect(writes).toBeLessThan(100);
      expect(errors.some(error => error.code === 'ABORT_ERR')).toBe(true);
    } finally { if (timer) clearInterval(timer); if (timeout) clearTimeout(timeout); }
  });

  it('uses a separate upstream connection for each explicit v1 exchange', async () => {
    const sockets: net.Socket[] = [];
    handler = (req, res) => { sockets.push(req.socket); res.end('ok'); };
    expect((await request(port)).status).toBe(200); expect((await request(port)).status).toBe(200);
    expect(sockets).toHaveLength(2); expect(sockets[0]).not.toBe(sockets[1]);
  });

});
