import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import {
  ConfigureGatewayRouteBindingDto,
  OfflineEndpointDto,
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

  @Get('runtime-memberships')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List publication runtime memberships' })
  async listRuntimeMemberships(@Query() query: PublicationMembershipQueryDto) {
    return this.publicationService.listRuntimeMemberships(query);
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
  ) {
    return this.publicationService.upsertRuntimeMembershipProfile(membershipId, body);
  }

  @Put('runtime-memberships/:membershipId/gateway-route')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Configure runtime membership gateway route binding' })
  async configureRuntimeMembershipGatewayRoute(
    @Param('membershipId') membershipId: string,
    @Body() body: ConfigureGatewayRouteBindingDto,
  ) {
    return this.publicationService.configureRuntimeMembershipGatewayRoute(membershipId, body);
  }

  @Post('runtime-memberships/:membershipId/publish')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Publish one runtime membership' })
  async publishRuntimeMembership(
    @Param('membershipId') membershipId: string,
    @Body() body: PublishEndpointDto,
  ) {
    return this.publicationService.publishRuntimeMembership(membershipId, body);
  }

  @Post('runtime-memberships/:membershipId/offline')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Take one runtime membership offline' })
  async offlineRuntimeMembership(
    @Param('membershipId') membershipId: string,
    @Body() body: OfflineEndpointDto,
  ) {
    return this.publicationService.offlineRuntimeMembership(membershipId, body);
  }

  @Get(':id')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get endpoint publication state' })
  @ApiResponse({ status: 200, description: 'Publication state fetched successfully' })
  async getEndpointPublicationState(@Param('id') id: string) {
    return this.publicationService.getEndpointPublicationState(id);
  }

  @Put(':id/profile')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Upsert publication profile' })
  async upsertProfile(
    @Param('id') id: string,
    @Body() body: UpdatePublicationProfileDto,
  ) {
    return this.publicationService.upsertProfile(id, body);
  }

  @Put(':id/gateway-route')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Configure gateway route binding' })
  async configureGatewayRoute(
    @Param('id') id: string,
    @Body() body: ConfigureGatewayRouteBindingDto,
  ) {
    return this.publicationService.configureGatewayRoute(id, body);
  }

  @Post(':id/publish')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Publish endpoint to MCP and/or HTTP surfaces' })
  async publishEndpoint(@Param('id') id: string, @Body() body: PublishEndpointDto) {
    return this.publicationService.publishEndpoint(id, body);
  }

  @Post(':id/offline')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Take endpoint publication offline' })
  async offlineEndpoint(@Param('id') id: string, @Body() body: OfflineEndpointDto) {
    return this.publicationService.offlineEndpoint(id, body);
  }
}
