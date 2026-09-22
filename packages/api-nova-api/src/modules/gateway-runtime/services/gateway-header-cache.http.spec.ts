import * as http from 'node:http';
import * as net from 'node:net';
import { gzipSync } from 'node:zlib';
import { compileHeaderPolicyV1 } from 'api-nova-parser';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';

const listen = (server: net.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('Header v1 cache over real runtime and HTTP streams', () => {
  let gateway: http.Server, upstream: http.Server, port: number;
  let route: any, cache: GatewayCacheService, hits: number, handler: http.RequestListener;
  let security: any, traffic: any, resolver: jest.Mock;
  const compile = (requestHeaders = ['x-business'], responseHeaders: string[] = []) => compileHeaderPolicyV1({ sourceId: 'route:header-cache', policy: { version: 1, requestHeaders, responseHeaders } });
  beforeEach(async () => {
    hits = 0;
    handler = (_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('entity'); };
    upstream = http.createServer((req, res) => { hits++; handler(req, res); });
    const upstreamPort = await listen(upstream);
    route = { runtimeAsset: { id: 'runtime' }, membership: { id: 'member' }, endpointDefinition: { id: 'endpoint' },
      sourceServiceAsset: { id: 'source' }, sourceServiceInstance: { id: 'instance' }, params: {},
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      routeBinding: { id: 'binding', routePath: '/wire', routeMethod: 'GET', upstreamPath: '/upstream', upstreamMethod: 'GET', routeVisibility: 'external' },
      policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } },
        cache: { enabled: true, methods: ['GET', 'POST', 'HEAD'], ttlMs: 60000, maxBodyBytes: 8192, varyHeaderKeys: [], varyQueryKeys: [] },
        upstream: { compiledHeaderPolicy: compile() } } };
    security = { authorize: jest.fn().mockResolvedValue({ mode: 'anonymous' }) };
    traffic = Object.fromEntries(['beforeAttempt', 'recordAttemptSuccess', 'recordAttemptFailure'].map(key => [key, jest.fn().mockResolvedValue(undefined)]));
    traffic.admit = jest.fn().mockResolvedValue({ release: jest.fn() });
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent'].map(key => [key, jest.fn().mockResolvedValue(undefined)]));
    resolver = jest.fn().mockResolvedValue({ headers: {}, credentialHeaderNames: [], managedHeaderNames: ['authorization', 'x-upstream-key'] });
    cache = new GatewayCacheService();
    const proxy = new GatewayProxyEngineService(new GatewayRequestCaptureService(), { resolve: resolver }, metrics);
    const runtime = new GatewayRuntimeService({ resolve: () => route } as any, security, traffic, cache, proxy,
      { recordRequest: jest.fn().mockResolvedValue(undefined) } as any, metrics);
    gateway = http.createServer((req, res) => {
      (req as any).originalUrl = req.url;
      (res as any).status = (status: number) => { res.statusCode = status; return res; };
      void runtime.forwardRequest('/wire', req as any, res as any).catch(error => {
        if (!res.headersSent) { res.statusCode = error.getStatus?.() ?? 500; res.end(error.message); }
        else res.destroy();
      });
    });
    port = await listen(gateway);
  });
  afterEach(async () => { await Promise.all([gateway, upstream].filter(Boolean).map(close)); });
  async function request(headers: http.OutgoingHttpHeaders = {}, path = '/wire', method = 'GET', body?: Buffer) {
    const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      }); req.on('error', reject); req.end(body);
    });
    await new Promise(resolve => setImmediate(resolve));
    return result;
  }
  const hit = (response: { headers: http.IncomingHttpHeaders }) => response.headers['x-apinova-cache'] === 'HIT';

  it('caches None responses while authenticating, admitting and resolving every hit', async () => {
    handler = (req, res) => { expect(req.headers['x-upstream-key']).toBeUndefined(); expect(req.headers.authorization).toBeUndefined(); res.end('none'); };
    const first = await request({ authorization: 'consumer', 'x-upstream-key': 'consumer-upstream' });
    const second = await request({ authorization: 'different-consumer' });
    expect(first.status).toBe(200); expect(hit(first)).toBe(false); expect(hit(second)).toBe(true);
    expect(second.body.toString()).toBe('none'); expect(hits).toBe(1);
    expect(security.authorize).toHaveBeenCalledTimes(2); expect(traffic.admit).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
  });

  it.each(['accept', 'accept-language', 'accept-encoding', 'x-business'])('cannot remove mandatory %s variation using empty configured vary', async name => {
    handler = (req, res) => { res.end(String(req.headers[name] ?? 'missing')); };
    const first = await request({ [name]: 'one' });
    expect(hit(await request({ [name]: 'one' }))).toBe(true);
    const second = await request({ [name]: 'two' });
    expect(hit(second)).toBe(false); expect(second.body.toString()).toBe('two'); expect(hits).toBe(2);
    expect(first.body.toString()).toBe('one');
  });

  it('distinguishes missing and empty business values and uses filtered Connection semantics', async () => {
    handler = (req, res) => res.end(req.headers['x-business'] === undefined ? 'missing' : `value:${req.headers['x-business']}`);
    expect((await request()).body.toString()).toBe('missing');
    const empty = await request({ 'x-business': '' }); expect(hit(empty)).toBe(false); expect(empty.body.toString()).toBe('value:');
    const removed = await request({ connection: 'x-business', 'x-business': 'not-forwarded' });
    expect(hit(removed)).toBe(true); expect(removed.body.toString()).toBe('missing'); expect(hits).toBe(2);
  });

  it('preserves encoded bytes and reconstructs hit length without replaying upstream fields', async () => {
    const zipped = gzipSync(Buffer.from('gzip entity'.repeat(50)));
    handler = (_req, res) => { res.setHeader('content-encoding', 'gzip'); res.setHeader('authorization', 'synthetic-secret'); res.setHeader('connection', 'x-hop'); res.setHeader('x-hop', 'hidden'); res.end(zipped); };
    const first = await request({ 'accept-encoding': 'gzip' }); const second = await request({ 'accept-encoding': 'gzip' });
    expect(first.body.equals(zipped)).toBe(true); expect(second.body.equals(zipped)).toBe(true); expect(hit(second)).toBe(true);
    expect(second.headers['content-encoding']).toBe('gzip'); expect(second.headers['content-length']).toBe(String(zipped.length));
    expect(second.headers.authorization).toBeUndefined(); expect(second.headers['x-hop']).toBeUndefined();
  });

  it('isolates policy identities and clears all entries on snapshot refresh', async () => {
    await request(); expect(hit(await request())).toBe(true);
    route.policies.upstream.compiledHeaderPolicy = compile(['x-business', 'x-extra']);
    expect(hit(await request())).toBe(false); expect(hits).toBe(2);
    cache.handleSnapshotRefreshRequested({ reason: 'test' } as any);
    expect(hit(await request())).toBe(false); expect(hits).toBe(3);
  });

  it.each(['range', 'if-match', 'if-none-match', 'if-future-condition', 'cache-control', 'pragma'])('bypasses cache reads and writes for %s', async name => {
    await request(); await request({ [name]: 'synthetic' }); await request({ [name]: 'synthetic' });
    expect(hits).toBe(3); expect(hit(await request())).toBe(true);
  });

  it('never caches GET bodies, HEAD or POST even if configured cache methods permit them', async () => {
    for (const method of ['GET', 'POST']) {
      route.routeBinding.upstreamMethod = method;
      handler = (req, res) => { req.resume(); req.on('end', () => res.end('body received')); };
      for (let i = 0; i < 2; i++) expect(hit(await request({ 'content-length': 1 }, '/wire', method, Buffer.from('x')))).toBe(false);
    }
    route.routeBinding.upstreamMethod = 'HEAD'; handler = (_req, res) => res.end();
    await request({}, '/wire', 'HEAD'); await request({}, '/wire', 'HEAD'); expect(hits).toBe(6);
  });

  it.each([
    ['set-cookie', 'a=b'], ['pragma', 'no-cache'], ['cache-control', 'private'], ['cache-control', 'no-store'],
    ['cache-control', 'no-cache="x-business"'], ['cache-control', 'max-age=broken'], ['vary', '*'], ['vary', 'x-uncovered'],
  ])('uses raw upstream %s=%s as cache veto even when Connection strips it', async (name, value) => {
    handler = (_req, res) => { res.setHeader(name, value); res.setHeader('connection', name); res.end('uncacheable'); };
    expect(hit(await request())).toBe(false); expect(hit(await request())).toBe(false); expect(hits).toBe(2);
  });

  it.each(['partial', 'sse', 'overflow'])('does not store %s responses', async variant => {
    handler = (_req, res) => {
      if (variant === 'partial') { res.statusCode = 206; res.setHeader('content-range', 'bytes 0-2/6'); }
      if (variant === 'sse') { res.setHeader('content-type', 'text/event-stream'); res.setHeader('connection', 'content-type'); }
      res.end(variant === 'overflow' ? 'x'.repeat(8193) : 'abc');
    };
    await request(); await request(); expect(hits).toBe(2);
  });

  it('never stores an incomplete response stream and recovers with a fresh miss', async () => {
    handler = (_req, res) => { res.setHeader('content-length', '20'); res.write('partial'); setTimeout(() => res.destroy(), 10); };
    await expect(request()).rejects.toBeDefined();
    handler = (_req, res) => res.end('complete');
    const recovered = await request(); expect(hit(recovered)).toBe(false); expect(recovered.body.toString()).toBe('complete');
    expect(hit(await request())).toBe(true); expect(hits).toBe(2);
  });

  it('cannot use a populated hit after authorization or admission rejects', async () => {
    await request();
    security.authorize.mockRejectedValueOnce({ getStatus: () => 403, message: 'denied' });
    expect((await request()).status).toBe(403);
    traffic.admit.mockRejectedValueOnce({ getStatus: () => 429, message: 'limited' });
    expect((await request()).status).toBe(429);
    expect(hits).toBe(1);
  });

  it('accepts Vary covered by mandatory dimensions and keeps caller identity isolated', async () => {
    route.policies.auth.mode = 'api_key'; security.authorize.mockResolvedValue({ mode: 'api_key', consumerId: 'consumer', keyId: 'key-1' });
    handler = (_req, res) => { res.setHeader('vary', 'Accept-Language, X-Business'); res.end('vary'); };
    await request(); expect(hit(await request())).toBe(true);
    security.authorize.mockResolvedValue({ mode: 'api_key', consumerId: 'consumer', keyId: 'key-2' });
    expect(hit(await request())).toBe(false); expect(hits).toBe(2);
  });

  it('validates duplicate business and dynamic authentication fields before a populated cache hit', async () => {
    await request();
    for (const name of ['x-business', 'x-upstream-key']) {
      const response = await request({ [name]: ['a', 'a'] }); expect(response.status).toBe(400); expect(hit(response)).toBe(false);
    }
    expect(hits).toBe(1);
  });

  it('does not serve a hit when current Resolver fails', async () => {
    await request(); resolver.mockRejectedValue(new Error('synthetic-secret'));
    const response = await request(); expect(response.status).toBe(503); expect(hit(response)).toBe(false);
    expect(response.body.toString()).not.toContain('synthetic-secret'); expect(hits).toBe(1);
  });

  it('keys all query parameters with repeated-value order while excluding consumer query secrets', async () => {
    route.policies.cache.varyQueryKeys = ['selected'];
    route.policies.auth.apiKeyQueryParamName = 'consumer_key';
    handler = (req, res) => res.end(req.url);
    const first = await request({}, '/wire?selected=x&extra=one&a=1&a=2&consumer_key=secret-one');
    expect(first.body.toString()).not.toContain('consumer_key');
    expect(hit(await request({}, '/wire?selected=x&extra=one&a=1&a=2&consumer_key=secret-two'))).toBe(true);
    expect(hit(await request({}, '/wire?selected=x&extra=two&a=1&a=2'))).toBe(false);
    expect(hit(await request({}, '/wire?selected=x&extra=one&a=2&a=1'))).toBe(false);
    expect(hits).toBe(3);
    expect(JSON.stringify([...((cache as any).cache as Map<string, unknown>).keys()])).not.toContain('secret-one');
  });
});
