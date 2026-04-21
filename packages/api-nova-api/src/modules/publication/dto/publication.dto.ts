import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PublicationProfileStatus } from '../../../database/entities/publication-profile.entity';
import { PublicationBatchAction } from '../../../database/entities/publication-batch-run.entity';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayRoutePathMatchMode } from '../../../database/entities/gateway-route-binding.entity';

export class PublicationCandidateQueryDto {
  @ApiPropertyOptional({ description: 'Source service asset id' })
  @IsOptional()
  @IsString()
  sourceServiceAssetId?: string;

  @ApiPropertyOptional({ description: 'Search by name, method, path, or source key' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Include blocked candidates', default: false })
  @IsOptional()
  @IsBoolean()
  includeBlocked?: boolean;
}

export class PublicationMembershipQueryDto {
  @ApiPropertyOptional({ description: 'Endpoint definition id' })
  @IsOptional()
  @IsString()
  endpointDefinitionId?: string;

  @ApiPropertyOptional({ description: 'Runtime asset id' })
  @IsOptional()
  @IsString()
  runtimeAssetId?: string;
}

export class PublicationAuditQueryDto {
  @ApiPropertyOptional({ description: 'Runtime asset id' })
  @IsOptional()
  @IsString()
  runtimeAssetId?: string;

  @ApiPropertyOptional({ description: 'Runtime membership id' })
  @IsOptional()
  @IsString()
  runtimeAssetEndpointBindingId?: string;

  @ApiPropertyOptional({ description: 'Batch run id' })
  @IsOptional()
  @IsString()
  publicationBatchRunId?: string;

  @ApiPropertyOptional({ description: 'Max events to return', default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class PublicationBatchRunQueryDto {
  @ApiPropertyOptional({ description: 'Runtime asset id' })
  @IsOptional()
  @IsString()
  runtimeAssetId?: string;

  @ApiPropertyOptional({ enum: PublicationBatchAction })
  @IsOptional()
  @IsString()
  action?: PublicationBatchAction;

  @ApiPropertyOptional({ description: 'Max batch runs to return', default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CreatePublicationRuntimeAssetDto {
  @ApiPropertyOptional({ enum: RuntimeAssetType })
  @IsString()
  type: RuntimeAssetType;

  @ApiPropertyOptional()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  policyBindingRef?: string;
}

export class AddPublicationRuntimeMembershipsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  endpointDefinitionIds: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class BatchPublishRuntimeMembershipsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  membershipIds: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  publishToMcp?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  publishToHttp?: boolean;
}

export class BatchOfflineRuntimeMembershipsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  membershipIds: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  offlineMcp?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  offlineHttp?: boolean;
}

export class UpdatePublicationProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  intentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionForLlm?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  operatorNotes?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  inputAliases?: Record<string, string>;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  constraints?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  examples?: Array<Record<string, unknown>>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  visibility?: string;

  @ApiPropertyOptional({ enum: PublicationProfileStatus })
  @IsOptional()
  @IsString()
  status?: PublicationProfileStatus;
}

export class ConfigureGatewayRouteBindingDto {
  @ApiPropertyOptional({ example: 'gateway.internal' })
  @IsOptional()
  @IsString()
  matchHost?: string;

  @ApiPropertyOptional({ example: '/pets/{id}' })
  @IsOptional()
  @IsString()
  routePath?: string;

  @ApiPropertyOptional({ enum: GatewayRoutePathMatchMode, default: GatewayRoutePathMatchMode.EXACT })
  @IsOptional()
  @IsString()
  pathMatchMode?: GatewayRoutePathMatchMode;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ example: '/pets/{id}' })
  @IsOptional()
  @IsString()
  upstreamPath?: string;

  @ApiPropertyOptional({ example: 'GET' })
  @IsOptional()
  @IsString()
  routeMethod?: string;

  @ApiPropertyOptional({ example: 'GET' })
  @IsOptional()
  @IsString()
  upstreamMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  routeVisibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  authPolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trafficPolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  loggingPolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cachePolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rateLimitPolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  circuitBreakerPolicyRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  upstreamConfig?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  routeStatusReason?: string;
}

export class PublishEndpointDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  publishToMcp?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  publishToHttp?: boolean;
}

export class OfflineEndpointDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  offlineMcp?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  offlineHttp?: boolean;
}
