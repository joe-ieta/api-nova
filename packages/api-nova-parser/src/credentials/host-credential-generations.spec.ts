import { createHostCredentialGenerationStore, HostCredentialGenerationError } from './host-credential-generations';
const material = (secret = 'test-secret', expiresAt = Date.now() + 10000) => ({ providers: { one: { token: secret, user: 'test-user', password: 'test-password' }, two: { token: secret + '-second' } }, basicPairs: [{ providerId: 'one', usernameKey: 'user', passwordKey: 'password' }], expiresAt });
describe('host-owned immutable credential generation store', () => {
  afterEach(() => jest.useRealTimers());
  test('stage is inert; activate atomically exposes complete multi-provider generation', () => {
    const store = createHostCredentialGenerationStore(), events: unknown[] = []; store.subscribe(event => { events.push(event); });
    const staged = store.stage(material()); expect(events).toEqual([]); expect(() => store.capture()).toThrow();
    const generation = store.activate(staged, null); expect(store.capture()).toBe(generation);
    expect(store.resolve(generation, 'one', 'token')).toBe('test-secret'); expect(store.resolve(generation, 'two', 'token')).toBe('test-secret-second');
    expect(events).toHaveLength(1); expect(JSON.stringify([staged, generation, store.describe(generation), events])).not.toMatch(/test-secret|test-user|test-password/); store.close();
  });
  test('input mutation and same labels cannot change a captured generation', () => {
    const store = createHostCredentialGenerationStore(), input = material(), staged = store.stage(input); input.providers.one.token = 'mutated';
    const old = store.activate(staged, null), next = store.activate(store.stage(material('new')), old);
    expect(store.resolve(old, 'one', 'token')).toBe('test-secret'); expect(store.resolve(next, 'one', 'token')).toBe('new');
    expect(store.describe(old).signal.aborted).toBe(false); expect(store.describe(old).generationId).not.toBe(store.describe(next).generationId); store.close();
  });
  test('concurrent CAS only one winner; losing staged generation remains retryable', async () => {
    const store = createHostCredentialGenerationStore(), old = store.activate(store.stage(material()), null), a = store.stage(material('a')), b = store.stage(material('b'));
    const results = await Promise.allSettled([Promise.resolve().then(() => store.activate(a, old)), Promise.resolve().then(() => store.activate(b, old))]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); const winner = store.capture();
    const retry = store.activate(b, winner); expect(store.resolve(retry, 'one', 'token')).toBe('b'); store.close();
  });
  test('failed CAS and validation have zero activation events', () => {
    const store = createHostCredentialGenerationStore(), observer = jest.fn(); store.subscribe(observer);
    expect(() => store.stage({ ...material(), providers: { bad: { token: 'private\nvalue' } } })).toThrow(HostCredentialGenerationError);
    const stage = store.stage(material()), old = store.activate(stage, null); observer.mockClear();
    expect(() => store.activate(store.stage(material('new')), null)).toThrow('CONFLICT'); expect(() => store.activate(stage, old)).toThrow('DENIED'); expect(observer).not.toHaveBeenCalled(); store.close();
  });
  test('copied, JSON and cross-store capabilities never authorize', () => {
    const a = createHostCredentialGenerationStore(), b = createHostCredentialGenerationStore(), staged = a.stage(material());
    expect(() => a.activate({ ...staged }, null)).toThrow(); expect(() => b.activate(staged, null)).toThrow(); const generation = a.activate(staged, null);
    for (const fake of [{ ...generation }, JSON.parse(JSON.stringify(generation))]) expect(() => a.resolve(fake, 'one', 'token')).toThrow();
    expect(() => b.resolve(generation, 'one', 'token')).toThrow(); a.close(); b.close();
  });
  test.each(['missing-password', 'invalid-user', 'same-key', 'duplicate'])('Basic pair %s is rejected before stage', mode => {
    const store = createHostCredentialGenerationStore(), input = material();
    if (mode === 'missing-password') delete (input.providers.one as any).password;
    if (mode === 'invalid-user') input.providers.one.user = 'bad:user';
    if (mode === 'same-key') input.basicPairs[0].passwordKey = 'user';
    if (mode === 'duplicate') input.basicPairs.push({ ...input.basicPairs[0] });
    expect(() => store.stage(input)).toThrow('INVALID'); expect(() => store.capture()).toThrow('UNAVAILABLE'); store.close();
  });
  test.each(['revoke', 'unavailable'] as const)('%s closes state before synchronous abort and rejects reentrant activation', action => {
    const store = createHostCredentialGenerationStore(), old = store.activate(store.stage(material()), null), next = store.stage(material('new')), signal = store.describe(old).signal;
    let closed = false, reentrant = false; signal.addEventListener('abort', () => { try { store.resolve(old, 'one', 'token'); } catch { closed = true; } try { store.activate(next, old); } catch { reentrant = true; } });
    store[action](old); expect(closed).toBe(true); expect(reentrant).toBe(true); expect(signal.aborted).toBe(true);
    expect(store.activate(next, old)).toBe(store.capture()); store.close();
  });
  test('observer failure immediately closes store and aborts active material', () => {
    const store = createHostCredentialGenerationStore(), old = store.activate(store.stage(material()), null), signal = store.describe(old).signal;
    const subscription = store.subscribe(() => { throw Error('private-secret'); });
    expect(() => store.activate(store.stage(material('new')), old)).toThrow('UNAVAILABLE'); expect(signal.aborted).toBe(true); expect(subscription.signal.aborted).toBe(true);
    expect(() => store.resolve(old, 'one', 'token')).toThrow('UNAVAILABLE'); store.close();
  });
  test('async observer is unsupported and fails closed without unhandled rejection', async () => {
    const store = createHostCredentialGenerationStore(); store.subscribe(async () => { throw Error('private'); });
    expect(() => store.activate(store.stage(material()), null)).toThrow('UNAVAILABLE'); await Promise.resolve(); store.close();
  });
  test('absolute and monotonic TTL expire active/staged materials and recover capacity', () => {
    jest.useFakeTimers(); const store = createHostCredentialGenerationStore({ maxGenerations: 2 }); const start = Date.now();
    const old = store.activate(store.stage(material('a', start + 100)), null), signal = store.describe(old).signal; store.stage(material('b', start + 100));
    expect(() => store.stage(material())).toThrow('CAPACITY'); jest.setSystemTime(start - 1000); jest.advanceTimersByTime(100);
    expect(signal.aborted).toBe(true); expect(() => store.resolve(old, 'one', 'token')).toThrow('DENIED'); expect(() => store.stage(material())).not.toThrow(); store.close(); expect(jest.getTimerCount()).toBe(0);
  });
  test('revoked tombstones retain TTL then free slots; released staged handles cannot activate', () => {
    jest.useFakeTimers(); const store = createHostCredentialGenerationStore({ maxGenerations: 1 }), old = store.activate(store.stage(material('a', Date.now() + 100)), null);
    store.revoke(old); expect(() => store.stage(material())).toThrow('CAPACITY'); jest.advanceTimersByTime(101); const staged = store.stage(material()); store.release(staged); expect(() => store.activate(staged, old)).toThrow('DENIED'); store.close();
  });
  test('release removes material and is idempotent; byte capacity recovers', () => {
    const input = material(), bytes = Object.values(input.providers).flatMap(Object.values).reduce((total, value) => total + Buffer.byteLength(value), 0);
    const store = createHostCredentialGenerationStore({ maxTotalBytes: bytes }), old = store.activate(store.stage(input), null); expect(() => store.stage(input)).toThrow('CAPACITY');
    store.release(old); store.release(old); expect(() => store.resolve(old, 'one', 'token')).toThrow(); expect(() => store.stage(input)).not.toThrow(); store.close();
  });
  test('close cleans timers/subscriptions and cannot be revived', () => {
    jest.useFakeTimers(); const store = createHostCredentialGenerationStore(), staged = store.stage(material()), old = store.activate(staged, null), signal = store.describe(old).signal; const subscription = store.subscribe(() => undefined);
    store.close(); store.close(); expect(signal.aborted).toBe(true); expect(subscription.signal.aborted).toBe(true); expect(jest.getTimerCount()).toBe(0); expect(() => store.stage(material())).toThrow('UNAVAILABLE');
  });
  test('path-shaped material keys are opaque names with no filesystem access', () => {
    const store = createHostCredentialGenerationStore(), generation = store.activate(store.stage({ providers: { privateFiles: { 'nested/token': 'fixture' } }, expiresAt: Date.now() + 1000 }), null);
    expect(store.resolve(generation, 'privateFiles', 'nested/token')).toBe('fixture'); expect(() => store.resolve(generation, 'privateFiles', '../token')).toThrow('INVALID'); store.close();
  });
  test('events see the new current generation; closed listeners receive nothing', () => {
    const store = createHostCredentialGenerationStore(), removed = jest.fn(); store.subscribe(removed).close();
    store.subscribe(event => { if (event.kind === 'activated') expect(store.describe(store.capture()).generationId).toBe(event.generationId); });
    store.activate(store.stage(material()), null); expect(removed).not.toHaveBeenCalled(); store.close();
  });
  test('safe errors do not retain rejected values or private causes', () => {
    const store = createHostCredentialGenerationStore(); let failure: unknown;
    try { store.stage(material('PRIVATE_SECRET\n')); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HostCredentialGenerationError); expect(JSON.stringify(failure)).not.toContain('PRIVATE_SECRET'); expect(String(failure)).not.toContain('PRIVATE_SECRET'); expect((failure as { cause?: unknown }).cause).toBeUndefined(); store.close();
  });
  test('Proxy traps are not invoked and prototype pollution never reaches ordinary objects', () => {
    const store = createHostCredentialGenerationStore(), trap = jest.fn(() => { throw Error('PRIVATE_SECRET'); });
    expect(() => store.stage(new Proxy(material(), { getPrototypeOf: trap }))).toThrow('INVALID'); expect(trap).not.toHaveBeenCalled();
    expect(() => store.stage(Object.assign(Object.create({ inherited: 'private' }), material()))).toThrow('INVALID');
    const providers = JSON.parse('{"safe":{"__proto__":"fixture","constructor":"fixture2"}}');
    const generation = store.activate(store.stage({ providers, expiresAt: Date.now() + 1000 }), null);
    expect(store.resolve(generation, 'safe', '__proto__')).toBe('fixture'); expect(({} as any).fixture).toBeUndefined(); store.close();
  });
  test('provider count, total key count and material bytes have strict limits', () => {
    const store = createHostCredentialGenerationStore();
    expect(() => store.stage({ providers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['p' + index, { token: 'fixture' }])), expiresAt: Date.now() + 1000 })).toThrow('INVALID');
    expect(() => store.stage({ providers: { p: Object.fromEntries(Array.from({ length: 513 }, (_, index) => ['k' + index, 'fixture'])) }, expiresAt: Date.now() + 1000 })).toThrow('INVALID'); store.close();
  });
  test('accessors and oversized/unknown input are rejected without invoking getters', () => {
    const store = createHostCredentialGenerationStore(), getter = jest.fn(() => 'secret'); const input = material(); Object.defineProperty(input.providers.one, 'token', { enumerable: true, get: getter });
    expect(() => store.stage(input)).toThrow('INVALID'); expect(getter).not.toHaveBeenCalled(); expect(() => store.stage({ ...material(), unexpected: true } as any)).toThrow('INVALID');
    expect(() => store.stage(material('a'.repeat(8193)))).toThrow('INVALID'); store.close();
  });
});
