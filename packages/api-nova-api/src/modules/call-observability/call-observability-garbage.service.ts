import { Injectable } from '@nestjs/common';
import {
  RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePayloadEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore, PayloadScanUsage } from './call-observability-payload.store';
import { DAY_MS, ObservabilityStorageError } from './call-observability-storage';

export const PAYLOAD_GC_STATUS_ID = 'call-observability:payload-gc-status';
export const PAYLOAD_METADATA_RECONCILIATION_ID = 'call-observability:payload-metadata-reconciliation';

export interface PayloadGarbageReport {
  status: 'completed' | 'busy';
  reason?: 'writer_active' | 'gc_active';
  scanned: number;
  deleted: number;
  missing: number;
  changed: number;
  protected: number;
  danglingReferences: number;
  nextShard: number;
  hasMore: boolean;
  generation: string | null;
  scanUsage?: PayloadScanUsage;
  metadataReconciliation?: { checked: number; reconciled: number; retained: number; hasMore: boolean };
}

/** No timer is started here. The retention scheduler owns periodic execution. */
@Injectable()
export class CallObservabilityGarbageService {
  constructor(
    private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore,
  ) {}

  async collect(options: { scanLimit?: number; deleteLimit?: number; graceMs?: number } = {}): Promise<PayloadGarbageReport> {
    const scanLimit = options.scanLimit ?? 128;
    const deleteLimit = options.deleteLimit ?? 32;
    const graceMs = options.graceMs ?? DAY_MS;
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 1000 ||
      !Number.isInteger(deleteLimit) || deleteLimit < 1 || deleteLimit > scanLimit ||
      !Number.isSafeInteger(graceMs) || graceMs < 60_000 || graceMs > 7 * DAY_MS) {
      throw new ObservabilityStorageError('INVALID_GC_LIMIT');
    }
    await this.store.ensurePayloadStorage();
    await this.payloads.assertOwnedRoot();
    const acquired = await this.store.payloadCoordination.acquireGc();
    const report: PayloadGarbageReport = {
      status: acquired.lease ? 'completed' : 'busy', reason: acquired.reason,
      scanned: 0, deleted: 0, missing: 0, changed: 0, protected: 0,
      danglingReferences: 0, nextShard: 0, hasMore: false,
      generation: acquired.lease?.generation || null,
    };
    if (!acquired.lease) return report;
    const lease = acquired.lease;
    const olderThan = Date.now() - graceMs;
    try {
      const reconciliation = { checked: 0, reconciled: 0, retained: 0, hasMore: false };
      const batchMetadata = await this.store.transaction(async tx => {
        await this.store.payloadCoordination.assertGc(tx, lease);
        const state = await tx.manager.getRepository(RuntimePipelineStateEntity)
          .findOneBy({ id: PAYLOAD_METADATA_RECONCILIATION_ID });
        const after = state?.value?.afterId;
        if (after !== undefined && after !== null && (typeof after !== 'string' || !after.length || after.length > 240)) {
          throw new ObservabilityStorageError('INVALID_PAYLOAD_METADATA');
        }
        const query = tx.manager.getRepository(RuntimePayloadEntity).createQueryBuilder('payload')
          .select('payload.id', 'id').where('payload.expiresAt <= :now', { now: tx.now })
          .andWhere('payload.fileKey IS NOT NULL').orderBy('payload.id', 'ASC').take(scanLimit);
        if (after) query.andWhere('payload.id > :after', { after });
        return query.getRawMany<{ id: string }>();
      });
      for (const candidate of batchMetadata) {
        const repaired = await this.store.transaction(async tx => {
          await this.store.payloadCoordination.assertGc(tx, lease);
          const repository = tx.manager.getRepository(RuntimePayloadEntity);
          const object = await repository.findOneBy({ id: candidate.id });
          let changed = false;
          if (object && typeof object.fileKey === 'string' && /^[a-f0-9]{64}$/.test(object.id) &&
            object.fileKey === object.id.slice(0, 2) + '/' + object.id + '.body' &&
            Number.isFinite(Date.parse(object.expiresAt)) && Date.parse(object.expiresAt) <= Date.parse(tx.now) &&
            await this.payloads.isStoredObjectMissing(object.id, object.fileKey)) {
            await this.store.payloadCoordination.assertGc(tx, lease);
            await repository.save(Object.assign(object, {
              state: 'expired', reason: 'retention_elapsed', fileKey: null,
              metadata: { ...object.metadata, state: 'expired', reason: 'retention_elapsed', storedBytes: 0 },
            }));
            changed = true;
          }
          await this.store.payloadCoordination.assertGc(tx, lease);
          const state = tx.manager.getRepository(RuntimePipelineStateEntity);
          await state.save(state.create({ id: PAYLOAD_METADATA_RECONCILIATION_ID,
            value: { afterId: candidate.id }, updatedAt: tx.now }));
          return changed;
        });
        reconciliation.checked++;
        if (repaired) reconciliation.reconciled++; else reconciliation.retained++;
      }
      reconciliation.hasMore = batchMetadata.length === scanLimit;
      if (!reconciliation.hasMore) await this.store.transaction(async tx => {
        await this.store.payloadCoordination.assertGc(tx, lease);
        const state = tx.manager.getRepository(RuntimePipelineStateEntity);
        await state.save(state.create({ id: PAYLOAD_METADATA_RECONCILIATION_ID, value: { afterId: null }, updatedAt: tx.now }));
      });
      report.metadataReconciliation = reconciliation;
      const previous = await this.store.transaction(async tx => {
        await this.store.payloadCoordination.assertGc(tx, lease);
        return tx.manager.getRepository(RuntimePipelineStateEntity).findOne({ where: { id: PAYLOAD_GC_STATUS_ID } });
      });
      const batch = await this.payloads.scanGarbage(scanLimit, deleteLimit, olderThan, previous?.value?.nextShard);
      report.scanned = batch.scanned;
      report.nextShard = batch.nextShard;
      report.hasMore = batch.hasMore;
      report.scanUsage = batch.scanUsage;
      for (const candidate of batch.candidates) {
        await this.store.transaction(async tx => {
          await this.store.payloadCoordination.assertGc(tx, lease);
          const repository = tx.manager.getRepository(RuntimePayloadEntity);
          const object = candidate.temporary ? null : await repository.findOne({ where: { id: candidate.id } });
          if (object && (!Number.isFinite(Date.parse(object.expiresAt)) ||
            Date.parse(object.expiresAt) > Date.now() ||
            object.fileKey !== null && object.fileKey !== candidate.key)) {
            report.protected++;
            return;
          }
          if (!object && !candidate.temporary) {
            const references = [{ requestPayloadId: candidate.id }, { responsePayloadId: candidate.id }];
            const current = await tx.manager.getRepository(RuntimeInvocationEntity)
              .findOne({ select: { invocationId: true }, where: references });
            const historical = current ? null : await tx.manager.getRepository(RuntimeInvocationRevisionEntity)
              .findOne({ select: { invocationId: true }, where: references });
            if (current || historical) {
              report.protected++;
              report.danglingReferences++;
              return;
            }
          }
          // Only bounded metadata/stat/unlink work occurs under the final fence.
          const result = await this.payloads.deleteGarbage(candidate, olderThan);
          report[result]++;
          if (object && result !== 'changed') {
            await repository.save(Object.assign(object, {
              state: 'expired', reason: 'retention_elapsed', fileKey: null,
              metadata: { ...object.metadata, state: 'expired', reason: 'retention_elapsed', storedBytes: 0 },
            }));
          }
        });
      }
      await this.store.transaction(async tx => {
        await this.store.payloadCoordination.assertGc(tx, lease);
        const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
        await repository.save(repository.create({
          id: PAYLOAD_GC_STATUS_ID, value: { ...report, completedAt: new Date().toISOString() }, updatedAt: tx.now,
        }));
      });
      return report;
    } catch (error) {
      // Candidate processing can fail after the scanner has consumed its entry.
      // Discard that cursor while holding the GC fence so the next batch retries
      // surviving files instead of skipping them. Cleanup must not mask failure.
      await this.payloads.closeScanner().catch(() => undefined);
      throw error;
    } finally {
      await this.store.payloadCoordination.releaseGc(lease).catch(() => undefined);
    }
  }
}
