import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityFeatureCapabilityDto {
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['enabled', 'restricted', 'not_implemented'] }) state: string;
  @ApiProperty({ type: String, nullable: true, enum: ['all', 'scoped', 'none'] }) scopeMode: string | null;
}
export class ObservabilityEndpointCapabilityDto {
  @ApiProperty() endpointId: string;
  @ApiProperty() operationId: string;
  @ApiProperty({ enum: ['GET', 'PATCH'] }) method: string;
  @ApiProperty() path: string;
  @ApiProperty({ type: [String] }) queryParameters: string[];
  @ApiProperty({ type: [String] }) requiredPermissions: string[];
  @ApiProperty({ enum: ['all', 'scoped', 'none'] }) scopeMode: string;
  @ApiProperty({ enum: ['capability_only', 'per_asset', 'all_registered_caller_assets'] }) authorizationRule: string;
}
export class ObservabilityRetentionCapabilitiesDto {
  @ApiProperty({ enum: ['storage_defaults_not_coverage_guarantees'] }) basis: string;
  @ApiProperty() invocationMetadataDefaultMs: number;
  @ApiProperty({ type: Number, nullable: true }) payloadDefaultMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) aggregateRetentionMs: number | null;
  @ApiProperty({ type: String, nullable: true }) effectiveHistoryCompleteSince: string | null;
}
export class ObservabilityPayloadLimitsDto {
  @ApiProperty() readObjectMaxBytes: number;
  @ApiProperty({ type: Number, nullable: true }) effectiveCaptureBytes: number | null;
  @ApiProperty({ enum: ['not_reported_by_producers'] }) capturePolicyState: string;
  @ApiProperty({ enum: ['single_stored_object_not_total_http_memory'] }) readLimitScope: string;
}
export class ObservabilityCapabilityVersionsDto {
  @ApiProperty({ enum: [2] }) sourceRecords: number;
  @ApiProperty({ enum: ['1.0'] }) http: string;
}
export class ObservabilityCapabilitiesDto {
  @ApiProperty({ enum: ['implementation_and_scope_eligibility_not_runtime_health'] }) availabilitySemantics: string;
  @ApiProperty({ enum: ['all', 'scoped', 'none'] }) resourceScope: string;
  @ApiProperty({ type: ObservabilityCapabilityVersionsDto }) schemaVersions: ObservabilityCapabilityVersionsDto;
  @ApiProperty({ type: [ObservabilityEndpointCapabilityDto] }) endpoints: ObservabilityEndpointCapabilityDto[];
  @ApiProperty({ type: [ObservabilityFeatureCapabilityDto] }) features: ObservabilityFeatureCapabilityDto[];
  @ApiProperty({ type: [String] }) enabledFeatures: string[];
  @ApiProperty({ type: [String] }) supportedScopes: string[];
  @ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'string' } } })
  supportedGroupByCombinations: string[][];
  @ApiProperty({ type: [String] }) errorCategories: string[];
  @ApiProperty({ enum: ['suggested_values_free_text_filter'] }) errorCategoryMode: string;
  @ApiProperty({ type: [String] }) byteMeasurements: string[];
  @ApiProperty() maxLimit: number;
  @ApiProperty() defaultLimit: number;
  @ApiProperty({ description: 'Milliseconds; concrete endpoints can reject time-window parameters entirely.' }) maxQueryRange: number;
  @ApiProperty() defaultQueryWindowMs: number;
  @ApiProperty({ type: Number, nullable: true }) maxBuckets: number | null;
  @ApiProperty() traceMaxNodes: number;
  @ApiProperty() maxVisitorQueryInvocations: number;
  @ApiProperty() maxStatisticsQueryInvocations: number;
  @ApiProperty() maxGroupLimit: number;
  @ApiProperty() maxQueryCursorLifetimeMs: number;
  @ApiProperty({ type: ObservabilityRetentionCapabilitiesDto }) retentionWindows: ObservabilityRetentionCapabilitiesDto;
  @ApiProperty({ type: ObservabilityPayloadLimitsDto, nullable: true }) payloadLimits: ObservabilityPayloadLimitsDto | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Public event-history retention; null while that endpoint is not implemented.' })
  eventRetention: number | null;
  @ApiProperty({ enum: ['unknown'] }) observationHealth: string;
}
export class ObservabilityCapabilitiesEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityCapabilitiesDto }) data: ObservabilityCapabilitiesDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
