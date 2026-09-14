import { ObservabilityManagementHeartbeatDto } from './call-observability-heartbeat.dto';
import { ObservabilityPipelineRetentionDto } from './call-observability-pipeline-retention';
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
  @ApiProperty({ enum: ['store_metrics_recompute_markers'] }) evidenceSource: string;
  @ApiProperty({ enum: ['all_persisted_metric_and_caller_pending_markers_including_expired'] }) pendingCountScope: string;
  @ApiProperty({ description: 'Metric bucket JSON recompute.state=pending count, matching Store selection.' }) pendingBuckets: number;
  @ApiProperty({ description: 'Caller bucket JSON recompute.state=pending count, matching Store selection.' }) pendingCallerBuckets: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Most recent collector run report, not a cumulative count or heartbeat.' }) lastRunRecomputedBuckets: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Most recent collector run recompute failures; not failed invocation records.' }) lastRunRecomputeFailures: number | null;
  @ApiProperty({ description: 'Snapshot read time, not a worker heartbeat.' }) countsObservedAt: string;
}
export class ObservabilityPipelineWebhookDto {
  @ApiProperty({ enum: ['webhook_worker_last_run'] }) evidenceSource: string;
  @ApiProperty({ enum: ['unknown', 'running', 'degraded'], description: 'Persisted report from the most recent worker run, not current health.' }) state: string;
  @ApiProperty({ type: String, nullable: true }) observedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) observationAgeMs: number | null;
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty() staleAfterMs: number;
  @ApiProperty({ type: String, nullable: true, description: 'Last worker run snapshot, not a delivery acknowledgement watermark.' }) snapshotSeq: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Last persisted configuration report, not current enablement.' }) workerConfigured: boolean | null;
  @ApiProperty({ type: String, nullable: true, description: 'Worker-reported lastAttemptAt; may be set even when claimed=0.' }) lastAttemptAt: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Last run only.' }) claimed: number | null;
  @ApiProperty({ type: Number, nullable: true }) succeeded: number | null;
  @ApiProperty({ type: Number, nullable: true }) retrying: number | null;
  @ApiProperty({ type: Number, nullable: true }) dead: number | null;
  @ApiProperty({ type: Number, nullable: true }) cancelled: number | null;
}
export class ObservabilityPipelineDispatchDto extends ObservabilityPipelineStageDto {
  @ApiProperty({ enum: ['outbox_materializer_state_and_pending_events'] }) evidenceSource: string;
  @ApiProperty({ enum: ['unexpired_schema_1_events_pending_or_leased_through_snapshot'] }) pendingCountScope: string;
  @ApiProperty({ enum: ['outbox_materialization_not_webhook_acknowledgement'] }) dataWatermarkScope: string;
  @ApiProperty({ type: String, nullable: true }) observedAt: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Age of the persisted outbox observation, not delivery lag.' }) observationAgeMs: number | null;
  @ApiProperty({ enum: ['recent', 'stale', 'unknown'] }) freshnessStatus: string;
  @ApiProperty() staleAfterMs: number;
  @ApiProperty() countsObservedAt: string;
  @ApiProperty({ type: String, nullable: true }) lastReconciledAt: string | null;
  @ApiProperty({ type: String, nullable: true }) lastMaterializedAt: string | null;
  @ApiProperty({ type: ObservabilityPipelineWebhookDto }) webhook: ObservabilityPipelineWebhookDto;
}
export class ObservabilityPipelineStatusDto {
  @ApiProperty({ type: ObservabilityManagementHeartbeatDto }) managementHeartbeat: ObservabilityManagementHeartbeatDto;
  @ApiProperty({ type: ObservabilityPipelineRetentionDto }) retention: ObservabilityPipelineRetentionDto;
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
