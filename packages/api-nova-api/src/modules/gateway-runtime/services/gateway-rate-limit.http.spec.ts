import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushRuntimeAudit } from 'api-nova-parser';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';

// Real sockets, real authorization, policy compilation, admission, cache and upstream.
// Only persistence/metrics are replaced; no production listener or database is used.
describe('Gateway independent rate limits over HTTP', () => {
  let gateway: http.Server;
  let upstream: http.Server;
  let base: string;
  let route: any;
  let upstreamCalls: number;
  let events: any;
  let repository: any;
  let directory: string;
  let oldAudit: string | undefined;

  beforeAll(async () => {
    await flushRuntimeAudit();
    oldAudit = process.env.API_NOVA_AUDIT_DIR;
    directory = await mkdtemp(join(tmpdir(), 'gateway-rate-limit-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
  });
  afterAll(async () => {
    await flushRuntimeAudit();
    if (oldAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR;
    else process.env.API_NOVA_AUDIT_DIR = oldAudit;
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    route = {
      runtimeAsset: { id: 'runtime-1' }, membership: { id: 'membership-1' },
      endpointDefinition: { id: 'endpoint-1' }, publishBinding: { publishedToHttp: true },
      sourceServiceAsset: { id: 'source-1' }, sourceServiceInstance: { id: 'instance-1' }, params: {},
      upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      routeBinding: { id: 'route-1', routePath: '/orders', routeMethod: 'GET',
        upstreamPath: '/orders', upstreamMethod: 'GET', routeVisibility: 'external' },
    };
    configure({ ipMax: 2 });
    repository = {
      findOne: jest.fn(async ({ where }: any) => where.keyId === 'valid' ? {
        id: 'consumer-1', keyId: 'valid', secretHash: createHash('sha256').update('secret').digest('hex'),
      } : null),
      save: jest.fn(async (value: any) => value),
    };
    events = { recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined) };
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult',
      'recordForwardResult', 'recordPolicyObservabilityEvent'].map(key => [key, jest.fn().mockResolvedValue(undefined)]));
    const runtime = new GatewayRuntimeService(
      { resolve: () => route } as any,
      new GatewaySecurityService({ log: jest.fn() } as any, repository),
      new GatewayTrafficControlService(events, metrics), new GatewayCacheService(),
      new GatewayProxyEngineService(new GatewayRequestCaptureService()),
      { recordRequest: jest.fn().mockResolvedValue(undefined) } as any, metrics,
    );
    gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url;
      (req as any).protocol = 'http';
      (res as any).status = (code: number) => { res.statusCode = code; return res; };
      try { await runtime.forwardRequest('/orders', req as any, res as any); }
      catch (error: any) { res.writeHead(error.getStatus?.() || 500); res.end(error.message); }
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/orders`;
  });
  afterEach(async () => {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())),
      new Promise<void>(resolve => upstream.close(() => resolve()))]);
    await flushRuntimeAudit();
  });
  function configure(limits: Record<string, number>, auth = 'anonymous') {
    route.policies = new GatewayPolicyService().compileForRoute({ ...route.routeBinding,
      authPolicyRef: auth, timeoutMs: 3000, cachePolicyRef: 'cache-readonly',
      upstreamConfig: { trafficControl: { rateLimit: { windowMs: 60000, ...limits } },
        cache: { ttlMs: 60000, maxBodyBytes: 4096 } },
    } as any);
  }
  async function request(headers: Record<string, string> = {}) {
    const response = await fetch(base, { headers });
    const body = await response.text();
    if (response.status === 500) throw new Error(body);
    return { status: response.status, cache: response.headers.get('x-apinova-cache') };
  }
  function rejectedKey() {
    return events.recordRuntimeControlEvent.mock.calls.at(-1)[0].details.limitKey;
  }

  it('counts a response-cache hit and ignores spoofed forwarded client addresses', async () => {
    expect((await request({ 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
    expect(await request({ forwarded: 'for=198.51.100.2' })).toMatchObject({ status: 200, cache: 'HIT' });
    expect((await request({ 'x-forwarded-for': '198.51.100.3', 'x-real-ip': '198.51.100.4' })).status).toBe(429);
    expect(rejectedKey()).toBe('ip:route-1:127.0.0.1');
    expect(upstreamCalls).toBe(1);
  });

  it('enforces the anonymous bucket independently and does not charge it to authenticated callers', async () => {
    configure({ ipMax: 3, anonymousMax: 1, consumerMax: 10 });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    expect(rejectedKey()).toBe('anonymous:route-1');
    configure({ ipMax: 3, anonymousMax: 1, consumerMax: 10 }, 'api-key-default');
    expect((await request({ 'x-api-key': 'valid.secret' })).status).toBe(200);
    expect(await request({ 'x-api-key': 'valid.secret' })).toMatchObject({ status: 200, cache: 'HIT' });
    expect((await request({ 'x-api-key': 'valid.secret' })).status).toBe(429);
    expect(rejectedKey()).toBe('ip:route-1:127.0.0.1');
    expect(repository.findOne).toHaveBeenCalledTimes(3);
    expect(upstreamCalls).toBe(2);
  });

  it('authenticates before cache and admission, even after warming an authenticated response cache entry', async () => {
    configure({ ipMax: 2 }, 'api-key-default');
    expect((await request({ 'x-api-key': 'valid.secret' })).status).toBe(200);
    expect((await request({ 'x-api-key': 'valid.wrong' })).status).toBe(401);
    expect(await request({ 'x-api-key': 'valid.secret' })).toMatchObject({ status: 200, cache: 'HIT' });
    expect((await request({ 'x-api-key': 'valid.secret' })).status).toBe(429);
    expect(repository.findOne).toHaveBeenCalledTimes(4);
    expect(upstreamCalls).toBe(1);
  });

  it('keeps route buckets independent for the same peer', async () => {
    configure({ ipMax: 1, anonymousMax: 1 });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    route.routeBinding.id = 'route-2';
    expect((await request()).status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });
});
