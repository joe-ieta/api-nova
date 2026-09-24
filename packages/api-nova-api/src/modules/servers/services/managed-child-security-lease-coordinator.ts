/** Internal building block only; not registered in the production lifecycle.
 * Hosts must wire mutation barriers or per-call authorization; periodic checks
 * alone cannot guarantee a zero-request revocation window. */
export interface ManagedChildIsolationHandle {
  stop(): Promise<unknown>;
  readonly closed: Promise<unknown>;
}
export interface ManagedChildIsolationLease {
  readonly serverId: string;
  readonly launchId: string;
  readonly contextToken: string;
  readonly sourceAssetIds: readonly string[];
}
interface Entry { lease: ManagedChildIsolationLease; handle: ManagedChildIsolationHandle; blocked: boolean; stopping?: Promise<void>; }
export class ManagedChildSecurityLeaseCoordinator {
  private readonly entries = new Map<string, Entry>();
  register(lease: ManagedChildIsolationLease, handle: ManagedChildIsolationHandle): void {
    if (!lease.serverId || !lease.launchId || !lease.contextToken || this.entries.has(lease.serverId)) throw Error('MANAGED_ISOLATION_REGISTRATION_REJECTED');
    const entry: Entry = { lease: Object.freeze({ ...lease, sourceAssetIds: Object.freeze([...lease.sourceAssetIds]) }), handle, blocked: false };
    this.entries.set(lease.serverId, entry);
    void handle.closed.then(() => { if (this.entries.get(lease.serverId) === entry) this.entries.delete(lease.serverId); }, () => { entry.blocked = true; });
  }
  isAllowed(serverId: string, launchId: string): boolean {
    const entry = this.entries.get(serverId); return Boolean(entry && entry.lease.launchId === launchId && !entry.blocked);
  }
  /** Caller must await this barrier before acknowledging the corresponding mutation. */
  async isolateSource(sourceAssetId: string): Promise<void> {
    const affected = [...this.entries.values()].filter(entry => entry.lease.sourceAssetIds.includes(sourceAssetId));
    // Block all leases synchronously before asynchronous child shutdown begins.
    for (const entry of affected) entry.blocked = true;
    await Promise.all(affected.map(entry => this.isolate(entry)));
  }
  /** Opaque context is host-read, never tool args or a child-supplied assertion. */
  async revalidate(serverId: string, launchId: string, readContext: () => Promise<string>): Promise<boolean> {
    const entry = this.entries.get(serverId);
    if (!entry || entry.lease.launchId !== launchId || entry.blocked) return false;
    let current: string | undefined;
    try { current = await readContext(); } catch { /* Fail closed without exposing store errors. */ }
    if (this.entries.get(serverId) !== entry) return false;
    if (entry.blocked) return false;
    if (current !== entry.lease.contextToken) { await this.isolate(entry); return false; }
    return true;
  }
  private isolate(entry: Entry): Promise<void> {
    entry.blocked = true;
    if (!entry.stopping) entry.stopping = (async () => {
      try { await entry.handle.stop(); await entry.handle.closed; }
      catch { throw Error('MANAGED_ISOLATION_FAILED'); }
      if (this.entries.get(entry.lease.serverId) === entry) this.entries.delete(entry.lease.serverId);
    })();
    return entry.stopping;
  }
}
