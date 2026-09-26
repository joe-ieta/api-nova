import { Injectable } from '@nestjs/common';
import { In, IsNull, Repository } from 'typeorm';
import {
  RuntimeEventDeliveryAttemptEntity,
  RuntimeEventDeliveryEntity,
  RuntimeIngestReceiptEntity,
  RuntimeIngestReceiptTombstoneEntity,
  RuntimeObservabilityIdempotencyEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';
import { DAY_MS, ObservabilityStorageError, publicSequence } from './call-observability-storage';

export const LIFECYCLE_RETENTION_STATE_ID = 'call-observability:lifecycle-retention';
/** Approved floors; never lowered by configuration. */
export const DELIVERY_RETENTION_FLOOR_MS = 30 * DAY_MS;
export const RECEIPT_RETENTION_FLOOR_MS = 32 * DAY_MS;

export interface LifecycleRetentionCollectionOptions {
  scanLimit: number;
  deleteLimit: number;
  now?: Date;
}

export interface LifecycleRetentionCheckpoint {
  at: string;
  id: string;
}

export interface LifecycleRetentionPhaseReport {
  status: 'completed' | 'waiting';
  cutoff: string;
  scanned: number;
  deleted: number;
  retained: number;
  retainedReasons: Record<string, number>;
  checkpoint: LifecycleRetentionCheckpoint | null;
  snapshotSeq: string;
}

export interface LifecycleRetentionReceiptReport extends LifecycleRetentionPhaseReport {
  tombstoned: number;
}

export interface LifecycleRetentionDeliveryReport extends LifecycleRetentionPhaseReport {
  deletedDeliveries: number;
  deletedAttempts: number;
}

export interface LifecycleRetentionCollectionReport {
  status: 'completed' | 'waiting';
  startAt: string;
  idempotency: LifecycleRetentionPhaseReport;
  receipts: LifecycleRetentionReceiptReport;
  deliveries: LifecycleRetentionDeliveryReport;
  snapshotSeq: string;
}

type PhaseKey = 'idempotency' | 'receipts' | 'deliveries';

function readCheckpoint(value: unknown): LifecycleRetentionCheckpoint | null {
  const checkpoint = (value as { checkpoint?: unknown } | null)?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const { at, id } = checkpoint as { at?: unknown; id?: unknown };
  const parsed = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(parsed) || typeof id !== 'string' || !id) return null;
  return { at: new Date(parsed).toISOString(), id };
}

function readResourceId(value: unknown): string | null {
  const response = value && typeof value === 'object' ? value as { result?: unknown } : null;
  const result = response?.result && typeof response.result === 'object'
    ? response.result as { resourceId?: unknown } : null;
  return typeof result?.resourceId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(result.resourceId) ? result.resourceId : null;
}

/**
 * Bounded physical cleanup after logical expiry: expired management idempotency
 * records, expired ingest receipts (replaced by a minimal replay tombstone) and
 * expired delivery/attempt history. Every phase runs in its own Store
 * transaction, never allocates a business sequence, and persists its checkpoint
 * and report with the deletions. Events, invocations and audit rows are never
 * touched here. Tombstones have no expiry.
 */
@Injectable()
export class CallObservabilityLifecycleRetentionService {
  constructor(private readonly store: CallObservabilityStore) {}

  async collect(options: LifecycleRetentionCollectionOptions): Promise<LifecycleRetentionCollectionReport> {
    const { scanLimit, deleteLimit } = options;
    if (!Number.isSafeInteger(scanLimit) || !Number.isSafeInteger(deleteLimit)
      || scanLimit < 1 || deleteLimit < 1 || deleteLimit > scanLimit) {
      throw new ObservabilityStorageError('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');
    }
    const now = options.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new ObservabilityStorageError('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');
    }
    const idempotency = await this.collectIdempotency(scanLimit, deleteLimit, now);
    const receipts = await this.collectReceipts(scanLimit, deleteLimit, now);
    const deliveries = await this.collectDeliveries(scanLimit, deleteLimit, now);
    return {
      status: idempotency.status === 'completed' && receipts.status === 'completed' &&
        deliveries.status === 'completed' ? 'completed' : 'waiting',
      startAt: now.toISOString(),
      idempotency,
      receipts,
      deliveries,
      snapshotSeq: deliveries.snapshotSeq,
    };
  }

  private collectIdempotency(scanLimit: number, deleteLimit: number,
    now: Date): Promise<LifecycleRetentionPhaseReport> {
    const nowIso = now.toISOString();
    return this.store.transaction(async tx => {
      const states = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await states.findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID });
      const checkpoint = readCheckpoint(previous?.value?.idempotency);
      const repository = tx.manager.getRepository(RuntimeObservabilityIdempotencyEntity);
      const query = repository.createQueryBuilder('idempotency')
        .where('idempotency.expiresAt <= :now', { now: nowIso })
        .orderBy('idempotency.expiresAt', 'ASC')
        .addOrderBy('idempotency.id', 'ASC')
        .take(scanLimit);
      if (checkpoint) {
        query.andWhere(
          '(idempotency.expiresAt > :at OR (idempotency.expiresAt = :at AND idempotency.id > :id))',
          { at: checkpoint.at, id: checkpoint.id },
        );
      }
      const candidates = await query.getMany();
      const claimed = candidates.slice(0, deleteLimit);
      const exhausted = candidates.length < scanLimit;
      if (claimed.length > 0) await repository.delete({ id: In(claimed.map(row => row.id)) });
      const report: LifecycleRetentionPhaseReport = {
        status: exhausted && claimed.length === candidates.length ? 'completed' : 'waiting',
        cutoff: nowIso,
        scanned: candidates.length,
        deleted: claimed.length,
        retained: candidates.length - claimed.length,
        retainedReasons: {},
        checkpoint: this.nextCheckpoint(claimed, candidates.length, scanLimit,
          row => row.expiresAt),
        snapshotSeq: '',
      };
      report.snapshotSeq = await this.persistPhase(tx, states, previous, 'idempotency', report, nowIso);
      return report;
    });
  }

  private collectReceipts(scanLimit: number, deleteLimit: number,
    now: Date): Promise<LifecycleRetentionReceiptReport> {
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - RECEIPT_RETENTION_FLOOR_MS);
    const cutoffIso = cutoff.toISOString();
    return this.store.transaction(async tx => {
      const states = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await states.findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID });
      const checkpoint = readCheckpoint(previous?.value?.receipts);
      const receipts = tx.manager.getRepository(RuntimeIngestReceiptEntity);
      const tombstones = tx.manager.getRepository(RuntimeIngestReceiptTombstoneEntity);
      const query = receipts.createQueryBuilder('receipt')
        .where('receipt.expiresAt <= :now', { now: nowIso })
        .andWhere('receipt.createdAt <= :cutoff', { cutoff: cutoffIso })
        .orderBy('receipt.createdAt', 'ASC')
        .addOrderBy('receipt.id', 'ASC')
        .take(scanLimit);
      if (checkpoint) {
        query.andWhere(
          '(receipt.createdAt > :at OR (receipt.createdAt = :at AND receipt.id > :id))',
          { at: checkpoint.at, id: checkpoint.id },
        );
      }
      const candidates = await query.getMany();
      const retainedReasons: Record<string, number> = {};
      const retained = (reason: string) => {
        retainedReasons[reason] = (retainedReasons[reason] || 0) + 1;
      };
      let deleted = 0;
      let tombstoned = 0;
      let processed = 0;
      for (const receipt of candidates) {
        if (deleted >= deleteLimit) break;
        processed += 1;
        if (!/^[a-f0-9]{64}$/.test(receipt.recordHash)) {
          retained('invalid_record_hash');
          continue;
        }
        const existing = await tombstones.findOneBy({ id: receipt.id });
        if (existing && existing.recordHash !== receipt.recordHash) {
          retained('tombstone_conflict');
          continue;
        }
        if (!existing) {
          await tombstones.createQueryBuilder().insert().values({
            id: receipt.id,
            sourceInstanceId: receipt.sourceInstanceId,
            eventId: receipt.eventId,
            recordHash: receipt.recordHash,
            invocationId: receipt.invocationId,
            receiptCreatedAt: receipt.createdAt,
            receiptExpiresAt: receipt.expiresAt,
            tombstonedAt: tx.now,
          }).orIgnore().execute();
          tombstoned += 1;
        }
        await receipts.delete({ id: receipt.id });
        deleted += 1;
      }
      const processedRows = candidates.slice(0, processed);
      const last = processedRows[processedRows.length - 1];
      const exhausted = candidates.length < scanLimit && processed === candidates.length;
      const report: LifecycleRetentionReceiptReport = {
        status: exhausted ? 'completed' : 'waiting',
        cutoff: cutoffIso,
        scanned: candidates.length,
        deleted,
        tombstoned,
        retained: processed - deleted,
        retainedReasons,
        checkpoint: processed === 0 || exhausted ? null : { at: last.createdAt, id: last.id },
        snapshotSeq: '',
      };
      report.snapshotSeq = await this.persistPhase(tx, states, previous, 'receipts', report, nowIso);
      return report;
    });
  }

  private collectDeliveries(scanLimit: number, deleteLimit: number,
    now: Date): Promise<LifecycleRetentionDeliveryReport> {
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_FLOOR_MS);
    const cutoffIso = cutoff.toISOString();
    return this.store.transaction(async tx => {
      const states = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await states.findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID });
      const checkpoint = readCheckpoint(previous?.value?.deliveries);
      const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      const attempts = tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity);
      const query = deliveries.createQueryBuilder('delivery')
        .where('delivery.expiresAt <= :now', { now: nowIso })
        .andWhere('delivery.createdAt <= :cutoff', { cutoff: cutoffIso })
        .orderBy('delivery.expiresAt', 'ASC')
        .addOrderBy('delivery.id', 'ASC')
        .take(scanLimit);
      if (checkpoint) {
        query.andWhere(
          '(delivery.expiresAt > :at OR (delivery.expiresAt = :at AND delivery.id > :id))',
          { at: checkpoint.at, id: checkpoint.id },
        );
      }
      const candidates = await query.getMany();
      // Bounded valid-command protection: an unexpired idempotency row keeps its
      // referenced delivery result alive.
      const protectedIds = await this.readProtectedDeliveryIds(tx, scanLimit, nowIso);
      const retainedReasons: Record<string, number> = {};
      const deletable: string[] = [];
      let processed = 0;
      for (const candidate of candidates) {
        if (deletable.length >= deleteLimit) break;
        processed += 1;
        const reason = await this.deliveryRetentionReason(tx, candidate, now, protectedIds);
        if (reason) {
          retainedReasons[reason] = (retainedReasons[reason] || 0) + 1;
          continue;
        }
        deletable.push(candidate.id);
      }
      let deletedAttempts = 0;
      if (deletable.length > 0) {
        deletedAttempts = (await attempts.delete({ deliveryId: In(deletable) })).affected ?? 0;
        await deliveries.delete({ id: In(deletable) });
      }
      const processedRows = candidates.slice(0, processed);
      const last = processedRows[processedRows.length - 1];
      const exhausted = candidates.length < scanLimit && processed === candidates.length;
      const report: LifecycleRetentionDeliveryReport = {
        status: exhausted ? 'completed' : 'waiting',
        cutoff: cutoffIso,
        scanned: candidates.length,
        deleted: deletable.length,
        deletedDeliveries: deletable.length,
        deletedAttempts,
        retained: processed - deletable.length,
        retainedReasons,
        checkpoint: processed === 0 || exhausted ? null : { at: last.expiresAt, id: last.id },
        snapshotSeq: '',
      };
      report.snapshotSeq = await this.persistPhase(tx, states, previous, 'deliveries', report, nowIso);
      return report;
    });
  }

  private nextCheckpoint<T extends { id: string }>(claimed: T[], scanned: number, scanLimit: number,
    timeOf: (row: T) => string): LifecycleRetentionCheckpoint | null {
    if (claimed.length === 0) return null;
    const exhausted = scanned < scanLimit;
    if (exhausted && claimed.length === scanned) return null;
    const last = claimed[claimed.length - 1];
    return { at: timeOf(last), id: last.id };
  }

  private async readProtectedDeliveryIds(tx: ObservabilityWriteTransaction,
    scanLimit: number, nowIso: string): Promise<Set<string>> {
    const rows = await tx.manager.getRepository(RuntimeObservabilityIdempotencyEntity)
      .createQueryBuilder('idempotency')
      .where('idempotency.expiresAt > :now', { now: nowIso })
      .orderBy('idempotency.expiresAt', 'ASC')
      .addOrderBy('idempotency.id', 'ASC')
      .take(scanLimit)
      .getMany();
    const protectedIds = new Set<string>();
    for (const row of rows) {
      const resourceId = readResourceId(row.response);
      if (resourceId) protectedIds.add(resourceId);
    }
    return protectedIds;
  }

  private async deliveryRetentionReason(tx: ObservabilityWriteTransaction,
    delivery: RuntimeEventDeliveryEntity, now: Date, protectedIds: Set<string>): Promise<string | null> {
    const expiresAt = Date.parse(delivery.expiresAt);
    const createdAt = Date.parse(delivery.createdAt);
    const leaseUntil = delivery.leaseUntil === null ? null : Date.parse(delivery.leaseUntil);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) ||
      (delivery.leaseUntil !== null && !Number.isFinite(leaseUntil)) ||
      (delivery.leaseOwner !== null && delivery.leaseUntil === null)) {
      return 'invalid_timestamp';
    }
    if (leaseUntil !== null && leaseUntil > now.getTime()) return 'lease_active';
    if (delivery.status === 'in_flight') return 'open_attempt';
    const openAttempt = await tx.manager.getRepository(RuntimeEventDeliveryAttemptEntity)
      .findOne({ where: { deliveryId: delivery.id, completedAt: IsNull() } });
    if (openAttempt) return 'open_attempt';
    if (protectedIds.has(delivery.id)) return 'valid_command_result';
    return null;
  }

  private async persistPhase(tx: ObservabilityWriteTransaction,
    states: Repository<RuntimePipelineStateEntity>, previous: RuntimePipelineStateEntity | null,
    key: PhaseKey, report: LifecycleRetentionPhaseReport, nowIso: string): Promise<string> {
    const snapshotSeq = publicSequence(tx.currentSequence());
    report.snapshotSeq = snapshotSeq;
    const value = {
      ...(previous?.value || {}),
      [key]: report,
      lastCollectionAt: nowIso,
      stateVersion: Number(previous?.value?.stateVersion || 0) + 1,
      snapshotSeq,
    };
    await states.save(states.create({ id: LIFECYCLE_RETENTION_STATE_ID, value, updatedAt: tx.now }));
    return snapshotSeq;
  }
}
