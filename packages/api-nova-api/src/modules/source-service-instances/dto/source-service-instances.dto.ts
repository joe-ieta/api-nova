import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { SourceServiceInstanceStatus } from '../../../database/entities/source-service-instance.entity';

const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9_-]{0,99}$/;

export class SourceServiceInstanceQueryDto {
  @ApiPropertyOptional({ example: 'production' })
  @IsOptional()
  @IsString()
  @Matches(ENVIRONMENT_PATTERN)
  environment?: string;

  @ApiPropertyOptional({ enum: SourceServiceInstanceStatus })
  @IsOptional()
  @IsIn(Object.values(SourceServiceInstanceStatus))
  status?: SourceServiceInstanceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateSourceServiceInstanceDto {
  @ApiProperty({ example: 'orders-production-1' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiProperty({ example: 'production' })
  @IsString()
  @Matches(ENVIRONMENT_PATTERN)
  environment: string;

  @ApiProperty({ enum: ['http', 'https'] })
  @IsString()
  @IsIn(['http', 'https'])
  scheme: string;

  @ApiProperty({ example: 'orders.internal' })
  @IsString()
  @Length(1, 255)
  host: string;

  @ApiProperty({ minimum: 1, maximum: 65535, example: 8443 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiPropertyOptional({ default: '/', example: '/api' })
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  basePath?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 100, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ default: 100, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    example: 'env-headers:Authorization=UPSTREAM_API_TOKEN',
    description: 'Header-to-environment mapping; multiple mappings use semicolons. Secret values are never persisted.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  credentialRef?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  tlsPolicyRef?: string;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateSourceServiceInstanceDto extends PartialType(
  CreateSourceServiceInstanceDto,
) {}

export class ProbeSourceServiceInstanceDto {
  @ApiPropertyOptional({ default: 8000, minimum: 500, maximum: 30000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(30000)
  timeoutMs?: number;
}
