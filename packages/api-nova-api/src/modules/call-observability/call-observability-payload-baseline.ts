import {
  RuntimePayloadQuotaLedgerEntity as Ledger, RuntimePayloadQuotaReservationEntity as Reservation,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { PayloadInventoryCheckpointStore, UnverifiedPayloadInventoryCheckpoint } from './call-observability-payload-inventory-checkpoint';
import { PayloadInventoryShardCheckpoint } from './call-observability-payload-inventory';
import { PayloadInventoryFenceSession } from './call-observability-payload.coordinator';
import { PayloadQuotaPrimitives, PayloadQuotaStatus } from './call-observability-payload-quota';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

const SHARDS = 256;
const MAX_BATCH_ENTRIES = 1000;
const MAX_BATCHES = 10_000;
const fail = (code: string): never => { throw new ObservabilityStorageError(code); };

export type FencedPayloadBaselineResult =
  | { status: 'busy'; reason: 'writer_active' | 'gc_active' }
  | { status: 'incomplete'; reason: 'scan_budget_exhausted'; nextShard: number; checkpointVersion: number | null; }
  | { status: 'confirmed'; ownerId: string; epoch: string; generation: string;
      observedBytes: number; observedFiles: number; quota: PayloadQuotaStatus; };

/** Explicit, internal initialization only. No controller, timer or startup hook invokes it.
 * It certifies the managed payload root against writes using this coordinator;
 * direct external disk mutation cannot share a database/filesystem atomic snapshot.
 * Every persisted prefix is rescanned while the fence is held. The final
 * transaction rechecks the root and ledger. Quota enforcement remains off. */
export class FencedPayloadBaselineService {
  private readonly checkpoints = new PayloadInventoryCheckpointStore();
  private readonly quota = new PayloadQuotaPrimitives();

  constructor(private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore) {}

  async advance(epoch: string, options: { maxBatches?: number; maxEntriesPerBatch?: number } = {})
    : Promise<FencedPayloadBaselineResult> {
    const maxBatches = options.maxBatches ?? 32;
    const maxEntries = options.maxEntriesPerBatch ?? MAX_BATCH_ENTRIES;
    if (typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(epoch) ||
      !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_BATCHES ||
      !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_BATCH_ENTRIES) {
      return fail('INVALID_PAYLOAD_INVENTORY_BASELINE_REQUEST');
    }
    const boundOwner = await this.store.ensurePayloadStorage();
    await this.payloads.assertOwnedRoot();
    const held = await this.store.payloadCoordination.withInventoryFence(async fence => {
      if (boundOwner !== fence.lease.ownerId) return fail('PAYLOAD_INVENTORY_BASELINE_SCOPE_MISMATCH');
      const loaded = await this.store.readSnapshot(tx => this.checkpoints.loadForRebuild(tx, epoch));
      let checkpoint = loaded.checkpoint;
      if (loaded.currentGeneration !== fence.lease.generation ||
        checkpoint && checkpoint.ownerId !== fence.lease.ownerId) {
        return fail('PAYLOAD_INVENTORY_BASELINE_SCOPE_MISMATCH');
      }
      if (checkpoint && checkpoint.generation !== fence.lease.generation) {
        const old = checkpoint;
        await this.store.transaction(async tx => {
          await fence.assertInTransaction(tx);
          await this.checkpoints.discardUnverified(tx, epoch, old, fence.lease.generation);
          await fence.assertInTransaction(tx);
        });
        checkpoint = null;
      }
      // A persisted prefix is only unverified progress: directory identity
      // alone cannot detect in-place body rewrites. Always rescan from shard 0.
      const session = await this.payloads.openInventory();
      const verifiedRows: PayloadInventoryShardCheckpoint[] = [];
      let complete = false;
      try {
        for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
          await fence.check();
          const batch = await session.scanBatch(maxEntries);
          await fence.check();
          const durablePrefix = checkpoint?.nextShard ?? 0;
          let stale = !!checkpoint && batch.rootIdentity !== checkpoint.resumeEvidence.rootIdentity;
          for (const row of batch.completedShards) {
            if (row.shard !== verifiedRows.length) return fail('PAYLOAD_INVENTORY_BASELINE_INCOMPLETE');
            if (!stale && checkpoint && row.shard < durablePrefix &&
              canonicalJson(row) !== canonicalJson(checkpoint.resumeEvidence.completedShards[row.shard])) stale = true;
            verifiedRows.push(row);
          }
          if (stale) {
            const old = checkpoint!;
            checkpoint = await this.store.transaction(async tx => {
              await fence.assertInTransaction(tx);
              await this.checkpoints.discardUnverified(tx, epoch, old, fence.lease.generation);
              if (!verifiedRows.length) {
                await fence.assertInTransaction(tx);
                return null;
              }
              const result = await this.checkpoints.append(tx, epoch, null, {
                ...batch, completedShards: verifiedRows,
                checkpointedBytes: verifiedRows.reduce((sum, row) => sum + row.observedBytes, 0),
                checkpointedFiles: verifiedRows.reduce((sum, row) => sum + row.observedFiles, 0),
              });
              await fence.assertInTransaction(tx);
              return result.checkpoint;
            });
          } else {
            const suffix = batch.completedShards.filter(row => row.shard >= durablePrefix);
            if (suffix.length) {
              const expectedVersion = checkpoint?.version ?? null;
              const saved = await this.store.transaction(async tx => {
                await fence.assertInTransaction(tx);
                const result = await this.checkpoints.append(tx, epoch, expectedVersion, {
                  ...batch, completedShards: suffix,
                  checkpointedBytes: suffix.reduce((sum, row) => sum + row.observedBytes, 0),
                  checkpointedFiles: suffix.reduce((sum, row) => sum + row.observedFiles, 0),
                });
                await fence.assertInTransaction(tx);
                return result.checkpoint;
              });
              checkpoint = saved;
            }
          }
          if (batch.rangeComplete && batch.inProgressShard === null) {
            complete = true;
            break;
          }
        }
      } finally {
        await session.close();
      }
      if (!complete) return { status: 'incomplete' as const, reason: 'scan_budget_exhausted' as const,
        nextShard: checkpoint?.nextShard ?? 0, checkpointVersion: checkpoint?.version ?? null };
      if (verifiedRows.length !== SHARDS) return fail('PAYLOAD_INVENTORY_BASELINE_INCOMPLETE');
      return this.confirm(fence, epoch, checkpoint, verifiedRows);
    });
    if (held.status === 'busy') return { status: 'busy', reason: held.reason };
    return held.result;
  }

  /** Keep the final filesystem recheck, checkpoint read, reservation check, and
   * ledger CAS in one Store transaction. Any failure leaves baselineKey null. */
  private async confirm(fence: PayloadInventoryFenceSession, epoch: string,
    expected: UnverifiedPayloadInventoryCheckpoint | null, verifiedRows: PayloadInventoryShardCheckpoint[])
    : Promise<Extract<FencedPayloadBaselineResult, { status: 'confirmed' }>> {
    return this.store.transaction(async tx => {
      await fence.assertInTransaction(tx);
      const checkpoint = await this.checkpoints.load(tx, epoch);
      if (!checkpoint || !expected || checkpoint.nextShard !== SHARDS ||
        checkpoint.ownerId !== fence.lease.ownerId || checkpoint.generation !== fence.lease.generation ||
        checkpoint.version !== expected.version || checkpoint.resumeEvidence.rootIdentity !== expected.resumeEvidence.rootIdentity ||
        checkpoint.observedBytes !== expected.observedBytes || checkpoint.observedFiles !== expected.observedFiles ||
        verifiedRows.length !== SHARDS ||
        canonicalJson(checkpoint.resumeEvidence.completedShards) !== canonicalJson(verifiedRows)) {
        return fail('PAYLOAD_INVENTORY_BASELINE_SCOPE_MISMATCH');
      }
      // Re-open the saved complete prefix rather than trusting a prior scan
      // result; the session rechecks every shard and the managed root.
      const recheck = await this.payloads.openInventory(SHARDS, checkpoint.resumeEvidence);
      try {
        const batch = await recheck.scanBatch(1);
        if (!batch.prefixVerified || !batch.rangeComplete || batch.coverage !== 'complete' ||
          batch.nextShard !== SHARDS || batch.rootIdentity !== checkpoint.resumeEvidence.rootIdentity) {
          return fail('PAYLOAD_INVENTORY_BASELINE_INCOMPLETE');
        }
      } finally {
        await recheck.close();
      }
      await fence.assertInTransaction(tx);
      const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId: fence.lease.ownerId });
      if (!ledger || ledger.epoch !== epoch || ledger.configuration?.enabled !== true ||
        ledger.state !== 'initializing' || ledger.baselineKey !== null ||
        ledger.committedBytes !== '0' || ledger.reservedBytes !== '0') {
        return fail('PAYLOAD_INVENTORY_BASELINE_NOT_READY');
      }
      // Unknown, unsettled, or stale-epoch reservations cannot be treated as
      // free space. Recovery owns their reconciliation in C2C.
      if (await tx.manager.getRepository(Reservation).countBy({ ownerId: fence.lease.ownerId })) {
        return fail('PAYLOAD_INVENTORY_BASELINE_RESERVATIONS_PRESENT');
      }
      const evidenceId = 'fenced:' + contentHash(canonicalJson([
        fence.lease.ownerId, epoch, fence.lease.generation, checkpoint.resumeEvidence.rootIdentity,
        checkpoint.version, checkpoint.observedBytes, checkpoint.observedFiles,
      ]));
      const quota = await this.quota.confirmBaseline(tx, epoch,
        { kind: 'complete_inventory', evidenceId, committedBytes: checkpoint.observedBytes });
      await fence.assertInTransaction(tx);
      return { status: 'confirmed', ownerId: fence.lease.ownerId, epoch,
        generation: fence.lease.generation, observedBytes: checkpoint.observedBytes,
        observedFiles: checkpoint.observedFiles, quota };
    });
  }
}