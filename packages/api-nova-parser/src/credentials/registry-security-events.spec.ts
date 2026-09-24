import { UpstreamCredentialRegistry } from './registry';
export function eventCandidate(revision = 'r1') {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'production' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'memory:TOKEN' } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'api.example.invalid', port: 443, basePath: '/' },
      allowedHosts: ['api.example.invalid'], credential: 'token', endpoints: [] }] };
}
export function eventRegistry() { return new UpstreamCredentialRegistry({ environment: 'production', providerFactory: () => ({ type: 'env', resolve: async () => 'secret-never-in-events' }) }); }
describe('Registry synchronous host security commits', () => {
  test('notifies only after active swap and before reload resolves; redacted immutable event', async () => {
    const registry = eventRegistry(), seen: unknown[] = [];
    registry.observeSecurityCommits(event => { expect(registry.captureSnapshot().generation).toBe(event.generation); expect(Object.isFrozen(event.changes[0])).toBe(true); seen.push(event); });
    await registry.reload(eventCandidate()); expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/secret-never|TOKEN|secretRef/);
  });
  test('revision-only reload differs from security changes and removed sites', async () => {
    const registry = eventRegistry(), kinds: string[] = [];
    registry.observeSecurityCommits(event => { kinds.push(event.changes[0].kind); });
    await registry.reload(eventCandidate()); await registry.reload(eventCandidate('r2'));
    const changed = eventCandidate('r3'); changed.credentials.token.secretRef = 'memory:OTHER'; await registry.reload(changed);
    const removed = eventCandidate('r4'); removed.sites = []; await registry.reload(removed);
    expect(kinds).toEqual(['initial', 'reload', 'security-change', 'security-change']);
  });
  test('schema/provider/ownership/history failure never publishes', async () => {
    for (const mode of ['schema', 'provider', 'ownership', 'history']) {
      const observer = jest.fn(); const registry = new UpstreamCredentialRegistry({ environment: 'production',
        providerFactory: () => ({ type: 'env', resolve: async () => { if (mode === 'provider') throw Error('private'); return 'safe'; } }),
        validateCandidateOwnership: async () => { if (mode === 'ownership') throw Error('private'); },
        ...(mode === 'history' ? { credentialHeaderHistory: { namespace: 'test', store: { load: async () => ({ version: 0, names: [] }), commit: async () => { throw Error('private'); } } } } : {}) });
      registry.observeSecurityCommits(observer);
      await expect(registry.reload(mode === 'schema' ? {} : eventCandidate())).rejects.toThrow(); expect(observer).not.toHaveBeenCalled();
    }
  });
  test('durable commit publishes once only after CAS succeeds; conflicts publish nothing', async () => {
    let release!: (value: boolean) => void; const commit = jest.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const registry = new UpstreamCredentialRegistry({ environment: 'production', providerFactory: () => ({ type: 'env', resolve: async () => 'safe' }),
      credentialHeaderHistory: { namespace: 'test', store: { load: async () => ({ version: 0, names: [] }), commit } } });
    const observer = jest.fn(); registry.observeSecurityCommits(observer); const pending = registry.reload(eventCandidate());
    while (!commit.mock.calls.length) await Promise.resolve(); expect(observer).not.toHaveBeenCalled(); expect(() => registry.captureSnapshot()).toThrow();
    release(true); await pending; expect(observer).toHaveBeenCalledTimes(1);
    commit.mockImplementation(async () => false); await expect(registry.reload(eventCandidate('r2'))).rejects.toThrow('HISTORY_CONFLICT');
    expect(observer).toHaveBeenCalledTimes(1); expect(registry.captureSnapshot().generation).toBe(1);
  });
  test('observer throw cannot roll back commit and poisons only its subscription', async () => {
    const registry = eventRegistry(), healthy = jest.fn();
    const sub = registry.observeSecurityCommits(() => { throw Error('private'); }); registry.observeSecurityCommits(healthy);
    await registry.reload(eventCandidate()); expect(registry.captureSnapshot().generation).toBe(1);
    expect(sub.signal.aborted).toBe(true); expect(() => sub.assertAvailable()).toThrow('REGISTRY_OBSERVER_UNAVAILABLE'); expect(healthy).toHaveBeenCalledTimes(1);
    sub.close();
  });
  test('async callbacks fail closed; closed subscribers do not receive events', async () => {
    const registry = eventRegistry(); const sub = registry.observeSecurityCommits(async () => { throw Error('private'); });
    const removed = jest.fn(); registry.observeSecurityCommits(removed).close(); await registry.reload(eventCandidate());
    expect(() => sub.assertAvailable()).toThrow(); expect(removed).not.toHaveBeenCalled();
  });
});
