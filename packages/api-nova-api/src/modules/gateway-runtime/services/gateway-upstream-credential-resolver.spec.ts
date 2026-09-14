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
  return { store, value };
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
    value.current = 'rotated-private';
    const second = await adapter.resolve(route(), 'https://api.example.com/items');
    expect(second.headers).toEqual({ 'x-private': 'rotated-private' });
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
