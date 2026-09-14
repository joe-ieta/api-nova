import { UpstreamCredentialRegistry, UpstreamCredentialRegistryError } from './registry';
import { parseUpstreamCredentialBindings } from './loader';
import type { UpstreamSecretProviderDescription } from './types';

function raw(revision = 'r1') {
  return {
    apiVersion: 'security.apinova.io/v1',
    kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'production' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'env:TEST_TOKEN' } },
    sites: [{
      id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
      allowedHosts: ['api.example.com'], credential: 'token', endpoints: [],
    }],
  };
}

function yaml(revision = 'r1') {
  return [
    'apiVersion: security.apinova.io/v1',
    'kind: UpstreamCredentialBindings',
    'metadata:', '  revision: ' + revision, '  environment: production',
    'reload:', '  mode: manual', '  debounceMs: 0', '  rejectPlaintextSecrets: true',
    'secretProviders:', '  env:', '    type: env',
    'credentials:', '  token:', '    type: bearer', '    secretRef: env:TEST_TOKEN',
    'sites:', '  - id: site', '    sourceServiceAssetId: asset',
    '    match:', '      scheme: https', '      host: api.example.com',
    '      port: 443', '      basePath: /',
    '    credential: token', '    allowedHosts:', '      - api.example.com',
    '    endpoints: []',
  ].join('\n');
}

function provider(description: UpstreamSecretProviderDescription) {
  return { type: description.type, resolve: async () => 'synthetic-text-secret' };
}

async function errorCode(operation: Promise<unknown>, code: string) {
  try {
    await operation;
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamCredentialRegistryError);
    expect((error as UpstreamCredentialRegistryError).code).toBe(code);
    expect(String(error)).not.toContain('synthetic-text-secret');
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  }
}

describe('UpstreamCredentialRegistry text activation', () => {
  test.each([
    ['json' as const, () => JSON.stringify(raw())],
    ['yaml' as const, () => yaml()],
  ])('loads, dry-resolves and commits %s text', async (format, text) => {
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: provider });
    const snapshot = await registry.reloadText(text(), format);
    expect(snapshot.generation).toBe(1);
    expect(snapshot.candidate.metadata.revision).toBe('r1');
    expect(await snapshot.resolveSecret('token')).toBe('synthetic-text-secret');
    expect(registry.getStatus()).toEqual({
      state: 'ready', environment: 'production', generation: 1,
      revision: 'r1', reloading: false,
    });
  });

  test('invalid text preserves the active identity and reports only a static code', async () => {
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: provider });
    const active = await registry.reloadText(JSON.stringify(raw()), 'json');
    await errorCode(registry.reloadText('{"secret":"synthetic-text-secret"', 'json'), 'CANDIDATE_REJECTED');
    expect(registry.captureSnapshot()).toBe(active);
    expect(registry.getStatus()).toEqual({
      state: 'ready', environment: 'production', generation: 1,
      revision: 'r1', reloading: false, lastReloadError: 'CANDIDATE_REJECTED',
    });
  });

  test('text parsing occurs inside the synchronous reload lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new UpstreamCredentialRegistry({
      environment: 'production',
      providerFactory: description => ({
        type: description.type,
        resolve: async () => { await gate; return 'synthetic-text-secret'; },
      }),
    });
    const first = registry.reloadText(JSON.stringify(raw()), 'json');
    expect(registry.getStatus().reloading).toBe(true);
    await errorCode(registry.reloadText(JSON.stringify(raw('r2')), 'json'), 'RELOAD_IN_PROGRESS');
    release();
    await expect(first).resolves.toMatchObject({ generation: 1 });
  });

  test('normalized candidates remain rejected by the raw-object API', async () => {
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: provider });
    const normalized = parseUpstreamCredentialBindings(JSON.stringify(raw()), 'json');
    await errorCode(registry.reload(normalized), 'CANDIDATE_REJECTED');
    expect(registry.getStatus()).toEqual({
      state: 'empty', environment: 'production', generation: 0,
      reloading: false, lastReloadError: 'CANDIDATE_REJECTED',
    });
  });

  test('format and schema errors do not invoke providers', async () => {
    const factory = jest.fn(provider);
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factory });
    await errorCode(registry.reloadText(JSON.stringify(raw()), 'toml' as never), 'CANDIDATE_REJECTED');
    await errorCode(registry.reloadText('{}', 'json'), 'CANDIDATE_REJECTED');
    expect(factory).not.toHaveBeenCalled();
  });
});
