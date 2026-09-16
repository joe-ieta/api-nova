import { randomUUID } from 'crypto';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import type { ObservabilityWriteTransaction } from './call-observability.store';
import { ObservabilityStorageError, publicSequence, sequenceKey } from './call-observability-storage';

export const PAYLOAD_COORDINATION_ID = 'call-observability:payload-coordination';
export const PAYLOAD_OWNER_ID = 'call-observability:payload-owner';
const WRITE_LEASE_MS = 60_000;
const GC_LEASE_MS = 15_000;
const MAX_WRITERS = 128;

interface LeaseEntry { owner: string; expiresAt: number; }
interface CoordinationState {
  generation: string;
  writers: Record<string, LeaseEntry>;
  gc: (LeaseEntry & { token: string }) | null;
  inventory?: (LeaseEntry & { token: string; ownerId: string }) | null;
}

export interface PayloadLease { token: string; generation: string; }
export interface PayloadInventoryFence extends PayloadLease { ownerId: string; }
export interface PayloadInventoryFenceSession {
  readonly lease: PayloadInventoryFence;
  check(): Promise<void>;
  assertInTransaction(tx: ObservabilityWriteTransaction): Promise<void>;
}
type Transaction = <T>(operation: (tx: ObservabilityWriteTransaction) => Promise<T>) => Promise<T>;

/**
 * Short database transactions fence payload preparation from garbage collection.
 * The enclosing store transaction already holds the commit-counter row lock.
 */
export class CallObservabilityPayloadCoordinator {
  private readonly owner = randomUUID();

  constructor(private readonly transact: Transaction) {}

  async withWriter<T>(operation: (lease: PayloadLease) => Promise<T>): Promise<T> {
    const lease = await this.acquireWriter();
    let renewal: Promise<void> | undefined;
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped && !renewal) {
        renewal = this.renewWriter(lease).catch(() => {
          // The commit-time fence, not a background rejection, decides validity.
          stopped = true;
        }).finally(() => { renewal = undefined; });
      }
    }, WRITE_LEASE_MS / 3);
    timer.unref();
    try {
      return await operation(lease);
    } finally {
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
      // A database outage leaves a bounded lease, never an indefinitely held lock.
      await this.releaseWriter(lease).catch(() => undefined);
    }
  }

  async acquireWriter(): Promise<PayloadLease> {
    return this.transact(async tx => {
      const row = await this.state(tx);
      const value = row.value as CoordinationState;
      const now = Date.now();
      this.prune(value, now);
      if (value.gc || value.inventory) throw new ObservabilityStorageError('PAYLOAD_GC_BUSY');
      if (Object.keys(value.writers).length >= MAX_WRITERS) {
        throw new ObservabilityStorageError('STORAGE_BUSY');
      }
      const token = randomUUID();
      value.writers[token] = { owner: this.owner, expiresAt: now + WRITE_LEASE_MS };
      await this.save(tx, row);
      return { token, generation: value.generation };
    });
  }

  async assertWriter(tx: ObservabilityWriteTransaction, lease: PayloadLease): Promise<void> {
    const row = await this.state(tx);
    this.requireWriter(row.value, lease);
  }

  async renewWriter(lease: PayloadLease): Promise<void> {
    await this.transact(async tx => {
      const row = await this.state(tx);
      this.requireWriter(row.value, lease);
      row.value.writers[lease.token].expiresAt = Date.now() + WRITE_LEASE_MS;
      await this.save(tx, row);
    });
  }

  async releaseWriter(lease: PayloadLease): Promise<void> {
    await this.transact(async tx => {
      const row = await this.state(tx);
      if (row.value.writers[lease.token]?.owner === this.owner) {
        delete row.value.writers[lease.token];
        await this.save(tx, row);
      }
    });
  }

  async acquireGc(): Promise<{ lease: PayloadLease | null; reason?: 'writer_active' | 'gc_active' }> {
    return this.transact(async tx => {
      const row = await this.state(tx);
      const value = row.value as CoordinationState;
      const now = Date.now();
      this.prune(value, now);
      if (value.gc || value.inventory) return { lease: null, reason: 'gc_active' as const };
      if (Object.keys(value.writers).length > 0) return { lease: null, reason: 'writer_active' as const };
      // A new generation changes all future object IDs. An expired GC operation
      // can never unlink a path that a subsequent valid writer will publish.
      value.generation = publicSequence(sequenceKey(BigInt(value.generation) + BigInt(1)));
      const token = randomUUID();
      value.gc = { token, owner: this.owner, expiresAt: now + GC_LEASE_MS };
      await this.save(tx, row);
      return { lease: { token, generation: value.generation } };
    });
  }

  async assertGc(tx: ObservabilityWriteTransaction, lease: PayloadLease): Promise<void> {
    const row = await this.state(tx);
    const value = row.value as CoordinationState;
    if (!value.gc || value.gc.token !== lease.token || value.gc.owner !== this.owner ||
      value.gc.expiresAt <= Date.now() || value.generation !== lease.generation) {
      throw new ObservabilityStorageError('PAYLOAD_GC_LEASE_LOST');
    }
    value.gc.expiresAt = Date.now() + GC_LEASE_MS;
    await this.save(tx, row);
  }

  async releaseGc(lease: PayloadLease): Promise<void> {
    await this.transact(async tx => {
      const row = await this.state(tx);
      if (row.value.gc?.token === lease.token && row.value.gc.owner === this.owner) {
        row.value.gc = null;
        await this.save(tx, row);
      }
    });
  }

  /** The inventory fence keeps the current generation so an existing checkpoint
   * can be reverified. It excludes both writers and GC across scan batches. */
  async acquireInventoryFence(): Promise<{ lease: PayloadInventoryFence | null;
    reason?: 'writer_active' | 'gc_active' }> {
    return this.transact(async tx => {
      const ownerId = await this.storageOwner(tx);
      const row = await this.state(tx);
      const value = row.value as CoordinationState;
      this.prune(value, Date.now());
      if (value.gc || value.inventory) return { lease: null, reason: 'gc_active' as const };
      if (Object.keys(value.writers).length) return { lease: null, reason: 'writer_active' as const };
      const token = randomUUID();
      value.inventory = { token, owner: this.owner, ownerId, expiresAt: Date.now() + GC_LEASE_MS };
      await this.save(tx, row);
      return { lease: { token, generation: value.generation, ownerId } };
    });
  }

  async assertInventoryFence(tx: ObservabilityWriteTransaction, lease: PayloadInventoryFence): Promise<void> {
    const row = await this.state(tx);
    const value = row.value as CoordinationState;
    const currentOwner = await this.storageOwner(tx);
    if (!value.inventory || value.inventory.token !== lease.token || value.inventory.owner !== this.owner ||
      value.inventory.ownerId !== lease.ownerId || currentOwner !== lease.ownerId ||
      value.inventory.expiresAt <= Date.now() || value.generation !== lease.generation ||
      value.gc || Object.values(value.writers).some(writer => writer.expiresAt > Date.now())) {
      throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
    }
    value.inventory.expiresAt = Date.now() + GC_LEASE_MS;
    await this.save(tx, row);
  }

  async checkInventoryFence(lease: PayloadInventoryFence): Promise<void> {
    await this.transact(tx => this.assertInventoryFence(tx, lease));
  }

  async releaseInventoryFence(lease: PayloadInventoryFence): Promise<void> {
    await this.transact(async tx => {
      const row = await this.state(tx);
      const value = row.value as CoordinationState;
      const priorGeneration = value.generation;
      this.prune(value, Date.now());
      if (priorGeneration !== value.generation) {
        await this.save(tx, row);
      } else if (value.inventory?.token === lease.token && value.inventory.owner === this.owner &&
        value.inventory.ownerId === lease.ownerId && value.generation === lease.generation) {
        value.inventory = null;
        await this.save(tx, row);
      }
    });
  }

  private async finishInventoryFence(lease: PayloadInventoryFence): Promise<void> {
    await this.transact(async tx => {
      await this.assertInventoryFence(tx, lease);
      const row = await this.state(tx);
      row.value.inventory = null;
      await this.save(tx, row);
    });
  }

  /** A held callback may span many bounded batches. A failed heartbeat makes
   * the session unusable, and the final check prevents returning stale proof. */
  async withInventoryFence<T>(operation: (session: PayloadInventoryFenceSession) => Promise<T>): Promise<
    { status: 'completed'; result: T } | { status: 'busy'; reason: 'writer_active' | 'gc_active' }> {
    const acquired = await this.acquireInventoryFence();
    if (!acquired.lease) return { status: 'busy', reason: acquired.reason! };
    const lease = acquired.lease;
    let stopped = false;
    let lost = false;
    let renewal: Promise<void> | undefined;
    const check = async (): Promise<void> => {
      if (stopped || lost) throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
      await this.checkInventoryFence(lease);
    };
    const timer = setInterval(() => {
      if (!stopped && !lost && !renewal) {
        renewal = this.checkInventoryFence(lease).catch(() => { lost = true; })
          .finally(() => { renewal = undefined; });
      }
    }, GC_LEASE_MS / 3);
    timer.unref();
    try {
      const result = await operation({ lease, check, assertInTransaction: tx => {
        if (stopped || lost) throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
        return this.assertInventoryFence(tx, lease);
      } });
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
      if (lost) throw new ObservabilityStorageError('PAYLOAD_INVENTORY_FENCE_LOST');
      await this.checkInventoryFence(lease);
      await this.finishInventoryFence(lease);
      return { status: 'completed', result };
    } finally {
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
      // An outage retains a bounded lease; it must never make stale proof valid.
      await this.releaseInventoryFence(lease).catch(() => undefined);
    }
  }

  private requireWriter(value: CoordinationState, lease: PayloadLease): void {
    const writer = value.writers[lease.token];
    if (!writer || writer.owner !== this.owner || writer.expiresAt <= Date.now() ||
      value.generation !== lease.generation || value.gc && value.gc.expiresAt > Date.now() || value.inventory) {
      throw new ObservabilityStorageError('PAYLOAD_WRITE_LEASE_LOST');
    }
  }

  private prune(value: CoordinationState, now: number): void {
    for (const [token, lease] of Object.entries(value.writers)) {
      if (lease.expiresAt <= now) delete value.writers[token];
    }
    if (value.gc && value.gc.expiresAt <= now) value.gc = null;
    if (value.inventory && value.inventory.expiresAt <= now && !value.gc &&
      Object.keys(value.writers).length === 0) {
      // The old scan can no longer attest the prefix after a lease gap.
      value.generation = publicSequence(sequenceKey(BigInt(value.generation) + BigInt(1)));
      value.inventory = null;
    }
  }

  private async storageOwner(tx: ObservabilityWriteTransaction): Promise<string> {
    const row = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: PAYLOAD_OWNER_ID });
    const ownerId = row?.value?.ownerId;
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(ownerId)) {
      throw new ObservabilityStorageError('PAYLOAD_STORAGE_NOT_BOUND');
    }
    return ownerId;
  }

  private async state(tx: ObservabilityWriteTransaction): Promise<RuntimePipelineStateEntity> {
    const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
    const existing = await repository.findOne({ where: { id: PAYLOAD_COORDINATION_ID } });
    if (existing) return existing;
    return repository.create({
      id: PAYLOAD_COORDINATION_ID, value: { generation: '0', writers: {}, gc: null }, updatedAt: tx.now,
    });
  }

  private async save(tx: ObservabilityWriteTransaction, row: RuntimePipelineStateEntity): Promise<void> {
    row.updatedAt = new Date().toISOString();
    await tx.manager.getRepository(RuntimePipelineStateEntity).save(row);
  }
}
