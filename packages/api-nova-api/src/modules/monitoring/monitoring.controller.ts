import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RuntimeObservabilityService } from '../runtime-observability/services/runtime-observability.service';
import {
  ManagementAuditResponseDto,
  ManagementEventsResponseDto,
  ManagementOverviewResponseDto,
  MonitoringApiEnvelopeDto,
} from './dto/monitoring.dto';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';

@ApiTags('Monitoring')
@Controller('v1/monitoring')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth()
export class MonitoringController {
  constructor(
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
  ) {}

  @Get('metrics')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get monitoring metrics' })
  @ApiResponse({ status: 200, description: 'Monitoring metrics', type: MonitoringApiEnvelopeDto })
  async getMetrics() {
    const overview = await this.runtimeObservabilityService.getManagementOverview({
      days: 7,
      limit: 20,
    });

    return {
      status: 'success',
      data: overview.metrics,
    };
  }

  @Get('health')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get monitoring health status' })
  @ApiResponse({ status: 200, description: 'Monitoring health status', type: MonitoringApiEnvelopeDto })
  async getHealth() {
    const overview = await this.runtimeObservabilityService.getManagementOverview({
      days: 7,
      limit: 20,
    });

    return {
      status: 'success',
      data: overview.health,
    };
  }

  @Get('events')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum number of events' })
  @ApiOperation({ summary: 'Get recent runtime events' })
  @ApiResponse({ status: 200, description: 'Recent runtime events', type: MonitoringApiEnvelopeDto })
  async getEvents(@Query('limit') limit?: number) {
    return {
      status: 'success',
      data: await this.runtimeObservabilityService.getRecentManagementEvents(
        limit ? Number(limit) : 50,
      ),
    };
  }

  @Get('events/errors')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum number of events' })
  @ApiOperation({ summary: 'Get recent error events' })
  @ApiResponse({ status: 200, description: 'Recent error events', type: MonitoringApiEnvelopeDto })
  async getErrorEvents(@Query('limit') limit?: number) {
    return {
      status: 'success',
      data: await this.runtimeObservabilityService.getRecentManagementErrorEvents(
        limit ? Number(limit) : 50,
      ),
    };
  }

  @Get('management/overview')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Audit statistics range in days' })
  @ApiQuery({ name: 'eventLimit', required: false, type: Number, description: 'Maximum number of recent items' })
  @ApiOperation({ summary: 'Get management observability overview' })
  @ApiResponse({ status: 200, description: 'Management observability overview', type: ManagementOverviewResponseDto })
  async getManagementOverview(
    @Query('days') days?: number,
    @Query('eventLimit') eventLimit?: number,
  ) {
    return {
      status: 'success',
      data: await this.runtimeObservabilityService.getManagementOverview({
        days: days ? Number(days) : 7,
        limit: eventLimit ? Number(eventLimit) : 20,
      }),
    };
  }

  @Get('management/events')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size' })
  @ApiQuery({ name: 'level', required: false, type: String, description: 'Event severity filter' })
  @ApiQuery({ name: 'runtimeAssetId', required: false, type: String, description: 'Runtime asset filter' })
  @ApiOperation({ summary: 'Query management events' })
  @ApiResponse({ status: 200, description: 'Management event stream', type: ManagementEventsResponseDto })
  async getManagementEvents(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('level') level?: string,
    @Query('runtimeAssetId') runtimeAssetId?: string,
  ) {
    const result = await this.runtimeObservabilityService.queryManagementEvents({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      severity: level,
      runtimeAssetId,
    });

    return {
      status: 'success',
      data: result,
    };
  }

  @Get('management/audit')
  @RequirePermissions('audit:read')
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size' })
  @ApiQuery({ name: 'status', required: false, type: String, description: 'Audit status filter' })
  @ApiQuery({ name: 'resource', required: false, type: String, description: 'Resource filter' })
  @ApiOperation({ summary: 'Query management audit stream' })
  @ApiResponse({ status: 200, description: 'Audit log stream', type: ManagementAuditResponseDto })
  async getManagementAudit(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('resource') _resource?: string,
  ) {
    const result = await this.runtimeObservabilityService.queryManagementAudit({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      status,
    });

    return {
      status: 'success',
      data: result,
    };
  }
}
