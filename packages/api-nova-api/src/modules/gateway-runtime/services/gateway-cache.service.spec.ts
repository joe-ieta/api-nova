import { GatewayCacheService } from './gateway-cache.service';

describe('GatewayCacheService', () => {
  const buildRoute = () =>
    ({
      runtimeAsset: { id: 'runtime-1' },
      routeBinding: { id: 'route-1', routePath: '/orders', routeVisibility: 'external' },
      policies: {
        auth: { mode: 'api_key' },
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
      { mode: 'api_key', consumerId: 'consumer-1', keyId: 'key-1' },
    );
    const second = service.resolve(
      route,
      {
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders?tenant=t1&ignored=y',
        headers: { 'accept-language': 'zh-CN' },
      } as any,
      { mode: 'api_key', consumerId: 'consumer-1', keyId: 'key-1' },
    );
    const third = service.resolve(
      route,
      {
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders?tenant=t1',
        headers: { 'accept-language': 'en-US' },
      } as any,
      { mode: 'api_key', consumerId: 'consumer-1', keyId: 'key-1' },
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
    const auth = { mode: 'api_key' as const, consumerId: 'consumer-1', keyId: 'key-1' };

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

  it('isolates JWT callers even when consumer variation is disabled', () => {
    const service = new GatewayCacheService();
    const route = buildRoute();
    route.policies.cache.varyByConsumer = false;
    route.policies.auth.mode = 'jwt';
    const req = { method: 'GET', originalUrl: '/orders', headers: {} } as any;
    const principal = (callerId: string) => ({ mode: 'jwt', principal: {
      callerId, identitySource: 'authenticated', scopes: [] } }) as any;
    expect(service.resolve(route, req, principal('caller-a'))?.key)
      .not.toBe(service.resolve(route, req, principal('caller-b'))?.key);
    expect(service.resolve(route, req, principal('caller-a'))?.key)
      .toBe(service.resolve(route, req, principal('caller-a'))?.key);
  });

  describe('authorization boundary for both cache reads and writes', () => {
    const req = { method: 'GET', originalUrl: '/orders', headers: {
      authorization: 'Bearer unverified-request-token', 'x-api-key': 'unverified-key',
    }, gatewayAuth: { mode: 'anonymous' } } as any;
    const result = { statusCode: 200, headers: { 'content-type': 'application/json' },
      responseBodyBuffer: Buffer.from('{"private":true}') };
    const jwt = (overrides: Record<string, unknown> = {}) => ({ mode: 'jwt', principal: {
      identitySource: 'authenticated', callerId: 'caller-1', issuer: 'issuer-1', subject: 'subject-1',
      scopes: ['read'], ...overrides,
    } }) as any;
    const apiKey = { mode: 'api_key', consumerId: 'credential-1', keyId: 'key-1' } as any;
    const routeFor = (mode: unknown, visibility = 'external') => {
      const route = buildRoute();
      route.policies.auth.mode = mode;
      route.routeBinding.routeVisibility = visibility;
      route.policies.cache.varyByConsumer = false;
      return route;
    };

    it.each([
      ['jwt missing context', 'jwt', undefined],
      ['jwt missing principal', 'jwt', { mode: 'jwt' }],
      ['jwt actor fallback', 'jwt', { mode: 'jwt', actorId: 'legacy-actor' }],
      ['jwt consumer fallback', 'jwt', { mode: 'jwt', consumerId: 'credential-1' }],
      ['jwt anonymous principal', 'jwt', jwt({ identitySource: 'anonymous' })],
      ['jwt missing caller', 'jwt', jwt({ callerId: undefined })],
      ['jwt blank caller', 'jwt', jwt({ callerId: '   ' })],
      ['jwt malformed caller', 'jwt', jwt({ callerId: 42 })],
      ['jwt missing scopes', 'jwt', jwt({ scopes: undefined })],
      ['jwt malformed scopes', 'jwt', jwt({ scopes: ['read', 42] })],
      ['api key missing context', 'api_key', undefined],
      ['api key missing consumer', 'api_key', { mode: 'api_key', keyId: 'key-1' }],
      ['api key missing key ID', 'api_key', { mode: 'api_key', consumerId: 'credential-1' }],
      ['api key blank consumer', 'api_key', { ...apiKey, consumerId: ' ' }],
      ['api key blank key ID', 'api_key', { ...apiKey, keyId: '' }],
      ['api key actor fallback', 'api_key', { mode: 'api_key', actorId: 'actor-1' }],
      ['jwt with API key context', 'jwt', apiKey],
      ['api key with JWT context', 'api_key', jwt()],
      ['authenticated route with anonymous context', 'jwt', { mode: 'anonymous' }],
      ['anonymous missing context', 'anonymous', undefined],
      ['anonymous with JWT context', 'anonymous', jwt()],
      ['invalid context mode', 'jwt', { mode: 'oauth2', principal: jwt().principal }],
      ['missing policy mode', undefined, jwt()],
      ['unknown policy mode', 'oauth2', apiKey],
      ['noncanonical policy mode', 'JWT', jwt()],
    ])('bypasses %s without reading or populating cache', (_name, mode, context) => {
      const service = new GatewayCacheService();
      const route = routeFor(mode);
      // Warm a shared anonymous entry and valid protected entries for the same URL.
      expect(service.store(routeFor('anonymous'), req, { mode: 'anonymous' }, result)).toBe(true);
      expect(service.store(routeFor('jwt'), req, jwt(), result)).toBe(true);
      expect(service.store(routeFor('api_key'), req, apiKey, result)).toBe(true);
      const entries = (service as any).cache;
      const read = jest.spyOn(entries, 'get');
      const write = jest.spyOn(entries, 'set');
      expect(service.resolve(route, req, context as any)).toBeNull();
      expect(service.store(route, req, context as any, result)).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    });

    it.each(['internal', '', undefined])('requires JWT for anonymous policy with %s visibility', visibility => {
      const service = new GatewayCacheService();
      const route = routeFor('anonymous');
      route.routeBinding.routeVisibility = visibility;
      expect(service.resolve(route, req, { mode: 'anonymous' })).toBeNull();
      expect(service.store(route, req, { mode: 'anonymous' }, result)).toBe(false);
      expect(service.store(route, req, jwt(), result)).toBe(true);
      expect(service.resolve(route, req, jwt())?.hit).toBe(true);
    });

    it.each([
      ['JWT caller', 'jwt', jwt(), jwt({ callerId: 'caller-2' })],
      ['JWT issuer', 'jwt', jwt(), jwt({ issuer: 'issuer-2' })],
      ['JWT subject', 'jwt', jwt(), jwt({ subject: 'subject-2' })],
      ['JWT client', 'jwt', jwt(), jwt({ clientId: 'client-2' })],
      ['JWT credential', 'jwt', jwt({ credentialId: 'cred-1' }), jwt({ credentialId: 'cred-2' })],
      ['JWT permissions', 'jwt', jwt(), jwt({ scopes: ['read', 'admin'] })],
      ['API key consumer', 'api_key', apiKey, { ...apiKey, consumerId: 'credential-2' }],
      ['API key credential', 'api_key', apiKey, { ...apiKey, keyId: 'key-2' }],
    ])('isolates %s even with varyByConsumer disabled', (_name, mode, first, second) => {
      const service = new GatewayCacheService();
      const route = routeFor(mode);
      expect(service.store(route, req, first, result)).toBe(true);
      expect(service.resolve(route, req, first)?.hit).toBe(true);
      expect(service.resolve(route, req, second)?.hit).toBe(false);
      expect(service.store(route, req, second, { ...result, responseBodyBuffer: Buffer.from('second') })).toBe(true);
      const original = service.resolve(route, req, first);
      expect(original?.hit && original.entry.body).toEqual(result.responseBodyBuffer);
    });

    it('keeps explicit anonymous, JWT and API key namespaces separate for identical identifiers', () => {
      const service = new GatewayCacheService();
      const routes = [routeFor('anonymous'), routeFor('jwt'), routeFor('api_key')];
      const contexts = [{ mode: 'anonymous' }, jwt({ callerId: 'credential-1' }), apiKey] as any[];
      const keys = routes.map((route, index) => {
        expect(service.store(route, req, contexts[index], result)).toBe(true);
        return service.resolve(route, req, contexts[index])?.key;
      });
      expect(new Set(keys).size).toBe(3);
      routes.forEach((route, index) => expect(service.resolve(route, req, contexts[index])?.hit).toBe(true));
    });

    it('shares only equivalent JWT scope sets across renewed tokens', () => {
      const service = new GatewayCacheService();
      const route = routeFor('jwt');
      expect(service.store(route, req, jwt({ scopes: ['write', 'read', 'read'], expiresAt: 100 }), result)).toBe(true);
      expect(service.resolve(route, req, jwt({ scopes: ['read', 'write'], expiresAt: 200 }))?.hit).toBe(true);
    });
  });

});
