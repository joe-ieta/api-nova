import { Injectable } from '@nestjs/common';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { EVENTS_DISPATCH_CHECKPOINT } from './call-observability-events.dispatcher';
import { sequenceKey } from './call-observability-storage';
import { RuntimeMetricBucketEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, requireGlobalObservabilityScope } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityPipelineAggregationDto, ObservabilityPipelineDispatchDto, ObservabilityPipelineIngestDto, ObservabilityPipelineStageDto } from './call-observability-pipeline.dto';
import { CallObservabilityStore } from './call-observability.store';
import { COLLECTOR_WORKER_ID } from './call-observability.worker';

export const PIPELINE_OBSERVATION_STALE_AFTER_MS = 15000;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value: unknown, now: number): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && new Date(time).toISOString() === value ? value : null;
};
const unmeasured = (state: string): ObservabilityPipelineStageDto => ({
  state, dataWatermark: null, lagMs: null, pendingCount: null, oldestPendingAt: null,
  failedRecords: null, quarantinedRecords: null, quarantinedRecordsScope: null,
  droppedRecords: null, unknownLoss: null, diskUsage: null, effectiveQuota: null, gapRanges: null,
});

@Injectable()
export class CallObservabilityPipelineService {
  constructor(private readonly store: CallObservabilityStore) {}
  async get(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    // Reject local scopes before reading any global evidence, including the snapshot sequence.
    if (!authorization) throw new ObservabilityApiError('UNAUTHENTICATED');
    if (!authorization.requiredPermissions.includes('monitoring:read')) throw new ObservabilityApiError('FORBIDDEN');
    requireGlobalObservabilityScope(authorization);
    if (!object(raw) || Object.keys(raw).length) throw new ObservabilityApiError('INVALID_QUERY', 'query');
    return this.store.readSnapshot(async tx => {
      const row = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: COLLECTOR_WORKER_ID });
      const value = object(row?.value), scan = object(value?.scan), now = Date.parse(tx.now);
      const observedAt = timestamp(row?.updatedAt, now);
      const observationAgeMs = observedAt === null ? null : now - Date.parse(observedAt);
      const lastSuccessfulScanAt = timestamp(value?.lastSuccessfulScanAt, observedAt ? Date.parse(observedAt) : now);
      const successfulScanAgeMs = lastSuccessfulScanAt === null ? null : now - Date.parse(lastSuccessfulScanAt);
      const scanComplete = typeof value?.scanComplete === 'boolean' ? value.scanComplete : null;
      const state = ['running', 'waiting_for_source', 'degraded'].includes(String(value?.state))
        ? String(value!.state) : 'unknown';
      const errors = object(scan?.errors);
      const errorCounts = errors ? Object.values(errors).map(count) : null;
      const sum = errorCounts && errorCounts.every(n => n !== null)
        ? errorCounts.reduce<number>((total, n) => total + n!, 0) : null;
      const sequence = value?.snapshotSeq;
      const dataWatermark = typeof sequence === 'string' && /^(0|[1-9]\d{0,19})$/.test(sequence) &&
        BigInt(sequence) <= BigInt(tx.snapshotSeq) ? sequence : null;
      const quarantinedRecords = count(scan?.quarantinedRecords);
      const ingest: ObservabilityPipelineIngestDto = {
        ...unmeasured(state), dataWatermark,
        freshnessStatus: observationAgeMs === null ? 'unknown' :
          observationAgeMs > PIPELINE_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'recent',
        staleAfterMs: PIPELINE_OBSERVATION_STALE_AFTER_MS, observedAt, observationAgeMs,
        lastSuccessfulScanAt, successfulScanAgeMs, scanComplete,
        scanStartedAt: timestamp(scan?.startedAt, observedAt ? Date.parse(observedAt) : now),
        backlogScope: scanComplete === null ? null : scanComplete ? 'completed_directory_scan' : 'partial_directory_scan',
        backlogFiles: count(scan?.backlogFiles), partialBytes: count(scan?.partialBytes),
        scanErrorCount: count(sum), quarantinedRecords,
        quarantinedRecordsScope: quarantinedRecords === null ? null : 'current_scan',
      };
      // Count durable work, never infer liveness from a lease or global coverage from a bucket maximum.
      const buckets = () => tx.manager.getRepository(RuntimeMetricBucketEntity).createQueryBuilder('bucket')
        .where('bucket.expiresAt > :now', { now: tx.now });
      const pendingBuckets = await buckets().andWhere('bucket.recomputeState = :state', { state: 'pending' }).getCount();
      const leasedBuckets = await buckets().andWhere('bucket.recomputeState = :state', { state: 'leased' }).getCount();
      const expiredLeaseBuckets = await buckets().andWhere('bucket.recomputeState = :state', { state: 'leased' })
        .andWhere('bucket.leaseUntil <= :now', { now: tx.now }).getCount();
      const retryBuckets = await buckets().andWhere('bucket.recomputeState = :state', { state: 'pending' })
        .andWhere('bucket.retryAt IS NOT NULL').getCount();
      const aggregation: ObservabilityPipelineAggregationDto = {
        ...unmeasured(pendingBuckets + leasedBuckets > 0 ? 'backlog' : 'unknown'),
        evidenceSource: 'unexpired_bucket_queue_snapshot',
        pendingCountScope: 'buckets_pending_or_leased_including_retry_backoff',
        pendingCount: pendingBuckets + leasedBuckets, pendingBuckets, leasedBuckets, expiredLeaseBuckets,
        retryBuckets, countsObservedAt: tx.now,
      };
      const checkpoint = await tx.manager.getRepository(RuntimePipelineStateEntity)
        .findOneBy({ id: EVENTS_DISPATCH_CHECKPOINT });
      const checkpointSequence = object(checkpoint?.value)?.sequence;
      // Reject malformed/ahead checkpoints, and never fabricate a checkpoint for an unstarted scheduler.
      const validCheckpoint = typeof checkpointSequence === 'string' && /^\d{1,20}$/.test(checkpointSequence) &&
        BigInt(checkpointSequence) <= BigInt(tx.snapshotSeq);
      const checkpointWatermark = validCheckpoint ? BigInt(checkpointSequence as string).toString() : null;
      const checkpointObservedAt = validCheckpoint ? timestamp(checkpoint?.updatedAt, now) : null;
      const checkpointAgeMs = checkpointObservedAt === null ? null : now - Date.parse(checkpointObservedAt);
      // Match dispatchBatch's scan domain: suppressed/expired events still need to be scanned.
      const pendingEvents = checkpointWatermark === null ? null : await tx.manager
        .getRepository(RuntimeObservabilityEventEntity).createQueryBuilder('event')
        .where('event.sequence > :after AND event.sequence <= :high', {
          after: sequenceKey(checkpointWatermark), high: sequenceKey(tx.snapshotSeq),
        }).getCount();
      const dispatch: ObservabilityPipelineDispatchDto = {
        ...unmeasured(pendingEvents !== null && pendingEvents > 0 ? 'backlog' : 'unknown'),
        evidenceSource: 'events_dispatch_checkpoint', dataWatermark: checkpointWatermark,
        dataWatermarkScope: 'event_scan_checkpoint_not_delivery_acknowledgement',
        pendingCountScope: 'retained_events_after_checkpoint_through_snapshot_including_suppressed_and_expired',
        pendingCount: pendingEvents, observedAt: checkpointObservedAt, observationAgeMs: checkpointAgeMs,
        freshnessStatus: checkpointAgeMs === null ? 'unknown' :
          checkpointAgeMs > PIPELINE_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'recent',
        staleAfterMs: PIPELINE_OBSERVATION_STALE_AFTER_MS, countsObservedAt: tx.now,
      };
      return observabilitySuccess({ resourceScope: 'global', semantics: 'persisted_observations_not_live_health',
        evaluatedAt: tx.now, ingest, aggregation, dispatch },
      { snapshotSeq: tx.snapshotSeq, lagMs: null, isPartial: true, historyCompleteSince: null });
    });
  }
}

