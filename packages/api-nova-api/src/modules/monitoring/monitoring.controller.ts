import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SystemLogLevel } from '../../database/entities/system-log.entity';
import { MCPMonitoringService } from '../../services/monitoring.service';
import {
  ManagementAuditResponseDto,
  ManagementEventsResponseDto,
  ManagementOverviewResponseDto,
  MonitoringApiEnvelopeDto,
} from './dto/monitoring.dto';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { AuditService } from '../security/services/audit.service';
import { SystemLogService } from '../servers/services/system-log.service';

@ApiTags('Monitoring')
@Controller('api/v1/monitoring')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth()
export class MonitoringController {
  constructor(
    private readonly monitoringService: MCPMonitoringService,
    private readonly auditService: AuditService,
    private readonly systemLogService: SystemLogService,
  ) {}

  @Get('metrics')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get monitoring metrics' })
  @ApiResponse({ status: 200, description: 'Monitoring metrics', type: MonitoringApiEnvelopeDto })
  getMetrics() {
    return {
      status: 'success',
      data: this.monitoringService.getMetrics(),
    };
  }

  @Get('health')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get monitoring health status' })
  @ApiResponse({ status: 200, description: 'Monitoring health status', type: MonitoringApiEnvelopeDto })
  getHealth() {
    return {
      status: 'success',
      data: this.monitoringService.getHealthStatus(),
    };
  }

  @Get('events')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum number of events' })
  @ApiOperation({ summary: 'Get recent runtime events' })
  @ApiResponse({ status: 200, description: 'Recent runtime events', type: MonitoringApiEnvelopeDto })
  getEvents(@Query('limit') limit?: number) {
    return {
      status: 'success',
      data: this.monitoringService.getRecentEvents(limit ? Number(limit) : 50),
    };
  }

  @Get('events/errors')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum number of events' })
  @ApiOperation({ summary: 'Get recent error events' })
  @ApiResponse({ status: 200, description: 'Recent error events', type: MonitoringApiEnvelopeDto })
  getErrorEvents(@Query('limit') limit?: number) {
    return {
      status: 'success',
      data: this.monitoringService.getEventsByType('error', limit ? Number(limit) : 50),
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
    const rangeDays = days ? Number(days) : 7;
    const listLimit = eventLimit ? Number(eventLimit) : 20;

    const [auditStats, systemEvents] = await Promise.all([
      this.auditService.getAuditStats({
        startDate: this.getStartDate(rangeDays),
        endDate: new Date(),
      }),
      this.systemLogService.queryLogs({
        page: 1,
        limit: listLimit,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      }),
    ]);

    return {
      status: 'success',
      data: {
        metrics: this.monitoringService.getMetrics(),
        health: this.monitoringService.getHealthStatus(),
        auditStats,
        recentRuntimeEvents: this.monitoringService.getRecentEvents(listLimit),
        recentManagementLogs: systemEvents.logs,
      },
    };
  }

  @Get('management/events')
  @RequirePermissions('monitoring:read')
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size' })
  @ApiQuery({ name: 'level', required: false, enum: SystemLogLevel, description: 'Log level filter' })
  @ApiQuery({ name: 'serverId', required: false, type: String, description: 'Server ID filter' })
  @ApiOperation({ summary: 'Query management events' })
  @ApiResponse({ status: 200, description: 'Management event stream', type: ManagementEventsResponseDto })
  async getManagementEvents(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('level') level?: SystemLogLevel,
    @Query('serverId') serverId?: string,
  ) {
    const result = await this.systemLogService.queryLogs({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      level,
      serverId,
      sortBy: 'createdAt',
      sortOrder: 'DESC',
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
    @Query('resource') resource?: string,
  ) {
    const result = await this.auditService.findLogs({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      status,
      resource,
    } as any);

    return {
      status: 'success',
      data: result,
    };
  }

  private getStartDate(days: number): Date {
    const start = new Date();
    start.setDate(start.getDate() - days);
    return start;
  }
}
