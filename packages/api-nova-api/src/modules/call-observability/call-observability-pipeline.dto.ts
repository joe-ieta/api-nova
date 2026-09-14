import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityPipelineStageDto {
  @ApiProperty({ enum: ['unknown', 'running', 'waiting_for_source', 'degraded', 'backlog'] }) state: string;
  @ApiProperty({ type: String, nullable: true }) dataWatermark: string | null;
  @ApiProperty({ type: Number, nullable: true }) lagMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) pendingCount: number | null;
  @ApiProperty({ type: String, nullable: true }) oldestPendingAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) failedRecords: number | null;
  @ApiProperty({ type: Number, nullable: true }) quarantinedRecords: number | null;
  @ApiProperty({ type: String, nullable: true }) quarantinedRecordsScope: string | null;
  @ApiProperty({ type: Number, nullable: true }) droppedRecords: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) unknownLoss: boolean | null;
  @ApiProperty({ type: Object, nullable: true }) diskUsage: null;
  @ApiProperty({ type: Object, nullable: true }) effectiveQuota: null;
  @ApiProperty({ type: 'array', items: { type: 'object' }, nullable: true }) gapRanges: null;
}
export class ObservabilityPipelineIngestDto extends ObservabilityPipelineStageDto {
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty({ description: 'Recent evidence is not proof that the worker is alive.' }) staleAfterMs: number;
  @ApiProperty({ type: String, nullable: true }) observedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) observationAgeMs: number | null;
  @ApiProperty({ type: String, nullable: true }) lastSuccessfulScanAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) successfulScanAgeMs: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) scanComplete: boolean | null;
  @ApiProperty({ type: String, nullable: true }) scanStartedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) backlogScope: string | null;
  @ApiProperty({ type: Number, nullable: true }) backlogFiles: number | null;
  @ApiProperty({ type: Number, nullable: true }) partialBytes: number | null;
  @ApiProperty({ type: Number, nullable: true }) scanErrorCount: number | null;
}
export class ObservabilityPipelineAggregationDto extends ObservabilityPipelineStageDto {
  @ApiProperty({ enum: ['unexpired_bucket_queue_snapshot'] }) evidenceSource: string;
  @ApiProperty({ enum: ['buckets_pending_or_leased_including_retry_backoff'] }) pendingCountScope: string;
  @ApiProperty() pendingBuckets: number;
  @ApiProperty() leasedBuckets: number;
  @ApiProperty({ description: 'Leased buckets whose persisted lease has expired; not proof of worker failure.' }) expiredLeaseBuckets: number;
  @ApiProperty({ description: 'Pending buckets with a persisted retry timestamp; not failed record count.' }) retryBuckets: number;
  @ApiProperty({ description: 'Snapshot read time, not a worker heartbeat.' }) countsObservedAt: string;
}
export class ObservabilityPipelineDispatchDto extends ObservabilityPipelineStageDto {
  @ApiProperty({ enum: ['events_dispatch_checkpoint'] }) evidenceSource: string;
  @ApiProperty({ enum: ['retained_events_after_checkpoint_through_snapshot_including_suppressed_and_expired'] }) pendingCountScope: string;
  @ApiProperty({ enum: ['event_scan_checkpoint_not_delivery_acknowledgement'] }) dataWatermarkScope: string;
  @ApiProperty({ type: String, nullable: true }) observedAt: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Age of checkpoint.updatedAt, not event lag or worker heartbeat.' }) observationAgeMs: number | null;
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty() staleAfterMs: number;
  @ApiProperty({ description: 'Snapshot read time for the pending event count.' }) countsObservedAt: string;
}
export class ObservabilityPipelineStatusDto {
  @ApiProperty({ enum: ['global'] }) resourceScope: string;
  @ApiProperty({ enum: ['persisted_observations_not_live_health'] }) semantics: string;
  @ApiProperty() evaluatedAt: string;
  @ApiProperty({ type: ObservabilityPipelineIngestDto }) ingest: ObservabilityPipelineIngestDto;
  @ApiProperty({ type: ObservabilityPipelineAggregationDto }) aggregation: ObservabilityPipelineAggregationDto;
  @ApiProperty({ type: ObservabilityPipelineDispatchDto }) dispatch: ObservabilityPipelineDispatchDto;
}
export class ObservabilityPipelineStatusEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityPipelineStatusDto }) data: ObservabilityPipelineStatusDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}

