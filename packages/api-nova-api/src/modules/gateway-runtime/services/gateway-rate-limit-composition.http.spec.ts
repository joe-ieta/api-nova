import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { flushRuntimeAudit } from 'api-nova-parser';
import { GatewayConsumerCredentialEntity, GatewayConsumerCredentialStatus } from '../../../database/entities/gateway-consumer-credential.entity';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';

// Real HTTP ingress/upstream and SQLite credential repository. Route selection is a
// fixed fixture; production authorization, policy, admission, cache and proxy run unchanged.
describe('Gateway composed rate limits over HTTP with unified credentials', () => {
  let gateway: http.Server, upstream: http.Server, base: string;
  let database: DataSource, credentials: Repository<GatewayConsumerCredentialEntity>;
  let routes: Map<string, any>, events: any, upstreamCalls: number;
  let directory: string, oldAudit: string | undefined, oldScopes: string | undefined;
  const secret = 'composition-test-secret';
  const keys = { alice: 'alice', successor: 'alice-next', bob: 'bob', otherRuntime: 'other-runtime' };
  const layers = ['globalMax', 'runtimeAssetMax', 'routeMax', 'consumerMax', 'ipMax', 'anonymousMax'];
  const callerId = (subject: string) => createHash('sha256').update(`api-key\0${subject}`).digest('hex');

  beforeAll(async () => {
    await flushRuntimeAudit();
    oldAudit = process.env.API_NOVA_AUDIT_DIR;
    oldScopes = process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    directory = await mkdtemp(join(tmpdir(), 'gateway-composed-limits-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
  });
  afterAll(async () => {
    await flushRuntimeAudit();
    if (oldAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR;
    else process.env.API_NOVA_AUDIT_DIR = oldAudit;
    if (oldScopes === undefined) delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    else process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = oldScopes;
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    database = await new DataSource({ type: 'sqljs', entities: [GatewayConsumerCredentialEntity], synchronize: true }).initialize();
    credentials = database.getRepository(GatewayConsumerCredentialEntity);
    for (const [name, keyId] of Object.entries(keys)) {
      const subject = name === 'successor' ? 'alice' : name;
      await credentials.save(credentials.create({ name, keyId, status: GatewayConsumerCredentialStatus.ACTIVE,
        secretHash: createHash('sha256').update(secret).digest('hex'), runtimeAssetId: name === 'otherRuntime' ? 'runtime-2' : 'runtime-1',
        accessPolicy: { version: 1, subject, protocols: ['gateway'], toolScopes: [], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600,
          ...(subject === 'alice' ? { rotationFamilyId: 'alice-family' } : {}) },
      }));
    }
    upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls++;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    routes = new Map();
    for (const [path, runtimeId] of [['/one', 'runtime-1'], ['/two', 'runtime-1'], ['/three', 'runtime-2']]) {
      const route = {
        runtimeAsset: { id: runtimeId }, membership: { id: `membership${path}` }, endpointDefinition: { id: `endpoint${path}` },
        publishBinding: { publishedToHttp: true }, sourceServiceAsset: { id: 'source-1' }, sourceServiceInstance: { id: 'instance-1' }, params: {},
        upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        routeBinding: { id: `route${path}`, routePath: path, routeMethod: 'GET', upstreamPath: path, upstreamMethod: 'GET', routeVisibility: 'external' },
      };
      routes.set(path, route);
      configure(path, { globalMax: 100 });
    }
    events = { recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined) };
    const metrics: any = Object.fromEntries(['recordPolicyEvent', 'recordCacheResult', 'recordForwardResult', 'recordPolicyObservabilityEvent']
      .map(key => [key, jest.fn().mockResolvedValue(undefined)]));
    const runtime = new GatewayRuntimeService({ resolve: (_host: string, _method: string, path: string) => routes.get(path) } as any,
      new GatewaySecurityService({ log: jest.fn() } as any, credentials), new GatewayTrafficControlService(events, metrics),
      new GatewayCacheService(), new GatewayProxyEngineService(new GatewayRequestCaptureService()),
      { recordRequest: jest.fn().mockResolvedValue(undefined) } as any, metrics);
    gateway = http.createServer(async (req, res) => {
      (req as any).originalUrl = req.url; (req as any).protocol = 'http';
      (res as any).status = (code: number) => { res.statusCode = code; return res; };
      try { await runtime.forwardRequest(req.url!, req as any, res as any); }
      catch (error: any) { res.writeHead(error.getStatus?.() || 500); res.end(error.message); }
    });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    gateway?.closeAllConnections(); upstream?.closeAllConnections();
    await Promise.all([gateway, upstream].filter(Boolean).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await database?.destroy(); await flushRuntimeAudit();
  });
  function configure(path: string, limits: Record<string, number>, auth = 'api-key-default') {
    const route = routes.get(path);
    route.policies = new GatewayPolicyService().compileForRoute({ ...route.routeBinding, authPolicyRef: auth,
      timeoutMs: 3000, cachePolicyRef: 'cache-readonly', upstreamConfig: {
        trafficControl: { rateLimit: { windowMs: 60000, ...limits } }, cache: { ttlMs: 60000, maxBodyBytes: 4096 },
      } } as any);
  }
  async function request(path = '/one', key: string | null = keys.alice) {
    const response = await fetch(base + path, { headers: key ? { 'x-api-key': `${key}.${secret}` } : {} });
    const body = await response.text();
    if (response.status === 500) throw new Error(body);
    return { status: response.status, cache: response.headers.get('x-apinova-cache') };
  }
  function rejection() { return events.recordRuntimeControlEvent.mock.calls.at(-1)[0]; }

  it.each(layers)('enforces %s with every other applicable layer and charges cache hits', async layer => {
    const limits = Object.fromEntries(layers.map(name => [name, name === layer ? 2 : 10]));
    const anonymous = layer === 'anonymousMax';
    configure('/one', limits, anonymous ? 'anonymous' : 'api-key-default');
    const key = anonymous ? null : keys.alice;
    expect((await request('/one', key)).status).toBe(200);
    expect(await request('/one', key)).toEqual({ status: 200, cache: 'HIT' });
    expect((await request('/one', key)).status).toBe(429);
    const expected = { globalMax: 'global', runtimeAssetMax: 'runtime:runtime-1', routeMax: 'route:route/one',
      consumerMax: `consumer:route/one:${callerId('alice')}`, ipMax: 'ip:route/one:127.0.0.1', anonymousMax: 'anonymous:route/one' };
    expect(rejection()).toMatchObject({ eventName: 'gateway.rate_limit_rejected', runtimeAssetId: 'runtime-1',
      details: { limitKey: expected[layer], limit: 2, windowMs: 60000 }, dimensions: { limitKey: expected[layer] } });
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(events.recordRuntimeControlEvent.mock.calls)).not.toContain(secret);
  });

  it.each(['globalMax', 'runtimeAssetMax', 'routeMax', 'consumerMax', 'ipMax'])('reports the first saturated layer starting at %s', async layer => {
    const start = layers.indexOf(layer);
    configure('/one', Object.fromEntries(layers.map((name, index) => [name, index >= start ? 1 : 10])));
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    expect(rejection().details.limitKey.split(':')[0]).toBe(['global', 'runtime', 'route', 'consumer', 'ip'][start]);
  });

  it('shares global capacity across routes and runtimes', async () => {
    for (const path of routes.keys()) configure(path, { globalMax: 2, runtimeAssetMax: 10, routeMax: 10 });
    expect((await request('/one')).status).toBe(200);
    expect((await request('/three', keys.otherRuntime)).status).toBe(200);
    expect((await request('/two')).status).toBe(429);
    expect(rejection().details.limitKey).toBe('global');
  });

  it('shares runtime capacity across its routes while keeping other runtimes independent', async () => {
    for (const path of routes.keys()) configure(path, { globalMax: 10, runtimeAssetMax: 1, routeMax: 10 });
    expect((await request('/one')).status).toBe(200);
    expect((await request('/two')).status).toBe(429);
    expect(rejection().details.limitKey).toBe('runtime:runtime-1');
    expect((await request('/three', keys.otherRuntime)).status).toBe(200);
  });

  it('keeps route and credential buckets independent within a runtime', async () => {
    for (const path of routes.keys()) configure(path, { globalMax: 10, runtimeAssetMax: 10, routeMax: 2, consumerMax: 1, ipMax: 10 });
    expect((await request('/one')).status).toBe(200);
    expect((await request('/one')).status).toBe(429);
    expect(rejection().details.limitKey).toBe(`consumer:route/one:${callerId('alice')}`);
    expect((await request('/one', keys.bob)).status).toBe(200);
    expect((await request('/one', keys.bob)).status).toBe(429);
    expect(rejection().details.limitKey).toBe('route:route/one');
    expect((await request('/two')).status).toBe(200);
  });

  it('rolls back all earlier checks when anonymous capacity rejects and never charges failed authentication', async () => {
    configure('/one', { globalMax: 3, runtimeAssetMax: 10, routeMax: 10, consumerMax: 10, ipMax: 10, anonymousMax: 1 }, 'anonymous');
    expect((await request('/one', null)).status).toBe(200);
    expect((await request('/one', null)).status).toBe(429);
    expect(rejection().details.limitKey).toBe('anonymous:route/one');
    configure('/one', { globalMax: 3, runtimeAssetMax: 10, routeMax: 10, consumerMax: 10, ipMax: 10, anonymousMax: 1 });
    expect((await request('/one', 'unknown')).status).toBe(401);
    expect((await request()).status).toBe(200);
    expect(await request()).toEqual({ status: 200, cache: 'HIT' });
    expect((await request()).status).toBe(429);
    expect(rejection().details.limitKey).toBe('global');
  });

  it('retains subject capacity across overlapping rotation keys and observes revocation before cache', async () => {
    configure('/one', { globalMax: 20, runtimeAssetMax: 20, routeMax: 20, consumerMax: 2, ipMax: 20 });
    expect((await request()).status).toBe(200);
    expect(await request('/one', keys.successor)).toEqual({ status: 200, cache: null });
    expect((await request()).status).toBe(429);
    expect((await request('/one', keys.successor)).status).toBe(429);
    expect(rejection().details.limitKey).toBe(`consumer:route/one:${callerId('alice')}`);
    await credentials.update({ keyId: keys.alice }, { status: GatewayConsumerCredentialStatus.REVOKED });
    expect((await request()).status).toBe(401);
    expect((await request('/one', keys.successor)).status).toBe(429);
    expect((await request('/one', keys.bob)).status).toBe(200);
    expect(upstreamCalls).toBe(3);
  });

  it('checks overlap expiry and runtime scope before any bucket or warmed cache can admit', async () => {
    configure('/one', { globalMax: 2, consumerMax: 2 });
    expect((await request()).status).toBe(200);
    const current = await credentials.findOneByOrFail({ keyId: keys.alice });
    current.accessPolicy = { ...current.accessPolicy, validUntil: Math.floor(Date.now() / 1000) - 1 };
    await credentials.save(current);
    expect((await request()).status).toBe(401);
    expect((await request('/one', keys.otherRuntime)).status).toBe(403);
    expect(await request('/one', keys.successor)).toEqual({ status: 200, cache: null });
    expect((await request('/one', keys.bob)).status).toBe(429);
    expect(rejection().details.limitKey).toBe('global');
    expect(upstreamCalls).toBe(2);
  });

  it('rejects conflicting shared windows over HTTP without resetting or charging the active bucket', async () => {
    configure('/one', { globalMax: 2, runtimeAssetMax: 10 });
    configure('/two', { globalMax: 2, runtimeAssetMax: 10, windowMs: 10 });
    expect((await request('/one')).status).toBe(200);
    expect((await request('/two')).status).toBe(503);
    expect(rejection()).toMatchObject({ eventName: 'gateway.rate_limit_configuration_conflict',
      details: { limitKey: 'global', activeWindowMs: 60000, requestedWindowMs: 10 } });
    expect(await request('/one')).toEqual({ status: 200, cache: 'HIT' });
    expect((await request('/one')).status).toBe(429);
    expect(rejection().details.limitKey).toBe('global');
    expect(upstreamCalls).toBe(1);
  });
  it('admits exactly the shared capacity under concurrent real HTTP requests', async () => {
    configure('/one', { globalMax: 7, runtimeAssetMax: 20, routeMax: 20, consumerMax: 20, ipMax: 20 });
    const results = await Promise.all(Array.from({ length: 24 }, () => request()));
    expect(results.filter(result => result.status === 200)).toHaveLength(7);
    expect(results.filter(result => result.status === 429)).toHaveLength(17);
    expect(events.recordRuntimeControlEvent.mock.calls.every(([event]: any[]) => event.details.limitKey === 'global')).toBe(true);
  });
});
