import { UpstreamCredentialRegistry } from './registry';
import { createHostCredentialGenerationStore } from './host-credential-generations';
import { createRegistryProviderEvidence } from './registry-provider-evidence';

function candidate(revision = 'r1', header = 'x-original'): any { return {
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' },
  reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
  secretProviders: { one: { type: 'env' }, two: { type: 'env' } },
  credentials: { token: { type: 'apiKey', placement: { in: 'header', name: header }, secretRef: 'one:TOKEN' },
    second: { type: 'bearer', secretRef: 'two:TOKEN' }, basic: { type: 'basic', usernameRef: 'one:USER', passwordRef: 'two:PASS' } },
  sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' },
    allowedHosts: ['fixture.invalid'], credential: 'token', endpoints: [] }],
}; }
const material = (label = 'old', expiresAt = Date.now() + 60000) => ({
  providers: { one: { TOKEN: `${label}-one`, USER: `${label}-user` }, two: { TOKEN: `${label}-two`, PASS: `${label}-password` } }, expiresAt,
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
describe('Registry immutable Provider generation evidence', () => {
  const cleanup: (() => void)[] = [];
  const fixture = (options: Record<string, unknown> = {}) => {
    const store = createHostCredentialGenerationStore(); const generation = store.activate(store.stage(material()), null);
    const evidence = createRegistryProviderEvidence(store);
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: evidence, ...options });
    cleanup.push(() => { evidence.close(); store.close(); }); return { store, generation, evidence, registry };
  };
  const context = (evidence: ReturnType<typeof createRegistryProviderEvidence>, snapshot: any, source = 'asset') =>
    Object.freeze({ snapshot, sourceServiceAssetId: source, providerEpoch: evidence.readEpoch(snapshot, source) });
  afterEach(() => { for (const close of cleanup.splice(0)) close(); jest.useRealTimers(); });

  it('pins all Providers and cross-Provider Basic to one generation across ordinary rotation', async () => {
    const f = fixture(); const old = await f.registry.reload(candidate());
    f.store.activate(f.store.stage(material('new')), f.generation);
    const latest = await f.registry.reload(candidate('r2'));
    expect(await old.resolveSecret('token')).toBe('old-one'); expect(await old.resolveSecret('second')).toBe('old-two');
    expect(await old.resolveBasicSecret!('basic')).toEqual({ username: 'old-user', password: 'old-password' });
    expect(await latest.resolveBasicSecret!('basic')).toEqual({ username: 'new-user', password: 'new-password' });
    expect(f.evidence.readEpoch(old, 'asset')).not.toBe(f.evidence.readEpoch(latest, 'asset'));
    expect(JSON.stringify([old, latest, f.evidence.issue(old, 'asset')])).not.toMatch(/old-one|old-user|old-password/);
  });
  it('captures before candidate/ownership awaits and never switches Provider generation mid-reload', async () => {
    const entered = deferred(), release = deferred();
    const f = fixture({ validateCandidateOwnership: async () => { entered.resolve(); await release.promise; } });
    const reload = f.registry.reload(candidate()); await entered.promise;
    f.store.activate(f.store.stage(material('new')), f.generation); release.resolve();
    const snapshot = await reload;
    expect(await snapshot.resolveSecret('second')).toBe('old-two');
    expect(await snapshot.resolveBasicSecret!('basic')).toEqual({ username: 'old-user', password: 'old-password' });
  });
  it.each(['revoke', 'unavailable', 'release'] as const)('%s during durable CAS preserves old active and monotonic history', async action => {
    let version = 0, names: string[] = []; const entered = deferred(), release = deferred(); let paused = false;
    const history = { load: async () => ({ version, names: [...names] }), commit: async (_ns: string, expected: number, next: readonly string[]) => {
      if (paused) { entered.resolve(); await release.promise; }
      if (expected !== version) return false; names = [...new Set([...names, ...next])].sort(); version++; return true;
    } };
    const f = fixture({ credentialHeaderHistory: { namespace: 'registry:evidence', store: history } });
    const old = await f.registry.reload(candidate());
    const next = f.store.activate(f.store.stage(material('new')), f.generation); paused = true;
    const reload = f.registry.reload(candidate('r2', 'x-retired')); await entered.promise;
    f.store[action](next); release.resolve(); await expect(reload).rejects.toBeDefined();
    expect(f.registry.captureSnapshot()).toBe(old); expect(names).toEqual(expect.arrayContaining(['x-original', 'x-retired']));
    expect(await old.resolveSecret('token')).toBe('old-one');
    const recovery = f.store.activate(f.store.stage(material('recovery')), next); expect(recovery).toBeDefined(); paused = false;
    const snapshot = await f.registry.reload(candidate('r3', 'x-current'));
    expect(snapshot.historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-original', 'x-retired', 'x-current']));
  });
  it.each(['throw', 'async'])('commit observer %s closes evidence and secret readers', async kind => {
    const f = fixture();
    const observer = kind === 'throw' ? () => { throw Error('PRIVATE_OBSERVER'); } : async () => { throw Error('PRIVATE_OBSERVER'); };
    const subscription = f.registry.observeSecurityCommits(observer);
    const snapshot = await f.registry.reload(candidate()); await Promise.resolve();
    expect(subscription.signal.aborted).toBe(true);
    expect(() => f.evidence.issue(snapshot, 'asset')).toThrow('UNAVAILABLE');
    await expect(snapshot.resolveSecret('token')).rejects.toBeDefined();
    expect(JSON.stringify(f.registry.getStatus())).not.toContain('PRIVATE_OBSERVER');
  });
  it('proof consumes once and contains no secret, epoch or snapshot data', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate());
    const proof = f.evidence.issue(snapshot, 'asset'); expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.keys(proof)).toEqual(['kind']);
    expect(f.evidence.consume(proof, context(f.evidence, snapshot))).toEqual({ expiresAt: expect.any(Number) });
    expect(f.evidence.consume(proof, context(f.evidence, snapshot))).toBeUndefined();
  });
  it.each(['clone', 'json', 'issuer', 'source', 'snapshot', 'epoch'])('refuses %s proof/context', async mode => {
    const f = fixture(), snapshot = await f.registry.reload(candidate()); const proof = f.evidence.issue(snapshot, 'asset');
    const ctx = context(f.evidence, snapshot);
    if (mode === 'clone' || mode === 'json') {
      expect(f.evidence.consume(mode === 'clone' ? { ...proof } : JSON.parse(JSON.stringify(proof)), ctx)).toBeUndefined();
    } else if (mode === 'issuer') {
      const other = createRegistryProviderEvidence(f.store); cleanup.push(() => other.close());
      expect(other.consume(proof, ctx)).toBeUndefined(); expect(() => other.issue(snapshot, 'asset')).toThrow();
    } else {
      const invalid = { ...ctx, ...(mode === 'source' ? { sourceServiceAssetId: 'other' } :
        mode === 'snapshot' ? { snapshot: { ...snapshot } } : { providerEpoch: 'invented' }) };
      expect(f.evidence.consume(proof, invalid)).toBeUndefined();
      expect(f.evidence.consume(proof, ctx)).toBeUndefined();
    }
  });
  it('expiry and monotonic rollback cannot extend a proof', async () => {
    jest.useFakeTimers(); const f = fixture(), snapshot = await f.registry.reload(candidate());
    const proof = f.evidence.issue(snapshot, 'asset', 100), ctx = context(f.evidence, snapshot), start = Date.now();
    jest.setSystemTime(start - 1000); jest.advanceTimersByTime(101);
    expect(f.evidence.consume(proof, ctx)).toBeUndefined();
  });
  it('proof cannot switch to another genuinely committed snapshot', async () => {
    const f = fixture(), first = await f.registry.reload(candidate());
    const proof = f.evidence.issue(first, 'asset'), second = await f.registry.reload(candidate('r2'));
    expect(f.evidence.consume(proof, context(f.evidence, second))).toBeUndefined();
    expect(f.evidence.consume(proof, context(f.evidence, first))).toBeUndefined();
  });
  it('generation expiry bounds proof expiry and rejects secret reads', async () => {
    jest.useFakeTimers(); const f = fixture();
    const next = f.store.activate(f.store.stage(material('short', Date.now() + 100)), f.generation);
    const snapshot = await f.registry.reload(candidate());
    const proof = f.evidence.issue(snapshot, 'asset', 1000), ctx = context(f.evidence, snapshot);
    const receipt = f.evidence.consume(proof, ctx)!;
    expect(receipt.expiresAt).toBe(f.store.describe(next).expiresAt);
    const remaining = f.evidence.issue(snapshot, 'asset', 1000); jest.advanceTimersByTime(101);
    expect(f.evidence.consume(remaining, ctx)).toBeUndefined();
    await expect(snapshot.resolveBasicSecret!('basic')).rejects.toBeDefined();
  });
  it('invalid cross-Provider Basic pair fails dry-run before any proof is associated', async () => {
    const f = fixture(); const input = material(); input.providers.one.USER = 'bad:user';
    f.store.activate(f.store.stage(input), f.generation);
    await expect(f.registry.reload(candidate())).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED' });
    expect(f.registry.getStatus().state).toBe('empty');
  });
  it('generation revocation rejects pending proof and all old secret reads', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate()); const proof = f.evidence.issue(snapshot, 'asset'), ctx = context(f.evidence, snapshot);
    f.store.revoke(f.generation);
    expect(f.evidence.consume(proof, ctx)).toBeUndefined(); expect(() => f.evidence.issue(snapshot, 'asset')).toThrow('DENIED');
    await expect(snapshot.resolveBasicSecret!('basic')).rejects.toBeDefined();
  });
  it.each(['schema', 'missing-material', 'ownership'])('failed %s reload cannot mint a proof', async mode => {
    const f = fixture(mode === 'ownership' ? { validateCandidateOwnership: async () => { throw Error('PRIVATE_OWNER'); } } : {});
    const input = candidate(); if (mode === 'schema') input.credentials.token.type = 'invalid';
    if (mode === 'missing-material') input.credentials.token.secretRef = 'one:MISSING';
    await expect(f.registry.reload(input)).rejects.toBeDefined(); expect(f.registry.getStatus().state).toBe('empty');
    expect(() => f.evidence.issue(Object.freeze({ candidate: input }) as any, 'asset')).toThrow();
  });
  it('rejects wrong source and unassociated ordinary snapshots', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate());
    expect(() => f.evidence.issue(snapshot, 'other')).toThrow('DENIED');
    const ordinary = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => 'plain' }) });
    const awaited = await ordinary.reload(candidate());
    expect(() => f.evidence.issue(awaited, 'asset')).toThrow('DENIED');
  });
  it('getter/unknown context burns proof without executing accessors', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate()); const proof = f.evidence.issue(snapshot, 'asset');
    const getter = jest.fn(() => snapshot), ctx = Object.defineProperty({ sourceServiceAssetId: 'asset', providerEpoch: f.evidence.readEpoch(snapshot, 'asset') }, 'snapshot', { get: getter });
    expect(f.evidence.consume(proof, ctx as any)).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
    expect(f.evidence.consume(proof, context(f.evidence, snapshot))).toBeUndefined();
    const second = f.evidence.issue(snapshot, 'asset');
    expect(f.evidence.consume(second, { ...context(f.evidence, snapshot), extra: 'private' } as any)).toBeUndefined();
  });
  it('close invalidates proofs and clears expiry timers', async () => {
    jest.useFakeTimers(); const f = fixture(), snapshot = await f.registry.reload(candidate()), proof = f.evidence.issue(snapshot, 'asset');
    const ctx = context(f.evidence, snapshot); f.evidence.close(); f.evidence.close();
    expect(f.evidence.consume(proof, ctx)).toBeUndefined(); expect(() => f.evidence.issue(snapshot, 'asset')).toThrow('UNAVAILABLE');
    f.store.close(); expect(jest.getTimerCount()).toBe(0);
  });
  it('rejects evidence clones and mixing an arbitrary provider factory', () => {
    const f = fixture();
    expect(() => new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: { ...f.evidence } })).toThrow('INVALID');
    expect(() => new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: f.evidence,
      providerFactory: d => ({ type: d.type, resolve: async () => 'untrusted' }) })).toThrow('INVALID');
  });
  it('readSignal is stable across snapshots in the same generation and ordinary rotation preserves old signals', async () => {
    const f = fixture(), first = await f.registry.reload(candidate());
    const signal = f.evidence.readSignal(first, 'asset');
    const sameGeneration = await f.registry.reload(candidate('r2'));
    expect(f.evidence.readSignal(first, 'asset')).toBe(signal);
    expect(f.evidence.readSignal(sameGeneration, 'asset')).toBe(signal);
    f.store.activate(f.store.stage(material('new')), f.generation);
    const latest = await f.registry.reload(candidate('r3'));
    expect(f.evidence.readSignal(latest, 'asset')).not.toBe(signal);
    expect(signal.aborted).toBe(false);
  });
  it.each(['revoke', 'unavailable', 'release', 'close'] as const)('signal synchronously reflects generation %s with trusted reason and detached listener', async action => {
    const f = fixture(), snapshot = await f.registry.reload(candidate());
    const raw = f.store.describe(f.generation).signal;
    const remove = jest.spyOn(raw, 'removeEventListener');
    const signal = f.evidence.readSignal(snapshot, 'asset'); let closedBeforeCallback = false;
    signal.addEventListener('abort', () => {
      try { f.evidence.readSignal(snapshot, 'asset'); } catch { closedBeforeCallback = true; }
    });
    if (action === 'close') f.store.close(); else f.store[action](f.generation);
    expect(signal.aborted).toBe(true); expect(closedBeforeCallback).toBe(true);
    expect(signal.reason.code).toBe(action === 'unavailable' || action === 'close' ? 'unavailable' : 'denied');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); remove.mockRestore();
  });
  it('generation expiry aborts composed signal despite wall clock rollback', async () => {
    jest.useFakeTimers(); const f = fixture();
    f.store.activate(f.store.stage(material('short', Date.now() + 100)), f.generation);
    const snapshot = await f.registry.reload(candidate()), signal = f.evidence.readSignal(snapshot, 'asset');
    jest.setSystemTime(Date.now() - 1000); jest.advanceTimersByTime(101);
    expect(signal.aborted).toBe(true); expect(signal.reason.code).toBe('denied');
  });
  it('issuer closes state before abort and detaches without revoking another issuer or shared store', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate());
    const other = createRegistryProviderEvidence(f.store); cleanup.push(() => other.close());
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: other });
    const otherSnapshot = await registry.reload(candidate());
    const shared = f.store.describe(f.generation).signal, remove = jest.spyOn(shared, 'removeEventListener');
    const signal = f.evidence.readSignal(snapshot, 'asset'), otherSignal = other.readSignal(otherSnapshot, 'asset');
    let alreadyClosed = false;
    signal.addEventListener('abort', () => { try { f.evidence.issue(snapshot, 'asset'); } catch { alreadyClosed = true; } });
    f.evidence.close(); f.evidence.close();
    expect(alreadyClosed).toBe(true); expect(signal.aborted).toBe(true); expect(signal.reason.code).toBe('unavailable');
    expect(otherSignal.aborted).toBe(false); expect(shared.aborted).toBe(false);
    expect(await otherSnapshot.resolveSecret('token')).toBe('old-one');
    expect(remove).toHaveBeenCalledTimes(1); remove.mockRestore();
  });
  it.each(['throw', 'async'])('Registry observer %s aborts previously issued signals immediately', async mode => {
    const f = fixture(), snapshot = await f.registry.reload(candidate()), signal = f.evidence.readSignal(snapshot, 'asset');
    f.registry.observeSecurityCommits(mode === 'throw' ? () => { throw Error('private'); } : async () => { throw Error('private'); });
    await f.registry.reload(candidate('r2')); await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(signal.reason.code).toBe('unavailable');
  });
  it('signal lookup rejects wrong source, snapshot clone and cross-issuer associations', async () => {
    const f = fixture(), snapshot = await f.registry.reload(candidate());
    expect(() => f.evidence.readSignal(snapshot, 'other')).toThrow('DENIED');
    expect(() => f.evidence.readSignal({ ...snapshot }, 'asset')).toThrow('DENIED');
    const other = createRegistryProviderEvidence(f.store); cleanup.push(() => other.close());
    expect(() => other.readSignal(snapshot, 'asset')).toThrow('DENIED');
  });
  it('bounds live generation signal cache and reclaims slots on terminal abort', async () => {
    const store = createHostCredentialGenerationStore({ maxGenerations: 300 });
    const evidence = createRegistryProviderEvidence(store); cleanup.push(() => { evidence.close(); store.close(); });
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: evidence });
    let current = store.activate(store.stage(material()), null); const first = current;
    for (let index = 0; index < 256; index++) {
      const snapshot = await registry.reload(candidate('bounded-' + index)); evidence.readSignal(snapshot, 'asset');
      current = store.activate(store.stage(material()), current);
    }
    const last = await registry.reload(candidate('last'));
    expect(() => evidence.readSignal(last, 'asset')).toThrow('UNAVAILABLE');
    store.revoke(first);
    expect(evidence.readSignal(last, 'asset').aborted).toBe(false);
  });

});
