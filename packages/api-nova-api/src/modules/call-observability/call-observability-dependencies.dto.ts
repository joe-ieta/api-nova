import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';
import { ObservabilityOverviewWindowDto } from './call-observability-overview-query';
export class ObservabilityDependencyDto {
  @ApiProperty({ type: String, nullable: true }) runtimeAssetId: string | null;
  @ApiProperty() serverType: string;
  @ApiProperty({ type: String, nullable: true }) endpointDefinitionId: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceServiceInstanceId: string | null;
  @ApiProperty() upstreamRequests: number;
  @ApiProperty({ description: 'Observed error, timeout or incomplete upstream invocations.' }) failures: number;
  @ApiProperty() retryAttempts: number;
  @ApiProperty() unlinkedRetryRecords: number;
  @ApiProperty({ description: 'Distinct nearest visible external business invocations reached through parent links from failed upstream attempts, within the same asset, trace and selected start window. Each MCP Tool counts separately even under one protocol root. Affected does not imply the business invocation ultimately failed.' }) affectedBusinessRequests: number;
  @ApiProperty({ description: 'Failed external upstream records without a verifiable visible business ancestor. Does not disclose hidden root IDs or counts.' }) unlinkedFailureRecords: number;
  @ApiProperty({ description: 'True only when every selected failed external upstream record has a visible business ancestor; not a historical completeness guarantee.' }) relationshipsComplete: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastFailureAt: string | null;
  @ApiProperty() dataWatermark: string;
  @ApiProperty() isPartial: boolean;
}
export class ObservabilityDependenciesDto {
  @ApiProperty({ type: ObservabilityOverviewWindowDto }) window: ObservabilityOverviewWindowDto;
  @ApiProperty({ type: [ObservabilityDependencyDto] }) items: ObservabilityDependencyDto[];
  @ApiProperty() dataWatermark: string;
  @ApiProperty() maxQueryInvocations: number;
  @ApiProperty({ enum: ['retained_invocation_snapshot'] }) queryMode: string;
  @ApiProperty({ type: String, nullable: true }) historyCompleteSince: string | null;
  @ApiProperty() isPartial: boolean;
  @ApiProperty() restricted: boolean;
  @ApiProperty({ description: 'Only observed upstream dependencies, not configured but unused bindings; parent links require retained visible evidence in this window.' }) dependencyBasis: string;
}
export class ObservabilityDependenciesEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityDependenciesDto }) data: ObservabilityDependenciesDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
