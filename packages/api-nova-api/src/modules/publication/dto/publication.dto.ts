import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PublicationProfileStatus } from '../../../database/entities/publication-profile.entity';

export class PublicationMembershipQueryDto {
  @ApiPropertyOptional({ description: 'Legacy endpoint/server id' })
  @IsOptional()
  @IsString()
  endpointId?: string;

  @ApiPropertyOptional({ description: 'Runtime asset id' })
  @IsOptional()
  @IsString()
  runtimeAssetId?: string;
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
  @ApiPropertyOptional({ example: '/pets/{id}' })
  @IsOptional()
  @IsString()
  routePath?: string;

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
  @IsInt()
  @Min(1)
  timeoutMs?: number;
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
