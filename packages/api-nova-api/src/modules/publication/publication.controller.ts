import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../security/decorators/current-user.decorator';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import {
  AddPublicationRuntimeMembershipsDto,
  BatchOfflineRuntimeMembershipsDto,
  BatchPublishRuntimeMembershipsDto,
  CreatePublicationRuntimeAssetDto,
  PublicationCandidateQueryDto,
  ConfigureGatewayRouteBindingDto,
  OfflineEndpointDto,
  PublicationAuditQueryDto,
  PublicationBatchRunQueryDto,
  PublicationMembershipQueryDto,
  PublishEndpointDto,
  UpdatePublicationProfileDto,
} from './dto/publication.dto';
import { PublicationService } from './services/publication.service';

@ApiTags('Publication')
@Controller('v1/publication/endpoints')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class PublicationController {
  constructor(private readonly publicationService: PublicationService) {}

  @Get('candidates')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List publication candidates from governance-ready endpoint catalog' })
  async listPublicationCandidates(@Query() query: PublicationCandidateQueryDto) {
    return this.publicationService.listPublicationCandidates(query);
  }

  @Get('runtime-memberships')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List publication runtime memberships' })
  async listRuntimeMemberships(@Query() query: PublicationMembershipQueryDto) {
    return this.publicationService.listRuntimeMemberships(query);
  }

  @Get('audit-events')
  @RequirePermissions('audit:read')
  @ApiOperation({ summary: 'List publication audit events' })
  async listPublicationAuditEvents(@Query() query: PublicationAuditQueryDto) {
    return this.publicationService.listPublicationAuditEvents(query);
  }

  @Get('batch-runs')
  @RequirePermissions('audit:read')
  @ApiOperation({ summary: 'List publication batch runs' })
  async listPublicationBatchRuns(@Query() query: PublicationBatchRunQueryDto) {
    return this.publicationService.listPublicationBatchRuns(query);
  }

  @Post('runtime-assets')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Create one publication runtime asset draft' })
  async createPublicationRuntimeAsset(
    @Body() body: CreatePublicationRuntimeAssetDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.createPublicationRuntimeAsset(body, currentUserId);
  }

  @Post('runtime-assets/:runtimeAssetId/memberships')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Add ready endpoints into one publication runtime asset' })
  async addPublicationRuntimeMemberships(
    @Param('runtimeAssetId') runtimeAssetId: string,
    @Body() body: AddPublicationRuntimeMembershipsDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.addPublicationRuntimeMemberships(
      runtimeAssetId,
      body,
      currentUserId,
    );
  }

  @Get('runtime-memberships/:membershipId')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get runtime membership publication state' })
  async getRuntimeMembershipPublicationState(@Param('membershipId') membershipId: string) {
    return this.publicationService.getRuntimeMembershipPublicationState(membershipId);
  }

  @Put('runtime-memberships/:membershipId/profile')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Upsert runtime membership publication profile' })
  async upsertRuntimeMembershipProfile(
    @Param('membershipId') membershipId: string,
    @Body() body: UpdatePublicationProfileDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.upsertRuntimeMembershipProfile(
      membershipId,
      body,
      currentUserId,
    );
  }

  @Put('runtime-memberships/:membershipId/gateway-route')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Configure runtime membership gateway route binding' })
  async configureRuntimeMembershipGatewayRoute(
    @Param('membershipId') membershipId: string,
    @Body() body: ConfigureGatewayRouteBindingDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.configureRuntimeMembershipGatewayRoute(
      membershipId,
      body,
      currentUserId,
    );
  }

  @Post('runtime-memberships/batch/publish')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Batch publish runtime memberships' })
  async batchPublishRuntimeMemberships(
    @Body() body: BatchPublishRuntimeMembershipsDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.batchPublishRuntimeMemberships(body, currentUserId);
  }

  @Post('runtime-memberships/batch/offline')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Batch offline runtime memberships' })
  async batchOfflineRuntimeMemberships(
    @Body() body: BatchOfflineRuntimeMembershipsDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.batchOfflineRuntimeMemberships(body, currentUserId);
  }

  @Post('runtime-memberships/:membershipId/publish')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Publish one runtime membership' })
  async publishRuntimeMembership(
    @Param('membershipId') membershipId: string,
    @Body() body: PublishEndpointDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.publishRuntimeMembership(
      membershipId,
      body,
      currentUserId,
    );
  }

  @Post('runtime-memberships/:membershipId/offline')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Take one runtime membership offline' })
  async offlineRuntimeMembership(
    @Param('membershipId') membershipId: string,
    @Body() body: OfflineEndpointDto,
    @CurrentUserId() currentUserId?: string,
  ) {
    return this.publicationService.offlineRuntimeMembership(
      membershipId,
      body,
      currentUserId,
    );
  }
}
