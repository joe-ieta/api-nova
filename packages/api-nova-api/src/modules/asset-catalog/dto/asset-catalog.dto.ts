import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { EndpointDefinitionStatus } from '../../../database/entities/endpoint-definition.entity';

export class AssetCatalogQueryDto {
  @ApiPropertyOptional({ description: 'Source key search' })
  @IsOptional()
  @IsString()
  sourceKey?: string;

  @ApiPropertyOptional({ description: 'Host filter' })
  @IsOptional()
  @IsString()
  host?: string;
}

export class EndpointCatalogQueryDto {
  @ApiPropertyOptional({ description: 'Source service asset filter' })
  @IsOptional()
  @IsString()
  sourceServiceAssetId?: string;

  @ApiPropertyOptional({ description: 'Endpoint status filter', enum: EndpointDefinitionStatus })
  @IsOptional()
  @IsString()
  status?: EndpointDefinitionStatus;

  @ApiPropertyOptional({ description: 'Search by method/path/summary/operationId' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class UpdateEndpointDefinitionGovernanceDto {
  @ApiPropertyOptional({ enum: EndpointDefinitionStatus })
  @IsOptional()
  @IsString()
  status?: EndpointDefinitionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  publishEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
