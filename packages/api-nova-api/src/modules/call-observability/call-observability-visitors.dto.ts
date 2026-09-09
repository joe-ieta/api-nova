import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

const byteTotal = { oneOf: [{ type: 'integer' as const, minimum: 0 },
  { type: 'string' as const, pattern: '^[0-9]+$' }], nullable: true };

export class ObservabilityVisitorMeasureDto {
  @ApiProperty({ enum: ['gateway_request', 'mcp_protocol', 'mcp_tool'] }) spanKind: string;
  @ApiProperty() byteMeasurement: string;
  @ApiProperty() measurementStage: string;
  @ApiProperty() invocationCount: number;
  @ApiProperty() runningCount: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer', minimum: 0 } })
  outcomeCounts: Record<string, number>;
  @ApiProperty(byteTotal) requestObservedBytes: number | string | null;
  @ApiProperty(byteTotal) responseObservedBytes: number | string | null;
  @ApiProperty() requestMissingMeasurements: number;
  @ApiProperty() responseMissingMeasurements: number;
  @ApiProperty() requestIncompleteMeasurements: number;
  @ApiProperty() responseIncompleteMeasurements: number;
}
export class ObservabilityVisitorSummaryDto {
  @ApiProperty({ description: 'Invocation boundaries, not people, connections, or deduplicated business requests.' })
  invocationCount: number;
  @ApiProperty({ type: [ObservabilityVisitorMeasureDto] }) groups: ObservabilityVisitorMeasureDto[];
  @ApiProperty({ type: String, nullable: true }) historyCompleteSince: null;
  @ApiProperty() isPartial: boolean;
}
export class ObservabilityVisitorWindowDto {
  @ApiProperty({ format: 'date-time' }) from: string;
  @ApiProperty({ format: 'date-time' }) to: string;
  @ApiProperty({ enum: ['startedAt', 'completedAt'] }) timeBasis: string;
  @ApiProperty({ enum: ['external'] }) origin: string;
}
export class ObservabilityCallerDto {
  @ApiProperty() callerId: string;
  @ApiProperty({ enum: ['authenticated'] }) identitySource: string;
  @ApiProperty({ type: String, nullable: true }) displayName: string | null;
  @ApiProperty({ type: [String] }) labels: string[];
  @ApiProperty({ enum: ['current'], description: 'Editable profile is current; observation ordering and summary use the call snapshot.' })
  profileSnapshot: string;
  @ApiProperty({ format: 'date-time', description: 'First start within the authorized selected invocation set.' })
  firstSeenAt: string;
  @ApiProperty({ format: 'date-time', description: 'Latest completion or start within the authorized selected invocation set.' })
  lastSeenAt: string;
  @ApiProperty({ type: [String] }) serverTypes: string[];
  @ApiProperty() observedServerCount: number;
  @ApiProperty() unassignedInvocationCount: number;
  @ApiProperty({ type: ObservabilityVisitorSummaryDto }) summary: ObservabilityVisitorSummaryDto;
}
export class ObservabilityCallerDetailDto extends ObservabilityCallerDto {
  @ApiPropertyOptional({ description: 'Strong ETag supplied only when management covers all registered caller assets.' })
  profileEtag?: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: [String], description: 'Credential IDs observed in this authorized window, never credential secrets.' })
  credentialIds: string[];
  @ApiProperty({ type: ObservabilityVisitorWindowDto }) window: ObservabilityVisitorWindowDto;
}
export class ObservabilitySourceDto {
  @ApiProperty() sourceId: string;
  @ApiProperty({ type: String, nullable: true }) runtimeAssetId: string | null;
  @ApiProperty({ enum: ['authenticated', 'anonymous', 'authentication_failed', 'unknown'] }) authState: string;
  @ApiProperty() day: string;
  @ApiProperty({ format: 'date-time' }) firstSeenAt: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt: string;
  @ApiProperty({ type: [String] }) serverTypes: string[];
  @ApiProperty() sourceOverflow: boolean;
  @ApiProperty() sourceRestricted: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) clientIp?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) peerIp?: string | null;
  @ApiPropertyOptional() ipSource?: string;
  @ApiPropertyOptional() proxyTrusted?: boolean;
  @ApiProperty({ type: ObservabilityVisitorSummaryDto }) summary: ObservabilityVisitorSummaryDto;
}
export class ObservabilityCallerPageDto {
  @ApiProperty({ type: [ObservabilityCallerDto] }) items: ObservabilityCallerDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() hasMore: boolean;
  @ApiPropertyOptional() total?: number;
  @ApiProperty({ type: ObservabilityVisitorWindowDto }) window: ObservabilityVisitorWindowDto;
  @ApiProperty() maxQueryInvocations: number;
}
export class ObservabilitySourcePageDto {
  @ApiProperty({ type: [ObservabilitySourceDto] }) items: ObservabilitySourceDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() hasMore: boolean;
  @ApiPropertyOptional() total?: number;
  @ApiProperty({ type: ObservabilityVisitorWindowDto }) window: ObservabilityVisitorWindowDto;
  @ApiProperty() maxQueryInvocations: number;
}
export class ObservabilityCallerListEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityCallerPageDto }) data: ObservabilityCallerPageDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export class ObservabilityCallerEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityCallerDetailDto }) data: ObservabilityCallerDetailDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export class ObservabilitySourceListEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilitySourcePageDto }) data: ObservabilitySourcePageDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}

export const OBSERVABILITY_CALLER_PATCH_SCHEMA = {
  type: 'object' as const, additionalProperties: false, minProperties: 1, maxProperties: 3,
  properties: {
    displayName: { type: 'string' as const, nullable: true, maxLength: 200 },
    note: { type: 'string' as const, nullable: true, maxLength: 2000 },
    labels: { type: 'array' as const, maxItems: 32, uniqueItems: true,
      items: { type: 'string' as const, minLength: 1, maxLength: 64 } },
  },
};
export class ObservabilityCallerMutationDto {
  @ApiProperty() callerId: string;
  @ApiProperty({ type: String, nullable: true }) displayName: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: [String] }) labels: string[];
  @ApiProperty() profileEtag: string;
  @ApiProperty() changed: boolean;
  @ApiProperty({ type: [String] }) changedFields: string[];
  @ApiProperty() auditId: string;
}
export class ObservabilityCallerMutationEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityCallerMutationDto }) data: ObservabilityCallerMutationDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
