import { Injectable } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import {
  AuditAction,
  AuditLevel,
  AuditLog,
  AuditStatus,
} from '../../database/entities/audit-log.entity';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { DAY_MS, ObservabilityStorageError, publicSequence } from './call-observability-storage';

/**
 * Explicit attribution only: management audit rows the call-observability
 * function itself creates. Generic CONFIG_UPDATED rows and records without an
 * attributable resource are never selected for cleanup.
 */
export const OBSERVABILITY_AUDIT_RESOURCES = Object.freeze([
  'observability_caller',
  'observability_delivery',
  'observability_policy',
  'observability_subscription',
  'observability.payload',
  'observability_audit',
] as const);

export const AUDIT_RETENTION_MIN_DAYS = 30;
export const OBSERVABILITY_AUDIT_RETENTION_STATE_ID = 'call-observability:audit-retention';

export interface AuditRetentionCollectionOptions {
  scanLimit: number;
  deleteLimit: number;
  retentionMs: number;
  now?: Date;
}

export interface AuditRetentionCollectionReport {
  status: 'completed' | 'waiting';
  scanned: number;
  deleted: number;
  cutoff: string;
  snapshotSeq: string;
}

interface AuditCheckpoint {
  createdAt: string;
  id: string;
}

function readCheckpoint(value: unknown): AuditCheckpoint | null {
  const checkpoint = (value as { checkpoint?: unknown } | null)?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const { createdAt, id } = checkpoint as { createdAt?: unknown; id?: unknown };
  const parsed = typeof createdAt === 'string' ? new Date(createdAt) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || typeof id !== 'string' || !id) return null;
  return { createdAt: parsed.toISOString(), id };
}

/**
 * Bounded, attributed removal of this function's own management audit records.
 * Delete, checkpoint and the single bounded management record share one Store
 * transaction; anything not explicitly attributed is retained.
 */
@Injectable()
export class CallObservabilityAuditRetentionService {
  constructor(private readonly store: CallObservabilityStore) {}

  async collect(options: AuditRetentionCollectionOptions): Promise<AuditRetentionCollectionReport> {
    const { scanLimit, deleteLimit, retentionMs } = options;
    if (!Number.isSafeInteger(scanLimit) || !Number.isSafeInteger(deleteLimit)
      || scanLimit < 1 || deleteLimit < 1 || deleteLimit > scanLimit) {
      throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
    }
    if (!Number.isSafeInteger(retentionMs) || retentionMs < AUDIT_RETENTION_MIN_DAYS * DAY_MS) {
      throw new ObservabilityStorageError('AUDIT_RETENTION_BELOW_MINIMUM');
    }
    const now = options.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
    }
    const cutoff = new Date(now.getTime() - retentionMs);
    return this.store.transaction(async tx => {
      const audits = tx.manager.getRepository(AuditLog);
      const states = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await states.findOneBy({ id: OBSERVABILITY_AUDIT_RETENTION_STATE_ID });
      const checkpoint = readCheckpoint(previous?.value);
      const candidates = await this.readCandidates(audits, cutoff, scanLimit, checkpoint);
      const claimed = candidates.slice(0, deleteLimit);
      const exhausted = candidates.length < scanLimit;
      if (claimed.length > 0) {
        await audits.delete({ id: In(claimed.map(row => row.id)) });
        // The cleanup leaves one bounded management record; it is never written per row.
        await audits.save(audits.create({
          action: AuditAction.SYSTEM_MAINTENANCE,
          level: AuditLevel.INFO,
          status: AuditStatus.SUCCESS,
          resource: 'observability_audit',
          details: {
            operation: 'observability_audit_retention',
            cutoff: cutoff.toISOString(),
            scanned: candidates.length,
            deleted: claimed.length,
          },
          metadata: { count: claimed.length },
        }));
      }
      const last = claimed[claimed.length - 1];
      const checkpointValue: AuditCheckpoint | null = claimed.length === 0 || (exhausted && claimed.length === candidates.length)
        ? null
        : { createdAt: last.createdAt.toISOString(), id: last.id };
      const snapshotSeq = publicSequence(tx.currentSequence());
      const value = {
        ...(previous?.value || {}),
        checkpoint: checkpointValue,
        lastCollectionAt: now.toISOString(),
        lastCutoff: cutoff.toISOString(),
        lastDeleted: claimed.length,
        stateVersion: Number(previous?.value?.stateVersion || 0) + 1,
        snapshotSeq,
      };
      await states.save(states.create({
        id: OBSERVABILITY_AUDIT_RETENTION_STATE_ID,
        value,
        updatedAt: tx.now,
      }));
      return {
        status: exhausted && claimed.length === candidates.length ? 'completed' : 'waiting',
        scanned: candidates.length,
        deleted: claimed.length,
        cutoff: cutoff.toISOString(),
        snapshotSeq,
      };
    });
  }

  private readCandidates(
    repository: Repository<AuditLog>,
    cutoff: Date,
    scanLimit: number,
    checkpoint: AuditCheckpoint | null,
  ): Promise<AuditLog[]> {
    const query = repository
      .createQueryBuilder('audit')
      .where('audit.resource IN (:...resources)', { resources: [...OBSERVABILITY_AUDIT_RESOURCES] })
      .andWhere('audit.createdAt <= :cutoff', { cutoff })
      .orderBy('audit.createdAt', 'ASC')
      .addOrderBy('audit.id', 'ASC')
      .take(scanLimit);
    if (checkpoint) {
      query.andWhere(
        '(audit.createdAt > :checkpointAt OR (audit.createdAt = :checkpointAt AND audit.id > :checkpointId))',
        { checkpointAt: new Date(checkpoint.createdAt), checkpointId: checkpoint.id },
      );
    }
    return query.getMany();
  }
}
