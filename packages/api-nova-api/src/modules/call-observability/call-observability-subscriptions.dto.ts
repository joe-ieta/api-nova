import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilitySubscriptionDestinationDto {
  @ApiProperty({ enum: ['webhook'] }) type: 'webhook';
  @ApiProperty({ example: 'https://monitor.example/api-nova/events' }) url: string;
}

export class ObservabilitySubscriptionHealthDto {
  @ApiProperty({ enum: ['not_started'] }) state: 'not_started';
  @ApiProperty({ type: String, nullable: true }) lastAttemptAt: string | null;
  @ApiProperty({ type: String, nullable: true }) lastSuccessAt: string | null;
  @ApiProperty({ type: String, nullable: true }) lastFailureAt: string | null;
}

export class ObservabilitySubscriptionDto {
  @ApiProperty() id: string;
  @ApiProperty() version: number;
  @ApiProperty({ enum: ['enabled', 'paused'] }) state: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: ObservabilitySubscriptionDestinationDto }) destination: ObservabilitySubscriptionDestinationDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }) filter: object;
  @ApiProperty() effectiveFromSeq: string;
  @ApiProperty() signingKeyId: string;
  @ApiProperty() secretConfigured: boolean;
  @ApiProperty() editEtag: string;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
  @ApiProperty({ type: ObservabilitySubscriptionHealthDto }) health: ObservabilitySubscriptionHealthDto;
  @ApiProperty() replayed: boolean;
  @ApiProperty() auditId: string;
}

export class ObservabilitySubscriptionEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilitySubscriptionDto }) data: ObservabilitySubscriptionDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}

export const OBSERVABILITY_SUBSCRIPTION_CREATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'destination', 'secretRef'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    destination: { type: 'object', additionalProperties: false, required: ['type', 'url'], properties: {
      type: { type: 'string', enum: ['webhook'] }, url: { type: 'string', minLength: 1, maxLength: 2048 },
    } },
    secretRef: { type: 'string', minLength: 1, maxLength: 128 },
    filter: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    enabled: { type: 'boolean', default: true },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
};
