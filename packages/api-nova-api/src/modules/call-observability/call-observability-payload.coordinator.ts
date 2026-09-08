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
}

export interface PayloadLease { token: string; generation: string; }
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
      if (value.gc) throw new ObservabilityStorageError('PAYLOAD_GC_BUSY');
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
      if (value.gc) return { lease: null, reason: 'gc_active' as const };
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

  private requireWriter(value: CoordinationState, lease: PayloadLease): void {
    const writer = value.writers[lease.token];
    if (!writer || writer.owner !== this.owner || writer.expiresAt <= Date.now() ||
      value.generation !== lease.generation || value.gc && value.gc.expiresAt > Date.now()) {
      throw new ObservabilityStorageError('PAYLOAD_WRITE_LEASE_LOST');
    }
  }

  private prune(value: CoordinationState, now: number): void {
    for (const [token, lease] of Object.entries(value.writers)) {
      if (lease.expiresAt <= now) delete value.writers[token];
    }
    if (value.gc && value.gc.expiresAt <= now) value.gc = null;
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
