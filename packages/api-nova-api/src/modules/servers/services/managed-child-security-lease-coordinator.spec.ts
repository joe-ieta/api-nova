import { ManagedChildSecurityLeaseCoordinator } from './managed-child-security-lease-coordinator';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const lease = (launchId = 'launch') => ({ serverId: 'server', launchId, contextToken: 'opaque-context', sourceAssetIds: ['source'] });
describe('internal managed child isolation building block', () => {
  it('keeps a matching host-read context and ignores stale launch IDs', async () => {
    const c = new ManagedChildSecurityLeaseCoordinator(), done = deferred<void>(), stop = jest.fn(async () => undefined); c.register(lease(), { stop, closed: done.promise });
    expect(await c.revalidate('server', 'launch', async () => 'opaque-context')).toBe(true);
    const read = jest.fn(async () => 'opaque-context'); expect(await c.revalidate('server', 'old', read)).toBe(false); expect(read).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); done.resolve();
  });
  it.each(['changed', 'unavailable'])('isolates %s context and awaits confirmed closure', async reason => {
    const c = new ManagedChildSecurityLeaseCoordinator(), done = deferred<void>(); const stop = jest.fn(async () => undefined); c.register(lease(), { stop, closed: done.promise });
    const result = c.revalidate('server', 'launch', async () => { if (reason === 'unavailable') throw Error('private-store-detail'); return 'changed'; });
    await new Promise(resolve => setImmediate(resolve)); expect(c.isAllowed('server', 'launch')).toBe(false); expect(stop).toHaveBeenCalledTimes(1); done.resolve(); expect(await result).toBe(false);
  });
  it('blocks all affected leases immediately and waits for all shutdowns', async () => {
    const c = new ManagedChildSecurityLeaseCoordinator(), a = deferred<void>(), b = deferred<void>(); c.register(lease(), { stop: async () => undefined, closed: a.promise }); c.register({ ...lease('other'), serverId: 'other' }, { stop: async () => undefined, closed: b.promise });
    const barrier = c.isolateSource('source'); expect(c.isAllowed('server', 'launch')).toBe(false); expect(c.isAllowed('other', 'other')).toBe(false); a.resolve(); b.resolve(); await barrier;
  });
  it('a late old-launch read never stops the replacement', async () => {
    const c = new ManagedChildSecurityLeaseCoordinator(), old = deferred<void>(), read = deferred<string>(), fresh = deferred<void>(); c.register(lease(), { stop: async () => undefined, closed: old.promise }); const pending = c.revalidate('server', 'launch', () => read.promise); old.resolve(); await Promise.resolve();
    const stop = jest.fn(async () => undefined); c.register(lease('new'), { stop, closed: fresh.promise }); read.resolve('changed'); expect(await pending).toBe(false); expect(stop).not.toHaveBeenCalled(); expect(c.isAllowed('server', 'new')).toBe(true); fresh.resolve();
  });
  it('coalesces concurrent invalidations into one stop per handle', async () => {
    const c = new ManagedChildSecurityLeaseCoordinator(), done = deferred<void>(); const stop = jest.fn(async () => undefined); c.register(lease(), { stop, closed: done.promise });
    const first = c.isolateSource('source'), second = c.isolateSource('source'); expect(stop).toHaveBeenCalledTimes(1); done.resolve(); await Promise.all([first, second]);
  });
  it('a failed stop cannot restore the lease or expose failure details', async () => {
    const c = new ManagedChildSecurityLeaseCoordinator(), done = deferred<void>(); c.register(lease(), { stop: async () => { throw Error('secret'); }, closed: done.promise });
    await expect(c.isolateSource('source')).rejects.toThrow('MANAGED_ISOLATION_FAILED'); expect(c.isAllowed('server', 'launch')).toBe(false); expect(() => c.register(lease('new'), { stop: async () => undefined, closed: done.promise })).toThrow(); done.resolve();
  });
});
