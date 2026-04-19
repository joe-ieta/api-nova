import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { EndpointDefinitionStatus } from '../../../database/entities/endpoint-definition.entity';
import { ApiProperty } from '@nestjs/swagger';

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

export class RegisterManualEndpointAssetDto {
  @ApiProperty({ description: 'Display name for the manual endpoint asset', example: 'manual-pet-query' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Upstream API base URL', example: 'https://api.example.com' })
  @IsString()
  baseUrl: string;

  @ApiProperty({ description: 'HTTP method', example: 'GET' })
  @IsString()
  method: string;

  @ApiProperty({ description: 'Endpoint path', example: '/pets/{id}' })
  @IsString()
  path: string;

  @ApiPropertyOptional({ description: 'Endpoint description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Business domain classification' })
  @IsOptional()
  @IsString()
  businessDomain?: string;

  @ApiPropertyOptional({ description: 'Risk level', example: 'medium' })
  @IsOptional()
  @IsString()
  riskLevel?: string;
}

export class UpdateManualEndpointAssetDto {
  @ApiProperty({ description: 'Display name for the manual endpoint asset', example: 'manual-pet-query' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Upstream API base URL', example: 'https://api.example.com' })
  @IsString()
  baseUrl: string;

  @ApiProperty({ description: 'HTTP method', example: 'GET' })
  @IsString()
  method: string;

  @ApiProperty({ description: 'Endpoint path', example: '/pets/{id}' })
  @IsString()
  path: string;

  @ApiPropertyOptional({ description: 'Endpoint description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Business domain classification' })
  @IsOptional()
  @IsString()
  businessDomain?: string;

  @ApiPropertyOptional({ description: 'Risk level', example: 'medium' })
  @IsOptional()
  @IsString()
  riskLevel?: string;
}

export class ExecuteEndpointDefinitionTestDto {
  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
