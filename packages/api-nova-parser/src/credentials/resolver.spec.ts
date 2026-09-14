import { resolveUpstreamCredential, UpstreamCredentialResolverError } from './resolver';
import type { UpstreamCredentialRegistrySnapshot } from './registry';
import { validateUpstreamCredentialBindings } from './schema';

const secret = 'synthetic-resolver-secret';
const INHERIT = Symbol('inherit');

function fixture(policy: string | typeof INHERIT = 'bearer', endpoints: unknown[] = [],
  resolveSecret: (id: string) => Promise<string> = async () => secret): UpstreamCredentialRegistrySnapshot {
  const credential = policy === INHERIT ? {} : { credential: policy };
  const candidate = validateUpstreamCredentialBindings({
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'rev-1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: {
      bearer: { type: 'bearer', secretRef: 'env:TEST_BEARER' },
      api: { type: 'apiKey', placement: { in: 'header', name: 'X-Test-Key' }, secretRef: 'env:TEST_API' },
    },
    sites: [
      { id: 'root', sourceServiceAssetId: 'asset',
        match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
        allowedHosts: ['api.example.com'], ...credential, endpoints },
      { id: 'specific', sourceServiceAssetId: 'asset',
        match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/v1' },
        allowedHosts: ['api.example.com'], credential: 'api', endpoints: [] },
    ],
  });
  return Object.freeze({ generation: 3, candidate, resolveSecret });
}

async function rejects(operation: Promise<unknown>, expected: string): Promise<void> {
  try {
    await operation;
    throw new Error('Expected resolver rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamCredentialResolverError);
    expect((error as UpstreamCredentialResolverError).code).toBe(expected);
    expect(String(error)).not.toContain(secret);
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  }
}

describe('resolveUpstreamCredential', () => {
  test('uses longest matching basePath and returns frozen api-key metadata', async () => {
    const result = await resolveUpstreamCredential(fixture(), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/v1/items?q=ok',
    });
    expect(result).toEqual({ generation: 3, revision: 'rev-1', siteId: 'specific',
      mode: 'reference', credentialId: 'api', headers: { 'x-test-key': secret } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.headers)).toBe(true);
  });

  test('requires a basePath segment boundary', async () => {
    const result = await resolveUpstreamCredential(fixture(), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/v10',
    });
    expect(result.siteId).toBe('root');
    expect(result.headers).toEqual({ authorization: 'Bearer ' + secret });
  });

  test('endpoint none suppresses inherited credentials', async () => {
    const result = await resolveUpstreamCredential(
      fixture('bearer', [{ endpointDefinitionId: 'public', credential: 'none' }]),
      { sourceServiceAssetId: 'asset', url: 'https://api.example.com/public', endpointDefinitionId: 'public' },
    );
    expect(result).toEqual({ generation: 3, revision: 'rev-1', siteId: 'root', mode: 'none', headers: {} });
  });

  test('route override selects api key and normalizes method', async () => {
    const result = await resolveUpstreamCredential(
      fixture('bearer', [{ method: 'POST', path: '/items/{id}', credential: 'api' }]),
      { sourceServiceAssetId: 'asset', url: 'https://api.example.com/items/7', method: 'post', endpointPath: '/items/{id}' },
    );
    expect(result.credentialId).toBe('api');
  });

  test('missing endpoint and endpoint inherit both use site policy', async () => {
    const missing = await resolveUpstreamCredential(fixture(), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/items', endpointDefinitionId: 'missing',
    });
    const inherited = await resolveUpstreamCredential(fixture('api', [{ endpointDefinitionId: 'item' }]), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/item', endpointDefinitionId: 'item',
    });
    expect(missing.credentialId).toBe('bearer');
    expect(inherited.credentialId).toBe('api');
  });

  test('top-level inherit fails before secret resolution', async () => {
    const read = jest.fn(async () => secret);
    await rejects(resolveUpstreamCredential(fixture(INHERIT, [], read), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/items',
    }), 'CREDENTIAL_POLICY_UNRESOLVED');
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    ['asset', { sourceServiceAssetId: 'other', url: 'https://api.example.com/items' }],
    ['scheme', { sourceServiceAssetId: 'asset', url: 'http://api.example.com/items' }],
    ['port', { sourceServiceAssetId: 'asset', url: 'https://api.example.com:444/items' }],
    ['host', { sourceServiceAssetId: 'asset', url: 'https://other.example.com/items' }],
  ])('rejects unmatched %s', async (_name, request) => {
    await rejects(resolveUpstreamCredential(fixture(), request), 'SITE_NOT_FOUND');
  });

  test.each([
    'https://user:pass@api.example.com/items',
    'https://api.example.com/items#fragment',
    'https://api.example.com./items',
    'https://api.example.com/%2e%2e/private',
    'https://api.example.com/a%2fb',
    'file:///etc/passwd',
    'not a URL',
  ])('rejects unsafe target %s', async url => {
    await rejects(resolveUpstreamCredential(fixture(), {
      sourceServiceAssetId: 'asset', url,
    }), 'INVALID_TARGET_URL');
  });

  test.each([
    { endpointDefinitionId: 'id', method: 'GET', endpointPath: '/items' },
    { method: 'GET' },
    { endpointPath: '/items' },
  ])('rejects ambiguous endpoint selector %#', async selector => {
    await rejects(resolveUpstreamCredential(fixture(), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/items', ...selector,
    }), 'ENDPOINT_SELECTOR_AMBIGUOUS');
  });

  test('rejects accessors without invoking them', async () => {
    let calls = 0;
    const request = { sourceServiceAssetId: 'asset',
      get url() { calls++; return 'https://api.example.com'; } };
    await rejects(resolveUpstreamCredential(fixture(), request), 'INVALID_RESOLUTION_INPUT');
    expect(calls).toBe(0);
  });

  test('sanitizes provider failures and unsafe values', async () => {
    await rejects(resolveUpstreamCredential(fixture('bearer', [], async () => { throw new Error(secret); }), {
      sourceServiceAssetId: 'asset', url: 'https://api.example.com/items',
    }), 'SECRET_RESOLUTION_FAILED');
    for (const value of ['', ' bad', 'bad\r\nvalue', 'a'.repeat(8193)]) {
      await rejects(resolveUpstreamCredential(fixture('bearer', [], async () => value), {
        sourceServiceAssetId: 'asset', url: 'https://api.example.com/items',
      }), 'SECRET_RESOLUTION_FAILED');
    }
  });
});
