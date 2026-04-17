import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../security/guards/permissions.guard';
import { RequirePermissions } from '../../security/decorators/permissions.decorator';
import {
  SystemLogEventType,
  SystemLogLevel,
  SystemLogStatus,
} from '../../../database/entities/system-log.entity';
import { ApiManagementCenterService } from '../services/api-management-center.service';
import { ManagementEventService } from '../services/management-event.service';
import {
  ApiCenterQueryDto,
  ChangeEndpointStateDto,
  ProbeEndpointDto,
  RegisterManualEndpointDto,
  UpdateApiManagementProfileDto,
} from '../dto/api-management.dto';

@ApiTags('Servers')
@Controller('v1/servers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class ServersApiCenterController {
  private readonly logger = new Logger(ServersApiCenterController.name);

  constructor(
    private readonly apiManagementCenter: ApiManagementCenterService,
    private readonly managementEvents: ManagementEventService,
  ) {}

  @Get('api-center/overview')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get API center overview', description: 'Return the governance overview for API onboarding and endpoint lifecycle.' })
  @ApiResponse({ status: 200, description: 'Overview fetched successfully' })
  async getApiCenterOverview(@Query() query: ApiCenterQueryDto) {
    try {
      return await this.apiManagementCenter.getOverview(query);
    } catch (error) {
      this.logger.error(`Failed to get API center overview: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get API center overview: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id/api-center/profile')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Update API center profile', description: 'Update onboarding source, category, and lifecycle profile for a managed endpoint.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  async updateApiCenterProfile(
    @Param('id') id: string,
    @Body() body: UpdateApiManagementProfileDto,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    try {
      const result = await this.apiManagementCenter.updateProfile(id, body);
      await this.managementEvents.record({
        action: 'api-center.profile.update',
        message: `API center profile updated for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        details: { updatedFields: Object.keys(body ?? {}) },
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to update API center profile for ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'api-center.profile.update',
        message: `API center profile update failed for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { updatedFields: Object.keys(body ?? {}), error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to update API center profile: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/api-center/probe')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Probe endpoint', description: 'Trigger an endpoint availability probe and persist the result.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Probe completed successfully' })
  async probeEndpoint(
    @Param('id') id: string,
    @Body() body: ProbeEndpointDto,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    try {
      const result = await this.apiManagementCenter.probeEndpoint(id, body);
      await this.managementEvents.record({
        action: 'api-center.endpoint.probe',
        message: `Endpoint probe completed for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.HEALTH_CHECK_PASSED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        details: { path: body.path },
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to probe endpoint for ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'api-center.endpoint.probe',
        message: `Endpoint probe failed for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.HEALTH_CHECK_FAILED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { path: body.path, error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to probe endpoint: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/api-center/publish-readiness')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get publish readiness', description: 'Return readiness checks for endpoint publish operations.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Readiness fetched successfully' })
  async getPublishReadiness(@Param('id') id: string) {
    try {
      return await this.apiManagementCenter.getPublishReadiness(id);
    } catch (error) {
      this.logger.error(`Failed to get publish readiness for ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get publish readiness: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/api-center/probe-history')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get probe history', description: 'Return the historical probe records for a managed endpoint.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({ status: 200, description: 'Probe history fetched successfully' })
  async getProbeHistory(@Param('id') id: string, @Query('limit') limit?: number) {
    try {
      return await this.apiManagementCenter.getProbeHistory(id, limit ? Number(limit) : 20);
    } catch (error) {
      this.logger.error(`Failed to get probe history for ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get probe history: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('api-center/manual-endpoint')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Register manual endpoint', description: 'Register a manually managed endpoint into the API center.' })
  @ApiResponse({ status: 201, description: 'Endpoint registered successfully' })
  async registerManualEndpoint(
    @Body() body: RegisterManualEndpointDto,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    try {
      const result = await this.apiManagementCenter.registerManualEndpoint(body);
      await this.managementEvents.record({
        action: 'api-center.manual-endpoint.register',
        message: `Manual endpoint ${body.name} registered`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        serverId: result?.serverId,
        serverName: body.name,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        details: { path: body.path, method: body.method, baseUrl: body.baseUrl },
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to register manual endpoint: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'api-center.manual-endpoint.register',
        message: `Manual endpoint ${body.name} registration failed`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { name: body.name, path: body.path, method: body.method, error: error.message },
      });
      throw new HttpException(`Failed to register manual endpoint: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/api-center/state')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Change endpoint state', description: 'Run publish or offline transitions for a managed endpoint.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'State changed successfully' })
  async changeEndpointState(
    @Param('id') id: string,
    @Body() body: ChangeEndpointStateDto,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    try {
      const result = await this.apiManagementCenter.changeEndpointState(id, body);
      await this.managementEvents.record({
        action: `api-center.endpoint.${body.action}`,
        message: `Endpoint state ${body.action} completed for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        details: { action: body.action },
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to change endpoint state for ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: `api-center.endpoint.${body.action}`,
        message: `Endpoint state ${body.action} failed for ${id}`,
        source: 'servers-api-center-controller',
        eventType: SystemLogEventType.SERVER_CONFIG_CHANGED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { action: body.action, error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to change endpoint state: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  private getActorId(req?: Request & { user?: { id?: string } }): string | undefined {
    return req?.user?.id;
  }

  private getRequestId(req?: Request): string | undefined {
    return req?.headers?.['x-request-id']?.toString();
  }
}
