import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityPayloadMetadataDto {
  @ApiProperty({ enum: ['captured', 'omitted', 'incomplete', 'expired', 'unavailable'] })
  state: string;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Controlled relative endpoint; every read checks permission and retention.' })
  readLink: string | null;
}

export class ObservabilityInvocationDto {
  @ApiProperty({ enum: ['1.0'] }) schemaVersion: string;
  @ApiProperty() invocationId: string;
  @ApiProperty({ type: Number, minimum: 1 }) recordVersion: number;
  @ApiProperty({ type: String, nullable: true }) traceId: string | null;
  @ApiProperty({ type: String, nullable: true }) parentInvocationId: string | null;
  @ApiProperty({ type: String, nullable: true }) rootInvocationId: string | null;
  @ApiProperty() linksRestricted: boolean;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ enum: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'] }) spanKind: string;
  @ApiProperty({ enum: ['external', 'test', 'probe', 'internal'] }) origin: string;
  @ApiProperty() transport: string;
  @ApiProperty({ enum: ['gateway', 'mcp'] }) serverType: string;
  @ApiProperty({ type: String, nullable: true }) runtimeAssetId: string | null;
  @ApiProperty({ type: String, nullable: true }) serverId: string | null;
  @ApiProperty({ type: String, nullable: true }) endpointDefinitionId: string | null;
  @ApiProperty({ type: String, nullable: true }) operationId: string | null;
  @ApiProperty({ type: String, nullable: true }) toolName: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceServiceInstanceId: string | null;
  @ApiProperty({ type: 'object', nullable: true, description: 'Not collected yet; reported in missingFields.' })
  publicationSnapshot: null;
  @ApiProperty({ type: String, nullable: true }) callerId: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceId: string | null;
  @ApiProperty({ enum: ['authenticated', 'anonymous', 'authentication_failed', 'unknown'] }) authState: string;
  @ApiProperty() identitySource: string;
  @ApiProperty() sourceRestricted: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) clientIp?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) peerIp?: string | null;
  @ApiPropertyOptional() ipSource?: string;
  @ApiPropertyOptional() proxyTrusted?: boolean;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationMs: number | null;
  @ApiProperty({ enum: ['running', 'finished'] }) lifecycle: string;
  @ApiProperty({ enum: ['observed', 'reconciled'] }) completionSource: string;
  @ApiProperty({ type: String, nullable: true,
    enum: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'] })
  outcome: string | null;
  @ApiProperty({ type: Number, nullable: true }) httpStatus: number | null;
  @ApiProperty({ type: Number, nullable: true }) protocolErrorCode: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) toolIsError: boolean | null;
  @ApiProperty({ type: String, nullable: true }) errorCategory: string | null;
  @ApiProperty({ type: String, nullable: true }) failureStage: string | null;
  @ApiProperty({ type: String, nullable: true }) errorSummary: string | null;
  @ApiProperty({ type: String, nullable: true }) upstreamOperationId: string | null;
  @ApiProperty({ type: Number, nullable: true }) attemptIndex: number | null;
  @ApiProperty({ type: Number, nullable: true }) redirectHopIndex: number | null;
  @ApiProperty({ type: Number, nullable: true }) requestBytes: number | null;
  @ApiProperty({ type: Number, nullable: true }) responseBytes: number | null;
  @ApiProperty({ enum: ['observed_body', 'serialized_payload', 'unavailable'] }) byteMeasurement: string;
  @ApiProperty() measurementStage: string;
  @ApiProperty() partial: boolean;
  @ApiProperty({ type: ObservabilityPayloadMetadataDto }) request: ObservabilityPayloadMetadataDto;
  @ApiProperty({ type: ObservabilityPayloadMetadataDto }) response: ObservabilityPayloadMetadataDto;
  @ApiProperty() sourceRecordId: string;
  @ApiProperty({ format: 'date-time' }) ingestedAt: string;
  @ApiProperty({ type: [String] }) missingFields: string[];
  @ApiProperty() isPartial: boolean;
}

export class ObservabilityInvocationPageDto {
  @ApiProperty({ type: [ObservabilityInvocationDto] }) items: ObservabilityInvocationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() hasMore: boolean;
  @ApiProperty({ enum: ['startedAt', 'completedAt'] }) timeBasis: string;
  @ApiPropertyOptional({ oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string', pattern: '^[0-9]+$' }] })
  total?: number | string;
}
export class ObservabilityInvocationDetailDto extends ObservabilityInvocationDto {
  @ApiProperty({ enum: ['startedAt', 'completedAt'] }) timeBasis: string;
}
export class ObservabilityInvocationListEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityInvocationPageDto }) data: ObservabilityInvocationPageDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export class ObservabilityInvocationEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityInvocationDetailDto }) data: ObservabilityInvocationDetailDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}

export class ObservabilityTraceEdgeDto {
  @ApiProperty() parentInvocationId: string;
  @ApiProperty() childInvocationId: string;
}
export class ObservabilityTraceMissingParentDto {
  @ApiProperty({ description: 'Visible child; never the unavailable parent ID.' }) invocationId: string;
  @ApiProperty({ enum: ['unavailable_or_restricted'] }) reason: 'unavailable_or_restricted';
}
export class ObservabilityTraceIssueDto {
  @ApiProperty({ description: 'Affected visible node.' }) invocationId: string;
  @ApiProperty({ enum: ['root_unavailable_or_restricted', 'parent_cycle'] })
  reason: 'root_unavailable_or_restricted' | 'parent_cycle';
}
export class ObservabilityTraceDto {
  @ApiProperty({ enum: ['external', 'test', 'probe', 'internal'] }) origin: string;
  @ApiProperty({ type: [ObservabilityInvocationDto] }) nodes: ObservabilityInvocationDto[];
  @ApiProperty({ type: [ObservabilityTraceEdgeDto] }) edges: ObservabilityTraceEdgeDto[];
  @ApiProperty({ type: [ObservabilityTraceMissingParentDto] }) missingParentReferences: ObservabilityTraceMissingParentDto[];
  @ApiProperty({ type: [ObservabilityTraceIssueDto] }) structuralIssues: ObservabilityTraceIssueDto[];
  @ApiProperty({ description: 'Declared references of returned nodes are present and acyclic; not proof of complete history.' })
  relationshipsComplete: boolean;
  @ApiProperty() isPartial: boolean;
  @ApiProperty({ example: 200 }) maxNodes: number;
}
export class ObservabilityTraceEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityTraceDto }) data: ObservabilityTraceDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
