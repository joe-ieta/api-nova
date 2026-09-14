import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';
import { ObservabilityStatisticsSummaryDto } from './call-observability-statistics.dto';
import { ObservabilityServerStatusesDto } from './call-observability-server-status.dto';
import { ObservabilityOverviewWindowDto } from './call-observability-overview-query';
export class ObservabilityOverviewSummaryDto extends ObservabilityStatisticsSummaryDto {
  @ApiProperty() dataWatermark: string;
}
export class ObservabilityOverviewDto {
  @ApiProperty({ type: ObservabilityOverviewWindowDto }) window: ObservabilityOverviewWindowDto;
  @ApiProperty() snapshotSeq: string;
  @ApiProperty({ description: 'Invocation facts only. May be used as events afterSequence only with an issued unexpired grant and matching origin/serverType/runtimeAssetId plus unchanged principal/asset permissions. Does not initialize legacy server state.' }) invocationSnapshotSeq: string;
  @ApiProperty({ enum: ['invocation_facts_only'] }) invocationSnapshotScope: string;
  @ApiProperty({ description: 'Whether this process registered the invocation snapshot for events afterSequence. False when the authorizer is not integrated.' }) invocationSnapshotAuthorized: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Process-local grant expires after five minutes; at most 1000 grants, oldest issuance evicted first. Restart or eviction requires a new overview even before this expiry. No global state/event coverage guarantee.' }) invocationSnapshotExpiresAt: string | null;
  @ApiProperty({ type: ObservabilityOverviewSummaryDto, description: 'Observed retained records, not an assertion of complete traffic capture.' }) businessSummary: ObservabilityOverviewSummaryDto;
  @ApiProperty({ type: ObservabilityOverviewSummaryDto, description: 'Zero observed upstream requests does not imply zero upstream traffic; coverage remains partial/unknown.' }) upstreamSummary: ObservabilityOverviewSummaryDto;
  @ApiProperty({ type: ObservabilityServerStatusesDto }) serverStates: ObservabilityServerStatusesDto;
  @ApiProperty({ type: [String], description: 'Sections not implemented by this subset; omitted instead of fabricated empty data.' }) unavailableSections: string[];
  @ApiProperty({ description: 'Asset-scoped grants are applied before every query; no hidden-resource counts are exposed.' }) restricted: boolean;
}
export class ObservabilityOverviewEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityOverviewDto }) data: ObservabilityOverviewDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
