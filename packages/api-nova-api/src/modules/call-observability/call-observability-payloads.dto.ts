import { ApiProperty } from '@nestjs/swagger';
import { ObservabilityMetaDto } from './call-observability-api.contract';

export class ObservabilityPayloadDto {
  @ApiProperty() invocationId: string;
  @ApiProperty({ minimum: 1 }) recordVersion: number;
  @ApiProperty({ enum: ['request', 'response'] }) side: string;
  @ApiProperty({ enum: ['captured', 'omitted', 'incomplete', 'unavailable'] }) state: string;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty() contentType: string;
  @ApiProperty({ enum: ['json', 'text', 'base64', 'multipart'] }) encoding: 'json' | 'text' | 'base64' | 'multipart';
  @ApiProperty({ type: Number, nullable: true }) observedBytes: number | null;
  @ApiProperty({ minimum: 0 }) capturedBytes: number;
  @ApiProperty({ minimum: 0 }) storedBytes: number;
  @ApiProperty() redacted: boolean;
  @ApiProperty() readRedacted: boolean;
  @ApiProperty() redactionPolicyVersion: string;
  @ApiProperty({ type: String, nullable: true }) capturedDigest: string | null;
  @ApiProperty({ enum: ['observed_raw', 'partial', 'unavailable'] }) digestScope: string;
  @ApiProperty({ nullable: true, oneOf: [
    { type: 'object', additionalProperties: true }, { type: 'array', items: {} },
    { type: 'string' }, { type: 'number' }, { type: 'boolean' },
  ] })
  content: unknown;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt: string | null;
}

export class ObservabilityPayloadEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: ObservabilityPayloadDto }) data: ObservabilityPayloadDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}
