import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EndpointTestRunStatus } from '../../../database/entities/endpoint-test-run.entity';
import { EndpointTestSampleStatus } from '../../../database/entities/endpoint-test-sample.entity';

export class CreateEndpointTestCaseDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  requestTemplate?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  assertions?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateEndpointTestCaseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  requestTemplate?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  assertions?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class EndpointTestRunQueryDto {
  @ApiPropertyOptional({ enum: EndpointTestRunStatus })
  @IsOptional()
  @IsEnum(EndpointTestRunStatus)
  status?: EndpointTestRunStatus;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class EndpointTestSampleQueryDto {
  @ApiPropertyOptional({ enum: EndpointTestSampleStatus })
  @IsOptional()
  @IsEnum(EndpointTestSampleStatus)
  status?: EndpointTestSampleStatus;

  @ApiPropertyOptional({ description: 'Exact fingerprint filter' })
  @IsOptional()
  @IsString()
  fingerprint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateEndpointTestSampleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: EndpointTestSampleStatus })
  @IsOptional()
  @IsEnum(EndpointTestSampleStatus)
  status?: EndpointTestSampleStatus;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
