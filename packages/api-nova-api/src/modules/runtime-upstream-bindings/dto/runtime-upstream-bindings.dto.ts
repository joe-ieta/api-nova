import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  RuntimeUpstreamBindingStatus,
  RuntimeUpstreamSelectionMode,
} from '../../../database/entities/runtime-upstream-binding.entity';

export class RuntimeUpstreamCandidateDto {
  @ApiProperty()
  @IsString()
  sourceServiceInstanceId: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpsertRuntimeUpstreamBindingDto {
  @ApiProperty()
  @IsString()
  sourceServiceAssetId: string;

  @ApiProperty({ example: 'production' })
  @IsString()
  environment: string;

  @ApiProperty({ enum: RuntimeUpstreamSelectionMode })
  @IsEnum(RuntimeUpstreamSelectionMode)
  selectionMode: RuntimeUpstreamSelectionMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  primaryInstanceId?: string;

  @ApiPropertyOptional({ enum: RuntimeUpstreamBindingStatus })
  @IsOptional()
  @IsEnum(RuntimeUpstreamBindingStatus)
  status?: RuntimeUpstreamBindingStatus;

  @ApiProperty({ type: [RuntimeUpstreamCandidateDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RuntimeUpstreamCandidateDto)
  candidates: RuntimeUpstreamCandidateDto[];

  @ApiPropertyOptional({ description: 'Reject the write when the stored revision differs' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
