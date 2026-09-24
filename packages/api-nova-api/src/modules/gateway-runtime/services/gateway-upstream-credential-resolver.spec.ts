import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  UpstreamCredentialRegistry,
} from 'api-nova-parser';
import {
  createGatewayUpstreamCredentialResolver,
  type GatewayUpstreamCredentialResolver,
} from './gateway-upstream-credential-resolver';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';

function route(credentialRef?: string): any {
  return {
    sourceServiceAsset: { id: 'asset' },
    endpointDefinition: { id: 'endpoint' },
    sourceServiceInstance: { credentialRef },
    routeBinding: { upstreamMethod: 'GET', upstreamPath: '/items', timeoutMs: 1000 },
    policies: {},
    params: {},
  };
}

async function registry() {
  const candidate = {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'rev-1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: {
      private: { type: 'apiKey', placement: { in: 'header', name: 'X-Private' }, secretRef: 'env:PRIVATE' },
    },
    sites: [{
      id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
      allowedHosts: ['api.example.com'], credential: 'private',
      endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'private' }],
    }],
  };
  const value = { current: 'synthetic-private' };
  const store = new UpstreamCredentialRegistry({
    environment: 'test',
    providerFactory: description => ({
      type: description.type,
      resolve: async () => value.current,
    }),
  });
  await store.reload(candidate);
  return { store, value, candidate };
}

function request(headers: Record<string, string>): any {
  return {
    headers,
    protocol: 'https',
    socket: { remoteAddress: '127.0.0.1' },
  };
}

describe('Gateway C4 upstream credential adapter', () => {
  test('uses the captured snapshot and exposes only header metadata', async () => {
    const { store, value } = await registry();
    const adapter = createGatewayUpstreamCredentialResolver(() => store.captureSnapshot());
    const first = await adapter.resolve(route(), 'https://api.example.com/items');
    expect(first.headers).toEqual({ 'x-private': 'synthetic-private' });
    expect(first.credentialHeaderNames).toEqual(['x-private']);
    expect(first.managedHeaderNames).toEqual(expect.arrayContaining(['authorization', 'x-private']));
    expect(JSON.stringify(first)).not.toContain('env:PRIVATE');
    const unchanged = await adapter.resolve(route(), 'https://api.example.com/items');
    expect(unchanged.cacheIdentity).toBe(first.cacheIdentity);
    value.current = 'rotated-private';
    const second = await adapter.resolve(route(), 'https://api.example.com/items');
    expect(second.headers).toEqual({ 'x-private': 'rotated-private' });
    expect(second.cacheIdentity === first.cacheIdentity).toBe(false);
    expect(second.cacheIdentity).not.toContain(value.current);
    expect(second.cacheIdentity).not.toContain(createHash('sha256').update(value.current).digest('hex'));
    expect(second.cacheIdentity).not.toContain(createHash('sha256').update(JSON.stringify(Object.entries(second.headers))).digest('hex'));
  });

  test('removes consumer managed headers before final resolver injection', async () => {
    const resolver: GatewayUpstreamCredentialResolver = {
      resolve: jest.fn(async () => ({
        headers: Object.freeze({ 'x-private': 'resolved-private' }),
        credentialHeaderNames: Object.freeze(['x-private']),
        managedHeaderNames: Object.freeze(['authorization', 'x-private']),
      })),
    };
    const service = new GatewayProxyEngineService({} as any, resolver);
    const resolved = await (service as any).resolveCredentialHeaders(
      route(), new URL('https://api.example.com/items'),
    );
    const headers = (service as any).buildForwardHeaders(
      { authorization: 'consumer', 'x-api-key': 'consumer', 'x-private': 'consumer', 'x-business': 'ok' },
      new URL('https://api.example.com/items'),
      request({ host: 'gateway.local' }),
      resolved.headers,
      resolved.managedHeaderNames,
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-private']).toBe('resolved-private');
    expect(headers['x-business']).toBe('ok');
  });

  test('none resolution still strips configured credential header names', async () => {
    const resolver: GatewayUpstreamCredentialResolver = {
      resolve: async () => ({
        headers: Object.freeze({}),
        credentialHeaderNames: Object.freeze([]),
        managedHeaderNames: Object.freeze(['authorization', 'x-private']),
      }),
    };
    const service = new GatewayProxyEngineService({} as any, resolver);
    const resolved = await (service as any).resolveCredentialHeaders(
      route(), new URL('https://api.example.com/public'),
    );
    const headers = (service as any).buildForwardHeaders(
      { 'x-private': 'consumer', 'x-business': 'ok' },
      new URL('https://api.example.com/public'),
      request({ host: 'gateway.local' }),
      resolved.headers,
      resolved.managedHeaderNames,
    );
    expect(headers['x-private']).toBeUndefined();
    expect(headers['x-business']).toBe('ok');
  });

  test('maps resolver errors to a fixed 503 without native details', async () => {
    const resolver: GatewayUpstreamCredentialResolver = {
      resolve: async () => { throw new Error('synthetic-sensitive-cause'); },
    };
    const service = new GatewayProxyEngineService({} as any, resolver);
    let caught: unknown;
    try {
      await (service as any).resolveCredentialHeaders(route(), new URL('https://api.example.com'));
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
    expect(String(caught)).toContain('gateway_upstream_credential_unavailable');
    expect(String(caught)).not.toContain('synthetic-sensitive-cause');
  });

  test('retains legacy env-headers behavior when no resolver is configured', async () => {
    const previous = process.env.GATEWAY_LEGACY_TEST;
    process.env.GATEWAY_LEGACY_TEST = 'legacy-value';
    try {
      const service = new GatewayProxyEngineService({} as any);
      const result = await (service as any).resolveCredentialHeaders(
        route('env-headers:X-Legacy=GATEWAY_LEGACY_TEST'),
        new URL('https://api.example.com'),
      );
      expect(result.headers).toEqual({ 'x-legacy': 'legacy-value' });
      expect(result.credentialHeaderNames).toEqual(['x-legacy']);
    } finally {
      if (previous === undefined) delete process.env.GATEWAY_LEGACY_TEST;
      else process.env.GATEWAY_LEGACY_TEST = previous;
    }
  });
});


describe('Gateway D1 Registry policy exchange', () => {
  test('opt-in is required and Site/Endpoint policies stay with one authorized generation', async () => {
    const { store, candidate } = await registry();
    const next: any = candidate; next.metadata.revision = 'policy-1';
    next.sites[0].headerPolicy = { version: 1, requestHeaders: ['x-site'], responseHeaders: ['x-result'] };
    next.sites[0].endpoints[0].headerPolicy = { version: 1, requestHeaders: ['x-endpoint'] };
    next.sites[0].endpoints.push({ method: 'GET', path: '/items', credential: 'none', headerPolicy: { version: 1, requestHeaders: ['x-wrong-selector'] } });
    await store.reload(next);
    await expect(createGatewayUpstreamCredentialResolver(() => store.captureSnapshot()).resolve(route(), 'https://api.example.com/items', 'GET')).rejects.toThrow('NOT_READY');
    const capture = jest.fn(() => store.captureSnapshot());
    const adapter = createGatewayUpstreamCredentialResolver(capture, { enableHeaderPolicy: true });
    const result = await adapter.resolve(route(), 'https://api.example.com/items', 'GET');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.registryGeneration).toBe(2);
    expect(result.registryRevision).toBe('policy-1');
    expect(result.registrySiteId).toBe('site');
    expect(result.compiledHeaderPolicy?.requestExtensions).toEqual(['x-endpoint']);
    expect(result.compiledHeaderPolicy?.responseExtensions).toEqual(['x-result']);
    expect(result.headers).toEqual({ 'x-private': 'synthetic-private' });
    expect(result.historicalAuthenticationHeaderNames).toContain('x-private');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.historicalAuthenticationHeaderNames)).toBe(true);
    const other = route(); other.endpointDefinition.id = 'unlisted';
    expect((await adapter.resolve(other, 'https://api.example.com/items', 'GET')).compiledHeaderPolicy?.requestExtensions).toEqual(['x-site']);
    await expect(adapter.resolve(route(), 'https://other.example.com/items', 'GET')).rejects.toThrow('SITE_NOT_FOUND');
    const conflict = route(); conflict.routeBinding.upstreamConfig = { headerPolicy: { version: 1 } };
    await expect(adapter.resolve(conflict, 'https://api.example.com/items', 'GET')).rejects.toThrow('SOURCE_CONFLICT');
  });

  test('a reload while resolving secrets cannot mix Header policy generations', async () => {
    const { store, candidate } = await registry();
    const first: any = candidate; first.metadata.revision = 'policy-1';
    first.sites[0].headerPolicy = { version: 1, requestHeaders: ['x-before'] };
    await store.reload(first);
    const captured = store.captureSnapshot();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const snapshot = { ...captured, resolveSecret: async () => { entered(); await wait; return 'before-secret'; } };
    const capture = jest.fn(() => snapshot);
    const adapter = createGatewayUpstreamCredentialResolver(capture, { enableHeaderPolicy: true });
    const pending = adapter.resolve(route(), 'https://api.example.com/items', 'GET');
    await enteredPromise;
    const next = JSON.parse(JSON.stringify(first)); next.metadata.revision = 'rev-2';
    next.sites[0].headerPolicy.requestHeaders = ['x-after'];
    await store.reload(next); release();
    const result = await pending;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.registryGeneration).toBe(2);
    expect(result.registryRevision).toBe('policy-1');
    expect(result.compiledHeaderPolicy?.requestExtensions).toEqual(['x-before']);
    expect(result.headers['x-private']).toBe('before-secret');
    expect(store.captureSnapshot().generation).toBe(3);
  });

  test('None does not remove policy or historical names and scope rejection still applies', async () => {
    const { store, candidate } = await registry(); const next: any = candidate; next.metadata.revision = 'policy-1';
    next.sites[0].headerPolicy = { version: 1 };
    next.sites[0].endpoints[0].credential = 'none';
    await store.reload(next);
    const adapter = createGatewayUpstreamCredentialResolver(() => store.captureSnapshot(), { enableHeaderPolicy: true });
    const result = await adapter.resolve(route(), 'https://api.example.com/items', 'GET');
    expect(result.headers).toEqual({}); expect(result.compiledHeaderPolicy?.version).toBe(1);
    expect(result.managedHeaderNames).toContain('x-private');
    next.sites[0].endpoints[0].credential = 'private'; next.credentials.private.methods = ['POST']; next.metadata.revision = 'policy-2';
    await store.reload(next);
    await expect(adapter.resolve(route(), 'https://api.example.com/items', 'GET')).rejects.toThrow('SCOPE_MISMATCH');
  });
});
