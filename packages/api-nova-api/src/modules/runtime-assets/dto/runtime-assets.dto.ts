import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { TransportType } from '../../../database/entities/mcp-server.entity';

export class RuntimeAssetQueryDto {
  @ApiPropertyOptional({ enum: RuntimeAssetType })
  @IsOptional()
  @IsString()
  type?: RuntimeAssetType;

  @ApiPropertyOptional({ enum: RuntimeAssetStatus })
  @IsOptional()
  @IsString()
  status?: RuntimeAssetStatus;

  @ApiPropertyOptional({ description: 'Search by name or displayName' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class DeployRuntimeAssetMcpDto {
  @ApiPropertyOptional({ description: 'Existing managed server id to update' })
  @IsOptional()
  @IsString()
  targetServerId?: string;

  @ApiPropertyOptional({ description: 'Managed server name override' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Managed server description override' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: TransportType, example: TransportType.STREAMABLE })
  @IsOptional()
  @IsString()
  transport?: TransportType;

  @ApiPropertyOptional({ example: 9022, minimum: 1024, maximum: 65535 })
  @IsOptional()
  @IsNumber()
  @Min(1024)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;
}

export class RuntimeAssetAssemblyQueryDto {
  @ApiPropertyOptional({ description: 'Only include active/published memberships', default: true })
  @IsOptional()
  @IsBoolean()
  publishedOnly?: boolean;
}

export class DeployRuntimeAssetGatewayDto {
  @ApiPropertyOptional({ description: 'Persisted runtime policy binding reference' })
  @IsOptional()
  @IsString()
  policyBindingRef?: string;

  @ApiPropertyOptional({ description: 'Only include active/published memberships', default: true })
  @IsOptional()
  @IsBoolean()
  publishedOnly?: boolean;
}

export class UpdateRuntimeAssetPolicyDto {
  @ApiPropertyOptional({ description: 'Top-level runtime asset policy binding ref' })
  @IsOptional()
  @IsString()
  policyBindingRef?: string;
}
