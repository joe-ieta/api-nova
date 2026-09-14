import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export const OBSERVABILITY_POLICY_PATCH_SCHEMA = {
  type: 'object' as const, additionalProperties: false, required: ['retention', 'reason'],
  properties: {
    retention: { type: 'object' as const, additionalProperties: false, minProperties: 1,
      properties: { eventDays: { type: 'integer' as const, minimum: 1, maximum: 365 },
        payloadDays: { type: 'integer' as const, minimum: 1, maximum: 365 } } },
    reason: { type: 'string' as const, minLength: 1, maxLength: 500 },
  },
};
export class ObservabilityPolicyDto {
  @ApiProperty({ example: 'global-event-retention' }) id: string;
  @ApiProperty({ type: 'object', example: { mode: 'all' } }) scope: object;
  @ApiProperty() revision: number;
  @ApiProperty() policyEtag: string;
  @ApiProperty({ type: 'object', example: { eventDays: 14, payloadDays: 7 } }) retention: object;
  @ApiProperty({ type: String, nullable: true }) effectiveAt: string | null;
  @ApiProperty({ enum: ['new_observability_events_and_payloads_only'] }) retentionImpact: string;
  @ApiProperty({ type: [String] }) affectedEventTypes: string[];
  @ApiProperty({ enum: ['completedAt_or_startedAt'] }) payloadRetentionAnchor: string;
  @ApiProperty({ example: true }) existingPayloadExpiryPreserved: boolean;
  @ApiProperty({ example: false }) existingRecordsChanged: boolean;
  @ApiProperty({ example: false }) cleanupTriggered: boolean;
  @ApiProperty({ type: [String] }) unsupportedSettings: string[];
}
class ObservabilityPolicyListDto {
  @ApiProperty({ type: [ObservabilityPolicyDto] }) items: ObservabilityPolicyDto[];
}
export class ObservabilityPolicyListEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityPolicyListDto }) data: ObservabilityPolicyListDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
class ObservabilityPolicyMutationDto extends ObservabilityPolicyDto {
  @ApiProperty() changed: boolean;
  @ApiProperty() auditId: string;
}
export class ObservabilityPolicyMutationEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityPolicyMutationDto }) data: ObservabilityPolicyMutationDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
