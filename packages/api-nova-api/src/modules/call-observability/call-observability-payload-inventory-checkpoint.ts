import {
  RuntimePayloadInventoryCheckpointEntity as Checkpoint,
  RuntimePayloadQuotaLedgerEntity as Ledger,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import type { ObservabilityReadTransaction, ObservabilityWriteTransaction } from './call-observability.store';
import type {
  PayloadInventoryBatch, PayloadInventoryResumeEvidence, PayloadInventoryShardCheckpoint,
} from './call-observability-payload-inventory';
import { PAYLOAD_COORDINATION_ID, PAYLOAD_OWNER_ID } from './call-observability-payload.coordinator';
import { ObservabilityStorageError, publicSequence } from './call-observability-storage';

const SHARDS = 256;
const MAX_VERSION = 2147483647;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (code: string): never => { throw new ObservabilityStorageError(code); };
type Transaction = ObservabilityReadTransaction | ObservabilityWriteTransaction;

export interface UnverifiedPayloadInventoryCheckpoint {
  readonly unverified: true;
  readonly writerFenceRequired: true;
  readonly baselineReady: false;
  readonly ownerId: string;
  readonly epoch: string;
  readonly generation: string;
  readonly version: number;
  readonly nextShard: number;
  readonly observedBytes: number;
  readonly observedFiles: number;
  /** Pass this to 05C1 openInventory(nextShard, resumeEvidence) before trusting the prefix. */
  readonly resumeEvidence: PayloadInventoryResumeEvidence;
}

function validatedRows(value: unknown, start: number): PayloadInventoryShardCheckpoint[] {
  if (!Array.isArray(value) || !Number.isInteger(start) || start < 0 || start + value.length > SHARDS) {
    return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
  }
  return value.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
    const row = input as PayloadInventoryShardCheckpoint;
    if (Object.keys(row).length !== 6 || row.shard !== start + index ||
      !['present', 'absent'].includes(row.state) ||
      !Number.isSafeInteger(row.observedBytes) || row.observedBytes < 0 ||
      !Number.isSafeInteger(row.observedFiles) || row.observedFiles < 0 ||
      !Number.isSafeInteger(row.scannedEntries) || row.scannedEntries < 0 ||
      row.observedFiles > row.scannedEntries ||
      (row.state === 'present' && !SHA256.test(row.directoryIdentity || '')) ||
      (row.state === 'absent' && (row.directoryIdentity !== null ||
        row.observedBytes !== 0 || row.observedFiles !== 0 || row.scannedEntries !== 0))) {
      return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
    }
    return { shard: row.shard, state: row.state, directoryIdentity: row.directoryIdentity,
      observedBytes: row.observedBytes, observedFiles: row.observedFiles, scannedEntries: row.scannedEntries };
  });
}

function totals(rows: PayloadInventoryShardCheckpoint[]): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  for (const row of rows) {
    bytes += row.observedBytes; files += row.observedFiles;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
  }
  return { bytes, files };
}

function validatedBatch(batch: PayloadInventoryBatch): PayloadInventoryShardCheckpoint[] {
  if (!batch || typeof batch !== 'object' || !SHA256.test(batch.rootIdentity) ||
    !/^[a-f0-9-]{36}$/.test(batch.sessionId) ||
    !Number.isInteger(batch.startShard) || batch.startShard < 0 || batch.startShard > SHARDS ||
    !Number.isInteger(batch.nextShard) || batch.nextShard < batch.startShard || batch.nextShard > SHARDS ||
    batch.prefixVerified !== true || batch.writerFenceRequired !== true || batch.baselineReady !== false ||
    batch.rangeComplete !== (batch.nextShard === SHARDS) ||
    batch.coverage !== (batch.nextShard === SHARDS ? 'complete' : 'incomplete') ||
    (batch.inProgressShard !== null && batch.inProgressShard !== batch.nextShard) ||
    (batch.nextShard === SHARDS && batch.inProgressShard !== null) ||
    !Array.isArray(batch.completedShards) || batch.completedShards.length > batch.nextShard - batch.startShard) {
    return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
  }
  const rows = validatedRows(batch.completedShards, batch.nextShard - batch.completedShards.length);
  const sum = totals(rows);
  if (batch.checkpointedBytes !== sum.bytes || batch.checkpointedFiles !== sum.files ||
    !Number.isSafeInteger(batch.scannedEntries) || batch.scannedEntries < 0) {
    return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
  }
  return rows;
}

/** Database-only, unverified progress. It never acquires a writer/GC fence,
 * confirms a quota baseline, edits reservations, or changes quota state.
 * Only a later fenced coordinator may re-open and verify the persisted prefix. */
export class PayloadInventoryCheckpointStore {
  private async scope(tx: Transaction, epoch: string): Promise<{ ownerId: string; generation: string }> {
    const pipeline = tx.manager.getRepository(RuntimePipelineStateEntity);
    const owner = await pipeline.findOneBy({ id: PAYLOAD_OWNER_ID });
    const ownerId = owner?.value?.ownerId;
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(ownerId)) return fail('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY');
    const ledger = await tx.manager.getRepository(Ledger).findOneBy({ ownerId });
    if (!ledger || ledger.configuration?.enabled !== true || ledger.baselineKey !== null) {
      return fail('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY');
    }
    if (typeof epoch !== 'string' || epoch !== ledger.epoch) return fail('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH');
    const coordination = await pipeline.findOneBy({ id: PAYLOAD_COORDINATION_ID });
    if (typeof coordination?.value?.generation !== 'string') return fail('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY');
    let generation: string;
    try { generation = publicSequence(coordination.value.generation); }
    catch { return fail('PAYLOAD_INVENTORY_CHECKPOINT_NOT_READY'); }
    return { ownerId, generation };
  }

  private view(row: Checkpoint): UnverifiedPayloadInventoryCheckpoint {
    if (!Number.isInteger(row.version) || row.version < 0 || row.version >= MAX_VERSION ||
      !Number.isInteger(row.nextShard) || row.nextShard < 1 || row.nextShard > SHARDS ||
      !SHA256.test(row.rootIdentity) || !/^[a-f0-9-]{36}$/.test(row.epoch) ||
      !/^(0|[1-9][0-9]{0,19})$/.test(row.generation)) {
      return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
    }
    const completedShards = validatedRows(row.completedShards, 0);
    if (completedShards.length !== row.nextShard) return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
    const sum = totals(completedShards);
    return { unverified: true, writerFenceRequired: true, baselineReady: false,
      ownerId: row.ownerId, epoch: row.epoch, generation: row.generation, version: row.version,
      nextShard: row.nextShard, observedBytes: sum.bytes, observedFiles: sum.files,
      resumeEvidence: { rootIdentity: row.rootIdentity, completedShards } };
  }

  async load(tx: ObservabilityReadTransaction | ObservabilityWriteTransaction,
    epoch: string): Promise<UnverifiedPayloadInventoryCheckpoint | null> {
    const { ownerId, generation } = await this.scope(tx, epoch);
    const row = await tx.manager.getRepository(Checkpoint).findOneBy({ ownerId });
    if (!row) return null;
    if (row.epoch !== epoch || row.generation !== generation) return fail('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH');
    return this.view(row);
  }

  async append(tx: ObservabilityWriteTransaction, epoch: string, expectedVersion: number | null,
    batch: PayloadInventoryBatch): Promise<{ checkpoint: UnverifiedPayloadInventoryCheckpoint; replayed: boolean }> {
    const { ownerId, generation } = await this.scope(tx, epoch);
    const rows = validatedBatch(batch);
    if (rows.length === 0) return fail('INVALID_PAYLOAD_INVENTORY_CHECKPOINT');
    const repository = tx.manager.getRepository(Checkpoint);
    const existing = await repository.findOneBy({ ownerId });
    if (!existing) {
      if (expectedVersion !== null || batch.startShard !== 0 || rows.length !== batch.nextShard) {
        return fail('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT');
      }
      const row = repository.create({ ownerId, epoch, generation, rootIdentity: batch.rootIdentity,
        version: 0, nextShard: batch.nextShard, completedShards: rows, updatedAt: tx.now });
      await repository.insert(row);
      return { checkpoint: this.view(row), replayed: false };
    }
    const previous = this.view(existing);
    if (existing.epoch !== epoch || existing.generation !== generation ||
      existing.rootIdentity !== batch.rootIdentity) return fail('PAYLOAD_INVENTORY_CHECKPOINT_SCOPE_MISMATCH');
    const first = batch.nextShard - rows.length;
    if (batch.nextShard <= existing.nextShard) {
      if (first < 0 || rows.some((row, index) =>
        JSON.stringify(row) !== JSON.stringify(previous.resumeEvidence.completedShards[first + index]))) {
        return fail('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT');
      }
      return { checkpoint: previous, replayed: true };
    }
    if (first !== existing.nextShard || expectedVersion !== existing.version ||
      existing.version >= MAX_VERSION - 1) return fail('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT');
    const completedShards = [...previous.resumeEvidence.completedShards, ...rows];
    totals(completedShards);
    const result = await repository.update({ ownerId, epoch, generation, version: existing.version },
      { version: existing.version + 1, nextShard: batch.nextShard, completedShards, updatedAt: tx.now });
    if (result.affected !== 1) return fail('PAYLOAD_INVENTORY_CHECKPOINT_CONFLICT');
    return { checkpoint: this.view(Object.assign(existing, {
      version: existing.version + 1, nextShard: batch.nextShard, completedShards, updatedAt: tx.now,
    })), replayed: false };
  }
}
