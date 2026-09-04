import { GatewayCacheService } from './gateway-cache.service';

describe('GatewayCacheService', () => {
  const buildRoute = () =>
    ({
      runtimeAsset: { id: 'runtime-1' },
      routeBinding: { id: 'route-1', routePath: '/orders' },
      policies: {
        cache: {
          enabled: true,
          methods: ['GET', 'HEAD'],
          ttlMs: 1000,
          maxBodyBytes: 1024,
          varyQueryKeys: ['tenant'],
          varyHeaderKeys: ['accept-language'],
          varyByConsumer: true,
        },
      },
    } as any);

  it('varies cache key by selected query, header, and consumer identity', () => {
    const service = new GatewayCacheService();
    const route = buildRoute();
    const first = service.resolve(
      route,
      {
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders?tenant=t1&ignored=x',
        headers: { 'accept-language': 'zh-CN' },
      } as any,
      { mode: 'api_key', consumerId: 'consumer-1' },
    );
    const second = service.resolve(
      route,
      {
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders?tenant=t1&ignored=y',
        headers: { 'accept-language': 'zh-CN' },
      } as any,
      { mode: 'api_key', consumerId: 'consumer-1' },
    );
    const third = service.resolve(
      route,
      {
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders?tenant=t1',
        headers: { 'accept-language': 'en-US' },
      } as any,
      { mode: 'api_key', consumerId: 'consumer-1' },
    );

    expect(first?.key).toBe(second?.key);
    expect(first?.key).not.toBe(third?.key);
  });

  it('stores cacheable responses and clears them on snapshot refresh', () => {
    const service = new GatewayCacheService();
    const route = buildRoute();
    const req = {
      method: 'GET',
      originalUrl: '/api/v1/gateway/orders?tenant=t1',
      headers: { 'accept-language': 'zh-CN' },
    } as any;
    const auth = { mode: 'api_key' as const, consumerId: 'consumer-1' };

    expect(
      service.store(route, req, auth, {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        responseBodyBuffer: Buffer.from('{"ok":true}', 'utf8'),
        responseCapture: {
          totalBytes: 11,
          preview: '{"ok":true}',
          hash: 'hash-1',
          truncated: false,
        },
      }),
    ).toBe(true);

    const lookup = service.resolve(route, req, auth);
    expect(lookup).toEqual(
      expect.objectContaining({
        hit: true,
        entry: expect.objectContaining({
          statusCode: 200,
          responseBodyPreview: '{"ok":true}',
        }),
      }),
    );

    service.handleSnapshotRefreshRequested({ reason: 'publication.membership_published' });
    expect(service.resolve(route, req, auth)).toEqual(
      expect.objectContaining({
        hit: false,
      }),
    );
  });
});
