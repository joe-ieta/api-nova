import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';
import { ObservabilityOverviewWindowDto } from './call-observability-overview-query';

export class ObservabilityReportedStateDto {
  @ApiProperty({ enum: ['runtime_observability_states'] }) source: string;
  @ApiProperty({ description: 'Last persisted report, not a current process-liveness assertion.' }) lifecycleStatus: string;
  @ApiProperty({ description: 'Historical reported health; no freshness or heartbeat guarantee.' }) healthStatus: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) updatedAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastEventAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastSuccessAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastFailureAt: string | null;
}
export class ObservabilityServerStatusDto {
  @ApiProperty() runtimeAssetId: string;
  @ApiProperty({ enum: ['gateway', 'mcp'] }) serverType: string;
  @ApiProperty({ description: 'Persisted runtime_assets status, not a process heartbeat.' }) lifecycleStatus: string;
  @ApiProperty({ enum: ['runtime_assets'] }) lifecycleSource: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lifecycleUpdatedAt: string | null;
  @ApiProperty({ enum: ['unknown'] }) healthStatus: string;
  @ApiProperty({ enum: ['unknown'] }) dependencyHealth: string;
  @ApiProperty({ enum: ['unknown'] }) freshnessStatus: string;
  @ApiProperty({ type: String, nullable: true, description: 'Unknown: legacy state updates are not heartbeats.' }) lastHeartbeatAt: string | null;
  @ApiProperty({ type: String, nullable: true }) processInstanceId: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Unknown until producer liveness is verified.' }) activeInvocations: number | null;
  @ApiProperty({ description: 'Unfinished business invocations observed within the selected start window; not all active requests.' }) unknownInFlight: number;
  @ApiProperty({ description: 'Observed business invocations in the selected window; zero does not prove no traffic.' }) observedBusinessRequests: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Latest observed business success completion among selected starts.' }) lastSuccessAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Latest observed error/timeout/incomplete completion among selected business starts.' }) lastFailureAt: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Unknown: legacy state has no version tied to the call-event sequence.' }) stateVersion: string | null;
  @ApiProperty({ type: ObservabilityReportedStateDto, nullable: true }) reportedState: ObservabilityReportedStateDto | null;
}
export class ObservabilityServerStatusesDto {
  @ApiProperty({ type: ObservabilityOverviewWindowDto }) window: ObservabilityOverviewWindowDto;
  @ApiProperty({ type: [ObservabilityServerStatusDto] }) items: ObservabilityServerStatusDto[];
  @ApiProperty() maxServers: number;
  @ApiProperty() maxQueryInvocations: number;
  @ApiProperty() maxStateRows: number;
  @ApiProperty({ enum: ['current_database_snapshot'] }) stateBasis: string;
  @ApiProperty({ type: String, nullable: true, description: 'Null: current asset and legacy state updates do not advance the invocation sequence.' }) dataWatermark: string | null;
  @ApiProperty({ description: 'Watermark for invocation-derived counts only.' }) invocationDataWatermark: string;
  @ApiProperty({ format: 'date-time' }) readAt: string;
  @ApiProperty() livenessEvaluated: boolean;
  @ApiProperty() isPartial: boolean;
  @ApiProperty({ description: 'True for asset-scoped grants; never reports hidden asset counts.' }) restricted: boolean;
}
export class ObservabilityServerStatusesEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityServerStatusesDto }) data: ObservabilityServerStatusesDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
