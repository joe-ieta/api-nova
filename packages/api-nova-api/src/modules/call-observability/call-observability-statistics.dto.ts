import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityMetricByteSideDto {
  @ApiProperty({ nullable: true, oneOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] }) observedBytes: number | string | null;
  @ApiProperty() measuredRecords: number;
  @ApiProperty() unmeasuredRecords: number;
  @ApiProperty() partialRecords: number;
  @ApiProperty() isLowerBound: boolean;
}

export class ObservabilityMetricByteGroupDto {
  @ApiProperty() spanKind: string;
  @ApiProperty() byteMeasurement: string;
  @ApiProperty() measurementStage: string;
  @ApiProperty() invocationCount: number;
  @ApiProperty({ type: ObservabilityMetricByteSideDto }) request: ObservabilityMetricByteSideDto;
  @ApiProperty({ type: ObservabilityMetricByteSideDto }) response: ObservabilityMetricByteSideDto;
}

export class ObservabilityLatencyIntervalDto {
  @ApiProperty() lowerBoundMs: number;
  @ApiProperty() lowerInclusive: boolean;
  @ApiProperty({ type: Number, nullable: true }) upperBoundMs: number | null;
  @ApiProperty() upperInclusive: boolean;
  @ApiProperty({ type: Number, nullable: true }) estimateMs: number | null;
  @ApiProperty() overflow: boolean;
}

export class ObservabilityHistogramBucketDto {
  @ApiProperty() lowerBoundMs: number;
  @ApiProperty() lowerInclusive: boolean;
  @ApiProperty({ type: Number, nullable: true }) upperBoundMs: number | null;
  @ApiProperty() upperInclusive: boolean;
  @ApiProperty() count: number;
}

export class ObservabilityMetricLatencyDto {
  @ApiProperty({ enum: ['fixed_histogram_upper_bound_v1'] }) algorithm: string;
  @ApiProperty() approximate: boolean;
  @ApiProperty() sampleCount: number;
  @ApiProperty() unmeasuredRecords: number;
  @ApiProperty() excludedRecords: number;
  @ApiProperty({ type: Number, nullable: true }) sumMs: number | null;
  @ApiProperty() sumOverflow: boolean;
  @ApiProperty({ type: Number, nullable: true }) meanMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) maxMs: number | null;
  @ApiProperty({ type: [ObservabilityHistogramBucketDto] }) histogram: ObservabilityHistogramBucketDto[];
  @ApiProperty({ type: ObservabilityLatencyIntervalDto, nullable: true }) p50: ObservabilityLatencyIntervalDto | null;
  @ApiProperty({ type: ObservabilityLatencyIntervalDto, nullable: true }) p95: ObservabilityLatencyIntervalDto | null;
  @ApiProperty({ type: ObservabilityLatencyIntervalDto, nullable: true }) p99: ObservabilityLatencyIntervalDto | null;
}

export class ObservabilityMetricOutcomesDto {
  @ApiProperty() success: number;
  @ApiProperty() error: number;
  @ApiProperty() rejected: number;
  @ApiProperty() timeout: number;
  @ApiProperty() cancelled: number;
  @ApiProperty() incomplete: number;
  @ApiProperty() unknown: number;
}

export class ObservabilityStatisticsMetricsDto {
  @ApiProperty() selectedInvocations: number;
  @ApiProperty({ type: Number, nullable: true }) totalStarted: number | null;
  @ApiProperty() knownCompleted: number;
  @ApiProperty() successes: number;
  @ApiProperty() failures: number;
  @ApiProperty() rejections: number;
  @ApiProperty() timeouts: number;
  @ApiProperty() cancelled: number;
  @ApiProperty() incomplete: number;
  @ApiProperty() unknown: number;
  @ApiProperty({ type: ObservabilityMetricOutcomesDto }) outcomes: ObservabilityMetricOutcomesDto;
  @ApiProperty() inFlight: number;
  @ApiProperty() unknownInFlight: number;
  @ApiProperty() uniqueCallers: number;
  @ApiProperty() unidentifiedCallerRecords: number;
  @ApiProperty() anonymousSources: number;
  @ApiProperty() anonymousSourceOverflowRecords: number;
  @ApiProperty() unidentifiedSourceRecords: number;
  @ApiProperty() anonymousSourceCoveragePartial: boolean;
  @ApiProperty() upstreamRequests: number;
  @ApiProperty() retryAttempts: number;
  @ApiProperty() unlinkedRetryRecords: number;
  @ApiProperty({ type: Number, nullable: true }) successRate: number | null;
  @ApiProperty({ type: Number, nullable: true }) errorRate: number | null;
  @ApiProperty() measuredRecords: number;
  @ApiProperty() unmeasuredRecords: number;
  @ApiProperty() partialRecords: number;
  @ApiProperty({ type: [ObservabilityMetricByteGroupDto] }) byteGroups: ObservabilityMetricByteGroupDto[];
  @ApiProperty({ nullable: true, oneOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] }) requestBytes: number | string | null;
  @ApiProperty({ nullable: true, oneOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] }) responseBytes: number | string | null;
  @ApiProperty({ type: ObservabilityMetricLatencyDto }) latency: ObservabilityMetricLatencyDto;
}

export class ObservabilityStatisticsWindowDto {
  @ApiProperty({ format: 'date-time' }) from: string;
  @ApiProperty({ format: 'date-time' }) to: string;
  @ApiProperty({ enum: ['business', 'http_ingress', 'tool', 'protocol', 'upstream'] }) scope: string;
  @ApiProperty({ enum: ['external', 'test', 'probe', 'internal'] }) origin: string;
  @ApiProperty({ enum: ['startedAt', 'completedAt'] }) timeBasis: string;
}

export class ObservabilityStatisticsCoverageDto {
  @ApiProperty({ type: String, nullable: true }) historyCompleteSince: string | null;
  @ApiProperty() isPartial: boolean;
  @ApiProperty({ enum: ['unknown'] }) observationHealth: string;
}

export class ObservabilityStatisticsSummaryDto {
  @ApiProperty({ type: ObservabilityStatisticsWindowDto }) window: ObservabilityStatisticsWindowDto;
  @ApiProperty({ type: ObservabilityStatisticsMetricsDto }) metrics: ObservabilityStatisticsMetricsDto;
  @ApiProperty({ type: ObservabilityStatisticsCoverageDto }) coverage: ObservabilityStatisticsCoverageDto;
  @ApiProperty({ enum: ['retained_invocation_snapshot'] }) queryMode: string;
  @ApiProperty() maxQueryInvocations: number;
  @ApiProperty() livenessEvaluated: boolean;
}

export class ObservabilityStatisticsSummaryEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityStatisticsSummaryDto }) data: ObservabilityStatisticsSummaryDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}


export class ObservabilityStatisticsBucketDto {
  @ApiProperty({ format: 'date-time' }) bucketStart: string;
  @ApiProperty({ format: 'date-time' }) bucketEnd: string;
  @ApiProperty({ format: 'date-time' }) effectiveFrom: string;
  @ApiProperty({ format: 'date-time' }) effectiveTo: string;
  @ApiProperty({ type: Number, nullable: true, description: 'Always null: these on-demand buckets are not persisted.' }) bucketVersion: number | null;
  @ApiProperty() dataWatermark: string;
  @ApiProperty() synthetic: boolean;
  @ApiProperty({ type: ObservabilityStatisticsMetricsDto }) metrics: ObservabilityStatisticsMetricsDto;
  @ApiProperty({ type: ObservabilityStatisticsCoverageDto }) coverage: ObservabilityStatisticsCoverageDto;
}
export class ObservabilityStatisticsTimeSeriesDto extends ObservabilityStatisticsSummaryDto {
  @ApiProperty({ enum: ['1m', '5m', '1h', '1d'] }) interval: string;
  @ApiProperty({ enum: ['none', 'zero'] }) fill: string;
  @ApiProperty() maxBuckets: number;
  @ApiProperty({ enum: ['not_persisted'] }) bucketVersionSemantics: string;
  @ApiProperty({ type: [ObservabilityStatisticsBucketDto] }) items: ObservabilityStatisticsBucketDto[];
}
export class ObservabilityStatisticsGroupDto {
  @ApiProperty() rank: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', nullable: true } }) dimensionValues: Record<string, string | null>;
  @ApiProperty({ type: ObservabilityStatisticsMetricsDto }) metrics: ObservabilityStatisticsMetricsDto;
}
export class ObservabilityStatisticsGroupsDto extends ObservabilityStatisticsSummaryDto {
  @ApiProperty({ type: [String] }) groupBy: string[];
  @ApiProperty({ enum: ['selectedInvocations', 'failures', 'successes', 'uniqueCallers', 'upstreamRequests'] }) orderBy: string;
  @ApiProperty() top: number;
  @ApiProperty() totalGroups: number;
  @ApiProperty() hasMoreGroups: boolean;
  @ApiProperty({ type: [ObservabilityStatisticsGroupDto] }) items: ObservabilityStatisticsGroupDto[];
}
export class ObservabilityStatisticsTimeSeriesEnvelopeDto extends ObservabilityStatisticsSummaryEnvelopeDto {
  @ApiProperty({ type: ObservabilityStatisticsTimeSeriesDto }) data: ObservabilityStatisticsTimeSeriesDto;
}
export class ObservabilityStatisticsGroupsEnvelopeDto extends ObservabilityStatisticsSummaryEnvelopeDto {
  @ApiProperty({ type: ObservabilityStatisticsGroupsDto }) data: ObservabilityStatisticsGroupsDto;
}
