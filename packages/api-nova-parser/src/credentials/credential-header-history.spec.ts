import { UpstreamCredentialRegistry, type CredentialHeaderHistoryStore } from './registry';
function candidate(name = 'x-new', revision = 'r1'): any { return {
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
  secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'env:SECRET' } },
  sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: 'fixture.invalid', port: 80, basePath: '/' }, allowedHosts: ['fixture.invalid'], credential: 'key', endpoints: [], headerPolicy: { version: 1, requestHeaders: [], responseHeaders: [] } }],
}; }
function ledger(initial = ['x-old']) {
  let version = 0, names = initial;
  const load = jest.fn(async () => ({ version, names: [...names] }));
  const commit = jest.fn(async (_namespace: string, expected: number, added: readonly string[]) => {
    if (version !== expected) return false;
    names = [...new Set([...names, ...added])].sort(); version++; return true;
  });
  return { load, commit, state: () => ({ version, names }) };
}
function registry(store: CredentialHeaderHistoryStore, resolve = async () => 'synthetic-only') {
  return new UpstreamCredentialRegistry({ environment: 'test', credentialHeaderHistory: { namespace: 'gateway:test', store }, providerFactory: d => ({ type: d.type, resolve }) });
}
describe('host-owned durable credential header history', () => {
  it('loads before compiling, strips history through cold starts and sends only names to persistence', async () => {
    const store = ledger(), source = candidate(); const first = registry(store);
    await first.reload(source); expect(first.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-old', 'x-new']));
    const restarted = registry(store); await restarted.reload(candidate('x-next', 'r2'));
    expect(restarted.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-old', 'x-new', 'x-next']));
    expect(JSON.stringify(store.commit.mock.calls)).not.toMatch(/SECRET|synthetic|secretRef/);
    expect(store.load).toHaveBeenCalledWith('gateway:test');
  });
  it('rejects a cold-start policy allowing a retired header before Provider or write', async () => {
    const store = ledger(), resolve = jest.fn(async () => 'synthetic'); const source = candidate(); source.sites[0].headerPolicy.requestHeaders = ['x-old'];
    await expect(registry(store, resolve).reload(source)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(resolve).not.toHaveBeenCalled(); expect(store.commit).not.toHaveBeenCalled();
  });
  it.each(['schema', 'provider', 'ownership'])('does not write after %s rejection', async failure => {
    const store = ledger(), source = candidate(); if (failure === 'schema') source.credentials.key.type = 'invalid';
    const value = new UpstreamCredentialRegistry({ environment: 'test', credentialHeaderHistory: { namespace: 'gateway:test', store }, providerFactory: d => ({ type: d.type, resolve: async () => { if (failure === 'provider') throw Error('sensitive'); return 'synthetic'; } }), validateCandidateOwnership: async () => { if (failure === 'ownership') throw Error('sensitive'); } });
    await expect(value.reload(source)).rejects.toBeDefined(); expect(store.commit).not.toHaveBeenCalled(); expect(store.state()).toEqual({ version: 0, names: ['x-old'] });
  });
  it('cannot acquire a store or erase history from candidate metadata or request-like fields', async () => {
    const store = ledger(), malicious = jest.fn(); const source = candidate(); source.credentialHeaderHistory = { namespace: 'evil', store: { load: malicious, commit: malicious } }; source.metadata.historicalAuthenticationHeaderNames = [];
    await expect(registry(store).reload(source)).rejects.toBeDefined(); expect(malicious).not.toHaveBeenCalled(); expect(store.commit).not.toHaveBeenCalled();
  });
  it('CAS concurrent registries preserve the union without lost updates', async () => {
    const store = ledger([]); await Promise.all([registry(store).reload(candidate('x-a')), registry(store).reload(candidate('x-b'))]);
    expect(store.state()).toEqual({ version: 2, names: ['x-a', 'x-b'] }); expect(store.commit).toHaveBeenCalledTimes(3);
    const cold = registry(store); await cold.reload(candidate('x-c')); expect(cold.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(['x-a', 'x-b', 'x-c']);
  });
  it('a conflict recompiles policies against newly committed retired names', async () => {
    const store = ledger([]), original = store.commit; let once = true;
    const adapter = { load: store.load, commit: async (ns: string, version: number, names: readonly string[]) => { if (once) { once = false; await original(ns, version, ['x-raced']); return false; } return original(ns, version, names); } };
    const source = candidate(); source.sites[0].headerPolicy.requestHeaders = ['x-raced'];
    await expect(registry(adapter).reload(source)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' }); expect(store.state().names).toEqual(['x-raced']);
  });
  it('bounded conflicts fail closed without changing the active snapshot', async () => {
    const store = ledger(), value = registry(store); const previous = await value.reload(candidate()); store.commit.mockImplementation(async () => false);
    await expect(value.reload(candidate('x-other', 'r2'))).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' }); expect(value.captureSnapshot()).toBe(previous); expect(store.state().names).not.toContain('x-other'); expect(store.commit).toHaveBeenCalledTimes(4);
  });
  it.each(['load', 'commit'] as const)('sanitizes %s failures and never activates', async stage => {
    const store = ledger(); store[stage].mockRejectedValueOnce(Error('secret-private-path'));
    const value = registry(store); await expect(value.reload(candidate())).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' }); expect(value.getStatus().state).toBe('empty'); expect(JSON.stringify(value.getStatus())).not.toContain('secret-private-path'); expect(store.state().version).toBe(0);
  });
  it('rejects corrupt loaded names instead of compiling with a truncated history', async () => {
    const store = ledger(['X-INVALID']); await expect(registry(store).reload(candidate())).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' }); expect(store.commit).not.toHaveBeenCalled();
  });
});
