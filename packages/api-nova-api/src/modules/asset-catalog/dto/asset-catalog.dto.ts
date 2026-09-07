import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
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

export class ManualEndpointParameterDto {
  @ApiProperty({ description: 'Parameter name', example: 'id' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Parameter location', enum: ['path', 'query', 'header'] })
  @IsIn(['path', 'query', 'header'])
  in: 'path' | 'query' | 'header';

  @ApiPropertyOptional({ description: 'Whether the parameter is required', default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: 'OpenAPI schema type', example: 'string' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ type: 'object', description: 'JSON schema for the parameter' })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Parameter description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Example value used by callers and probe/test' })
  @IsOptional()
  example?: unknown;
}

export class ManualEndpointRequestBodyDto {
  @ApiPropertyOptional({ description: 'Whether the request body is required', default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: 'OpenAPI schema type', example: 'object' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Body description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: 'object', description: 'Full JSON schema for the body' })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Example request body used by probe/test' })
  @IsOptional()
  example?: unknown;
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

  @ApiPropertyOptional({ type: [ManualEndpointParameterDto], description: 'Simplified OpenAPI parameter template (path/query/header)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualEndpointParameterDto)
  parameters?: ManualEndpointParameterDto[];

  @ApiPropertyOptional({ type: ManualEndpointRequestBodyDto, description: 'Simplified OpenAPI request body template' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ManualEndpointRequestBodyDto)
  requestBody?: ManualEndpointRequestBodyDto | null;
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

  @ApiPropertyOptional({ type: [ManualEndpointParameterDto], description: 'Simplified OpenAPI parameter template (path/query/header)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualEndpointParameterDto)
  parameters?: ManualEndpointParameterDto[];

  @ApiPropertyOptional({ type: ManualEndpointRequestBodyDto, description: 'Simplified OpenAPI request body template' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ManualEndpointRequestBodyDto)
  requestBody?: ManualEndpointRequestBodyDto | null;
}

export class ExecuteEndpointDefinitionTestDto {
  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Explicit source service runtime instance id' })
  @IsOptional()
  @IsString()
  sourceServiceInstanceId?: string;

  @ApiPropertyOptional({ description: 'Environment used when selecting the default instance' })
  @IsOptional()
  @IsString()
  environment?: string;
}
