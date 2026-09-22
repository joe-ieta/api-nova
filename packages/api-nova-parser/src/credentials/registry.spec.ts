import { UpstreamCredentialRegistry } from './registry';
import type { UpstreamCredentialBindingsCandidate, UpstreamSecretProviderDescription } from './types';
import type { UpstreamSecretProvider } from './secret-provider';

const privateMarker = 'PRIVATE_REGISTRY_EVIDENCE_7c2e';
function candidate(revision = 'r1', key = 'FIRST_TOKEN', environment = 'production') {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { memory: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'memory:' + key } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.invalid', port: 443, basePath: '/' },
      allowedHosts: ['api.example.invalid'], credential: 'token', endpoints: [] }],
  };
}
function factoryFor(resolve: (key: string) => Promise<string>) {
  return jest.fn((_description: UpstreamSecretProviderDescription): UpstreamSecretProvider => ({ type: _description.type, resolve }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function safeError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(Error);
  const value = error as Error & { code: string };
  expect(value.code).toBe(code);
  expect(value.message).not.toContain(privateMarker);
  expect(value.stack).not.toContain(privateMarker);
  expect(JSON.stringify(value)).not.toContain(privateMarker);
  for (const key of ['cause', 'key', 'ref', 'secretRef', 'secret', 'candidate']) {
    expect(Object.prototype.hasOwnProperty.call(value, key)).toBe(false);
  }
}
async function fails(operation: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  safeError(caught, code);
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(frozen);
  }
}
function expectMetadataOnly(status: object): void {
  expect(Object.keys(status).every(key => ['state', 'environment', 'generation', 'revision',
    'reloading', 'lastReloadError'].includes(key))).toBe(true);
  expect(JSON.stringify(status)).not.toContain(privateMarker);
}

describe('UpstreamCredentialRegistry atomic in-memory contract', () => {
  test('construction is lazy, status is empty, and capture fails closed', () => {
    const factory = factoryFor(async () => 'test-only-token');
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(registry.getStatus()).toMatchObject({ state: 'empty', environment: 'production', generation: 0, reloading: false });
    expect(registry.getStatus().revision).toBeUndefined();
    expectMetadataOnly(registry.getStatus());
    let error: unknown;
    try { registry.captureSnapshot(); } catch (caught) { error = caught; }
    safeError(error, 'REGISTRY_NOT_READY');
  });

  test.each(['', ' bad-environment ', undefined, 42])('invalid configuration %j is rejected without provider use', environment => {
    const factory = factoryFor(async () => 'test-only-token');
    let error: unknown;
    try { new UpstreamCredentialRegistry({ environment: environment as string, providerFactory: factory }); }
    catch (caught) { error = caught; }
    safeError(error, 'INVALID_REGISTRY_CONFIGURATION');
    expect(factory).not.toHaveBeenCalled();
  });

  test('first reload dry-resolves all credentials, publishes once, and passes internal keys only', async () => {
    const resolve = jest.fn(async (_key: string) => 'test-only-token');
    const factory = factoryFor(resolve);
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factory });
    const input = candidate();
    Object.assign(input.credentials, { second: { type: 'apiKey', placement: { in: 'header', name: 'X-API-Key' }, secretRef: 'memory:SECOND_TOKEN' } });
    const snapshot = await registry.reload(input);
    expect(resolve.mock.calls.map(([key]) => key).sort()).toEqual(['FIRST_TOKEN', 'SECOND_TOKEN']);
    expect(factory).toHaveBeenCalledWith({ type: 'env' });
    expect(snapshot.generation).toBe(1);
    expect(registry.captureSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    frozen(snapshot.candidate);
    expect(snapshot.candidate.credentials.second).toMatchObject({ placement: { name: 'x-api-key' } });
    expect(registry.getStatus()).toMatchObject({ state: 'ready', generation: 1, revision: 'r1', reloading: false });
    expectMetadataOnly(registry.getStatus());
  });

  test('candidate ownership is independent and no secret appears in snapshot metadata', async () => {
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => privateMarker) });
    const input = candidate();
    const snapshot = await registry.reload(input);
    input.metadata.revision = 'mutated';
    input.credentials.token.secretRef = 'memory:OTHER_TOKEN';
    input.sites[0].allowedHosts.push('other.example.invalid');
    expect(snapshot.candidate.metadata.revision).toBe('r1');
    expect(snapshot.candidate.credentials.token).toMatchObject({ secretRef: 'memory:FIRST_TOKEN' });
    expect(snapshot.candidate.sites[0].allowedHosts).toEqual(['api.example.invalid']);
    expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
    expect(() => Object.assign(snapshot.candidate.metadata, { revision: 'changed' })).toThrow();
    expectMetadataOnly(registry.getStatus());
  });

  test.each(['schema', 'environment', 'revision'] as const)('%s rejection preserves active identity and never touches providers', async reason => {
    const factory = factoryFor(async () => 'test-only-token');
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factory });
    const initial = await registry.reload(candidate());
    factory.mockClear();
    const next = candidate(reason === 'revision' ? 'r1' : 'r2');
    let code: string;
    if (reason === 'schema') { Object.assign(next, { forbidden: privateMarker }); code = 'CANDIDATE_REJECTED'; }
    else if (reason === 'environment') { next.metadata.environment = 'staging'; code = 'ENVIRONMENT_MISMATCH'; }
    else code = 'REVISION_ALREADY_ACTIVE';
    await fails(registry.reload(next), code);
    expect(factory).not.toHaveBeenCalled();
    expect(registry.captureSnapshot()).toBe(initial);
    expect(registry.getStatus()).toMatchObject({ generation: 1, revision: 'r1', reloading: false, lastReloadError: code });
  });

  test('validation rejects accessors without executing them', async () => {
    const getter = jest.fn(() => { throw new Error(privateMarker); });
    const input = candidate();
    Object.defineProperty(input, 'metadata', { enumerable: true, get: getter });
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => 'test-only-token') });
    await fails(registry.reload(input), 'CANDIDATE_REJECTED');
    expect(getter).not.toHaveBeenCalled();
    expect(registry.getStatus()).toMatchObject({ state: 'empty', generation: 0, reloading: false });
  });

  test('failed first resolution leaves empty registry and releases reload lock', async () => {
    let reject = true;
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => {
      if (reject) throw new Error(privateMarker);
      return 'test-only-token';
    }) });
    await fails(registry.reload(candidate()), 'SECRET_RESOLUTION_FAILED');
    expect(registry.getStatus()).toMatchObject({ state: 'empty', generation: 0, reloading: false });
    expect(() => registry.captureSnapshot()).toThrow();
    reject = false;
    expect((await registry.reload(candidate())).generation).toBe(1);
    expect(registry.getStatus().lastReloadError).toBeUndefined();
  });

  test('failure in any credential rolls back the whole candidate and keeps old secret binding', async () => {
    const resolve = jest.fn(async (key: string) => {
      if (key === 'BROKEN_TOKEN') throw new Error(privateMarker);
      return 'test-only-' + key;
    });
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(resolve) });
    const initial = await registry.reload(candidate());
    const next = candidate('r2', 'SECOND_TOKEN');
    Object.assign(next.credentials, { broken: { type: 'bearer', secretRef: 'memory:BROKEN_TOKEN' } });
    await fails(registry.reload(next), 'SECRET_RESOLUTION_FAILED');
    expect(registry.captureSnapshot()).toBe(initial);
    expect(registry.getStatus()).toMatchObject({ generation: 1, revision: 'r1', reloading: false });
    expect(await initial.resolveSecret('token')).toBe('test-only-FIRST_TOKEN');
    expect((await registry.reload(candidate('r2', 'SECOND_TOKEN'))).generation).toBe(2);
  });

  test('reload locks synchronously, retains active snapshot until dry resolution finishes, and rejects overlap', async () => {
    const gate = deferred<string>();
    const entered = deferred<void>();
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async key => {
      if (key === 'SECOND_TOKEN') { entered.resolve(); return gate.promise; }
      return 'test-only-first';
    }) });
    const initial = await registry.reload(candidate());
    const pending = registry.reload(candidate('r2', 'SECOND_TOKEN'));
    expect(registry.getStatus().reloading).toBe(true);
    try {
      await entered.promise;
      expect(registry.captureSnapshot()).toBe(initial);
      expect(registry.getStatus()).toMatchObject({ generation: 1, revision: 'r1' });
      await fails(registry.reload(candidate('r3')), 'RELOAD_IN_PROGRESS');
      expect(registry.captureSnapshot()).toBe(initial);
    } finally { gate.resolve('test-only-second'); }
    const next = await pending;
    expect(next.generation).toBe(2);
    expect(registry.captureSnapshot()).toBe(next);
    expect(registry.getStatus()).toMatchObject({ revision: 'r2', reloading: false });
  });

  test('pending first reload exposes no partial snapshot', async () => {
    const gate = deferred<string>();
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(() => gate.promise) });
    const pending = registry.reload(candidate());
    try {
      expect(registry.getStatus()).toMatchObject({ state: 'empty', generation: 0, reloading: true });
      expect(() => registry.captureSnapshot()).toThrow();
      await fails(registry.reload(candidate('r2')), 'RELOAD_IN_PROGRESS');
    } finally { gate.resolve('test-only-token'); }
    expect((await pending).generation).toBe(1);
  });

  test('captured snapshots retain binding configuration but resolve current provider values each time', async () => {
    const values: Record<string, string> = { FIRST_TOKEN: 'test-only-first', SECOND_TOKEN: 'test-only-second' };
    const resolve = jest.fn(async (key: string) => values[key]);
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(resolve) });
    const first = await registry.reload(candidate());
    const second = await registry.reload(candidate('r2', 'SECOND_TOKEN'));
    resolve.mockClear();
    expect(await first.resolveSecret('token')).toBe('test-only-first');
    values.FIRST_TOKEN = 'test-only-rotated';
    expect(await first.resolveSecret('token')).toBe('test-only-rotated');
    expect(await second.resolveSecret('token')).toBe('test-only-second');
    expect(resolve.mock.calls.map(([key]) => key)).toEqual(['FIRST_TOKEN', 'FIRST_TOKEN', 'SECOND_TOKEN']);
    expect(first.candidate.metadata.revision).toBe('r1');
    expect(second.candidate.metadata.revision).toBe('r2');
    expect(first.generation).toBe(1);
  });

  test.each(['missing', '__proto__', 'constructor', privateMarker])('unknown credential %s never invokes provider', async id => {
    const resolve = jest.fn(async () => 'test-only-token');
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(resolve) });
    const snapshot = await registry.reload(candidate());
    resolve.mockClear();
    await fails(snapshot.resolveSecret(id), 'UNKNOWN_CREDENTIAL');
    expect(resolve).not.toHaveBeenCalled();
  });

  test.each(['', 'bad\r\nvalue', 'bad\u0000value', undefined, 123])('invalid resolved secret %j cannot activate', async value => {
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => value as string) });
    await fails(registry.reload(candidate()), 'SECRET_RESOLUTION_FAILED');
    expect(registry.getStatus()).toMatchObject({ state: 'empty', generation: 0, reloading: false });
  });

  test('runtime provider failure is sanitized without changing active metadata', async () => {
    let broken = false;
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => {
      if (broken) throw new Error(privateMarker);
      return 'test-only-token';
    }) });
    const snapshot = await registry.reload(candidate());
    const before = registry.getStatus();
    broken = true;
    await fails(snapshot.resolveSecret('token'), 'SECRET_RESOLUTION_FAILED');
    expect(registry.captureSnapshot()).toBe(snapshot);
    expect(registry.getStatus()).toEqual(before);
  });

  test('secret values are validated again after activation rather than cached', async () => {
    let value = 'test-only-token';
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factoryFor(async () => value) });
    const snapshot = await registry.reload(candidate());
    value = 'bad\r\n' + privateMarker;
    await fails(snapshot.resolveSecret('token'), 'SECRET_RESOLUTION_FAILED');
    expect(registry.captureSnapshot()).toBe(snapshot);
  });

  test.each(['factory-throw', 'invalid-adapter', 'sync-resolve-throw'] as const)('adapter failure %s rolls back without native details', async mode => {
    let broken = false;
    const factory = (_description: UpstreamSecretProviderDescription): UpstreamSecretProvider => {
      if (!broken) return { type: _description.type, resolve: async () => 'test-only-token' };
      if (mode === 'factory-throw') throw new Error(privateMarker);
      if (mode === 'invalid-adapter') return null as unknown as UpstreamSecretProvider;
      return { type: _description.type, resolve: () => { throw new Error(privateMarker); } };
    };
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: factory });
    const initial = await registry.reload(candidate());
    broken = true;
    await fails(registry.reload(candidate('r2')), 'SECRET_RESOLUTION_FAILED');
    expect(registry.captureSnapshot()).toBe(initial);
    expect(registry.getStatus()).toMatchObject({ generation: 1, revision: 'r1', reloading: false });
    expectMetadataOnly(registry.getStatus());
  });

  test('host ownership validation runs after secret dry-run, holds reload lock, and cannot publish a rejected candidate', async () => {
    const ownership = deferred<void>();
    const order: string[] = [];
    let rejectOwnership = false;
    const registry = new UpstreamCredentialRegistry({ environment: 'production',
      providerFactory: factoryFor(async () => { order.push('secret'); return 'test-only-token'; }),
      validateCandidateOwnership: async value => {
        order.push(value.metadata.revision);
        if (value.metadata.revision === 'r2') await ownership.promise;
        if (rejectOwnership) throw new Error(privateMarker);
      },
    });
    const before = await registry.reload(candidate());
    const pending = registry.reload(candidate('r2'));
    await new Promise(done => setTimeout(done, 0));
    expect(order).toEqual(['secret', 'r1', 'secret', 'r2']);
    expect(registry.captureSnapshot()).toBe(before);
    await fails(registry.reload(candidate('r3')), 'RELOAD_IN_PROGRESS');
    rejectOwnership = true; ownership.resolve();
    await fails(pending, 'ASSET_OWNERSHIP_REJECTED');
    expect(registry.captureSnapshot()).toBe(before);
    rejectOwnership = false;
    expect((await registry.reload(candidate('r3'))).generation).toBe(2);
  });

  test('ownership validator accessors are rejected without invoking them', () => {
    const getter = jest.fn();
    const options = { environment: 'production' };
    Object.defineProperty(options, 'validateCandidateOwnership', { get: getter });
    expect(() => new UpstreamCredentialRegistry(options)).toThrow('INVALID_REGISTRY_CONFIGURATION');
    expect(getter).not.toHaveBeenCalled();
  });
});
