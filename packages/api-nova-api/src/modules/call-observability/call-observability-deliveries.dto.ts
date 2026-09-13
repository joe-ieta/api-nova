import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityDeliveryAttemptDto {
  @ApiProperty() attemptNo: number;
  @ApiProperty() startedAt: string;
  @ApiProperty({ type: String, nullable: true }) completedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationMs: number | null;
  @ApiProperty({ type: Number, nullable: true }) httpStatus: number | null;
  @ApiProperty() result: string;
  @ApiProperty({ type: String, nullable: true }) errorCategory: string | null;
  @ApiProperty({ type: String, nullable: true }) responseSummary: string | null;
}
export class ObservabilityDeliveryDto {
  @ApiProperty() deliveryId: string;
  @ApiProperty() eventId: string;
  @ApiProperty() subscriptionId: string;
  @ApiProperty() subscriptionRevision: number;
  @ApiProperty() version: number;
  @ApiProperty({ enum: ['pending', 'in_flight', 'retry_wait', 'succeeded', 'dead', 'cancelled'] }) status: string;
  @ApiProperty() attemptCount: number;
  @ApiProperty() replayGeneration: number;
  @ApiProperty() suspendedBySubscription: boolean;
  @ApiProperty({ type: String, nullable: true }) nextAttemptAt: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) lastError: object;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
  @ApiProperty() expiresAt: string;
  @ApiPropertyOptional() replayed?: boolean;
  @ApiPropertyOptional() auditId?: string;
}
export class ObservabilityDeliveryPageDto {
  @ApiProperty({ type: [ObservabilityDeliveryDto] }) items: ObservabilityDeliveryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() hasMore: boolean;
  @ApiProperty() scannedDeliveries: number;
}
export class ObservabilityDeliveryPageEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityDeliveryPageDto }) data: ObservabilityDeliveryPageDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export class ObservabilityDeliveryDetailDto extends ObservabilityDeliveryDto {
  @ApiProperty({ type: [ObservabilityDeliveryAttemptDto] }) attempts: ObservabilityDeliveryAttemptDto[];
  @ApiProperty({ type: String, nullable: true }) nextAttemptsCursor: string | null;
  @ApiProperty() hasMoreAttempts: boolean;
}
export class ObservabilityDeliveryEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityDeliveryDto }) data: ObservabilityDeliveryDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export class ObservabilityDeliveryDetailEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityDeliveryDetailDto }) data: ObservabilityDeliveryDetailDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
export const OBSERVABILITY_SUBSCRIPTION_TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
};
export const OBSERVABILITY_DELIVERY_RETRY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    subscriptionRevision: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
