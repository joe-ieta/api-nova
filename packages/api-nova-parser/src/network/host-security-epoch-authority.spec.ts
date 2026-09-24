import { createHostSecurityEpochAuthority } from './host-security-epoch-authority';
import { UpstreamCredentialRegistry } from '../credentials/registry';
function eventCandidate(revision = 'r1') {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'production' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'memory:TOKEN' } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'api.example.invalid', port: 443, basePath: '/' },
      allowedHosts: ['api.example.invalid'], credential: 'token', endpoints: [] }] };
}
function eventRegistry() { return new UpstreamCredentialRegistry({ environment: 'production', providerFactory: () => ({ type: 'env', resolve: async () => 'secret-never-in-events' }) }); }
describe('host security/provider epoch authority (not production provider integration)', () => {
  afterEach(() => jest.useRealTimers());
  test('unknown provider state refuses admission; generated epochs have no caller revision', () => {
    const authority = createHostSecurityEpochAuthority(); expect(() => authority.read('asset')).toThrow('policy_unavailable');
    const epoch = authority.activate('asset'); expect(authority.read('asset')).toBe(epoch);
    expect(Object.keys(epoch)).toEqual(['securityEpoch', 'providerEpoch', 'signal']); authority.close();
  });
  test('ordinary reload retains old epoch while security narrowing aborts synchronously', async () => {
    const registry = eventRegistry(), authority = createHostSecurityEpochAuthority(); authority.observeRegistry(registry);
    await registry.reload(eventCandidate()); const epoch = authority.activate('asset');
    await registry.reload(eventCandidate('r2')); expect(authority.read('asset')).toBe(epoch); expect(epoch.signal.aborted).toBe(false);
    const next = eventCandidate('r3'); next.sites[0].allowedHosts.push('other.invalid');
    let deniedDuringAbort = false; epoch.signal.addEventListener('abort', () => { try { authority.read('asset'); } catch { deniedDuringAbort = true; } });
    await registry.reload(next); expect(epoch.signal.aborted).toBe(true); expect(deniedDuringAbort).toBe(true);
    expect(() => authority.read('asset')).toThrow('policy_denied'); authority.close();
  });
  test.each(['revoke', 'unavailable'] as const)('%s aborts old capture; explicit host activation gets fresh epoch', action => {
    const authority = createHostSecurityEpochAuthority(), epoch = authority.activate('asset'); authority[action]('asset');
    expect(epoch.signal.aborted).toBe(true); expect(() => authority.read('asset')).toThrow(action === 'revoke' ? 'policy_denied' : 'policy_unavailable');
    const fresh = authority.activate('asset'); expect(fresh.securityEpoch).not.toBe(epoch.securityEpoch); expect(fresh.providerEpoch).not.toBe(epoch.providerEpoch); authority.close();
  });
  test('trusted absolute expiry is irreversible after wall clock rollback', () => {
    jest.useFakeTimers(); const authority = createHostSecurityEpochAuthority(), start = Date.now();
    const epoch = authority.activate('asset', start + 100); jest.advanceTimersByTime(101); expect(epoch.signal.aborted).toBe(true);
    jest.setSystemTime(start - 10000); expect(() => authority.read('asset')).toThrow('policy_denied'); authority.close(); expect(jest.getTimerCount()).toBe(0);
  });
  test('expiry monotonic cap survives backwards clock before expiration', () => {
    jest.useFakeTimers(); const authority = createHostSecurityEpochAuthority(); const epoch = authority.activate('asset', Date.now() + 100);
    jest.setSystemTime(Date.now() - 1000); jest.advanceTimersByTime(100); expect(epoch.signal.aborted).toBe(true); authority.close();
  });
  test('capacity is bounded; close cancels timers and cannot reopen', () => {
    jest.useFakeTimers(); const authority = createHostSecurityEpochAuthority({ maxSources: 1 }); const epoch = authority.activate('asset', Date.now() + 1000);
    expect(() => authority.activate('other')).toThrow('policy_unavailable'); authority.close(); expect(epoch.signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0); expect(() => authority.activate('asset')).toThrow('policy_unavailable');
  });
  test('abort callback cannot reactivate during revocation', () => {
    const authority = createHostSecurityEpochAuthority(), epoch = authority.activate('asset'); let rejected = false;
    epoch.signal.addEventListener('abort', () => { try { authority.activate('asset'); } catch { rejected = true; } });
    authority.revoke('asset'); expect(rejected).toBe(true); expect(() => authority.read('asset')).toThrow('policy_denied'); authority.close();
  });
  test('observer failure signal immediately closes active provider admission', () => {
    const registry = eventRegistry(), authority = createHostSecurityEpochAuthority(), epoch = authority.activate('asset');
    const controller = new AbortController();
    jest.spyOn(registry, 'observeSecurityCommits').mockReturnValue({ signal: controller.signal, assertAvailable: () => { if (controller.signal.aborted) throw Error('private'); }, close: () => undefined });
    authority.observeRegistry(registry); controller.abort();
    expect(epoch.signal.aborted).toBe(true); expect(() => authority.read('asset')).toThrow('policy_unavailable'); authority.close();
  });
  test('failed registry subscription blocks later admission and aborts old state', () => {
    const authority = createHostSecurityEpochAuthority(), epoch = authority.activate('asset');
    const broken = { observeSecurityCommits: () => ({ signal: new AbortController().signal, assertAvailable: () => { throw Error('private'); }, close: () => undefined }) };
    authority.observeRegistry(broken as unknown as UpstreamCredentialRegistry);
    expect(() => authority.read('asset')).toThrow('policy_unavailable'); expect(epoch.signal.aborted).toBe(true);
    expect(() => authority.activate('asset')).toThrow('policy_unavailable'); authority.close();
  });
});
