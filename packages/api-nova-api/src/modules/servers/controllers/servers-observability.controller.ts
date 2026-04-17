import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
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

import { JwtAuthGuard } from '../../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../security/guards/permissions.guard';
import { RequirePermissions } from '../../security/decorators/permissions.decorator';
import { HealthCheckQueryDto, MetricsQueryDto } from '../dto/server.dto';
import {
  PaginatedSystemLogResponseDto,
  SystemLogQueryDto,
  SystemLogResponseDto,
} from '../dto/system-log.dto';
import { ServerHealthService } from '../services/server-health.service';
import { ServerManagerService } from '../services/server-manager.service';
import { ServerMetricsService } from '../services/server-metrics.service';
import { ProcessResourceMonitorService } from '../services/process-resource-monitor.service';
import { SystemLogService } from '../services/system-log.service';

@ApiTags('Servers')
@Controller('v1/servers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class ServersObservabilityController {
  private readonly logger = new Logger(ServersObservabilityController.name);

  constructor(
    private readonly serverManager: ServerManagerService,
    private readonly systemLogService: SystemLogService,
    private readonly serverHealth: ServerHealthService,
    private readonly serverMetrics: ServerMetricsService,
    private readonly processResourceMonitor: ProcessResourceMonitorService,
  ) {}

  @Get('health/overview')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get health overview', description: 'Return health overview for all managed servers.' })
  @ApiResponse({ status: 200, description: 'Health overview fetched successfully' })
  async getAllServersHealth() {
    try {
      return await this.serverHealth.getAllServersHealth();
    } catch (error) {
      this.logger.error(`Failed to get all servers health: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get servers health: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('debug/states')
  @RequirePermissions('system:view')
  @ApiOperation({ summary: 'Get debug server states', description: 'Return persisted and runtime state for all managed servers.' })
  @ApiResponse({ status: 200, description: 'Debug state fetched successfully' })
  async debugGetAllServerStates() {
    try {
      return await this.serverManager.debugGetAllServerStates();
    } catch (error) {
      this.logger.error(`Failed to get debug server states: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get debug server states: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('metrics/system')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get system metrics', description: 'Return aggregated system metrics for the management plane.' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 100 })
  @ApiResponse({ status: 200, description: 'System metrics fetched successfully' })
  async getSystemMetrics(@Query() query: MetricsQueryDto) {
    try {
      return this.serverMetrics.getSystemMetrics(query);
    } catch (error) {
      this.logger.error(`Failed to get system metrics: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get system metrics: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('system/resources')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get system resources', description: 'Return current system-wide resource usage for the management plane.' })
  @ApiResponse({ status: 200, description: 'System resources fetched successfully' })
  async getSystemResources() {
    try {
      return await this.processResourceMonitor.getSystemResourceInfo();
    } catch (error) {
      this.logger.error(`Failed to get system resources: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get system resources: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('system-logs')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Query system logs', description: 'Return paginated system logs for the management plane.' })
  @ApiResponse({ status: 200, description: 'System logs fetched successfully', type: PaginatedSystemLogResponseDto })
  async getSystemLogs(@Query() query: SystemLogQueryDto): Promise<PaginatedSystemLogResponseDto> {
    try {
      this.logger.log(`Querying system logs with filters: ${JSON.stringify(query)}`);
      const queryParams = {
        ...query,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };
      const result = await this.systemLogService.queryLogs(queryParams);
      return {
        data: result.logs,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        hasNext: result.page < result.totalPages,
        hasPrev: result.page > 1,
      };
    } catch (error) {
      this.logger.error(`Failed to query system logs: ${error.message}`, error.stack);
      throw new HttpException(`Failed to query system logs: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/health')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get server health', description: 'Return health status for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server health fetched successfully' })
  async getServerHealth(@Param('id') id: string) {
    try {
      return await this.serverHealth.getServerHealth(id);
    } catch (error) {
      this.logger.error(`Failed to get server health ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get server health: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/health/history')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get health history', description: 'Return historical health checks for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 50 })
  @ApiResponse({ status: 200, description: 'Health history fetched successfully' })
  async getHealthCheckHistory(@Param('id') id: string, @Query() query: HealthCheckQueryDto) {
    try {
      return this.serverHealth.getHealthCheckHistory(id, query.limit);
    } catch (error) {
      this.logger.error(`Failed to get health check history ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get health check history: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/health/check')
  @RequirePermissions('server:execute', 'server:manage')
  @ApiOperation({ summary: 'Run health check', description: 'Manually trigger a health check for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Health check executed successfully' })
  async performHealthCheck(@Param('id') id: string) {
    try {
      return await this.serverHealth.performHealthCheck(id);
    } catch (error) {
      this.logger.error(`Failed to perform health check ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to perform health check: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/metrics')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get server metrics', description: 'Return time-series metrics for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time' })
  @ApiQuery({ name: 'interval', required: false, description: 'Time interval', enum: ['minute', 'hour', 'day'] })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 100 })
  @ApiResponse({ status: 200, description: 'Server metrics fetched successfully' })
  async getServerMetrics(@Param('id') id: string, @Query() query: MetricsQueryDto) {
    try {
      return await this.serverMetrics.getServerMetrics(id, query);
    } catch (error) {
      this.logger.error(`Failed to get server metrics ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get server metrics: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/metrics/summary')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get server metric summary', description: 'Return summary and trend metrics for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server metric summary fetched successfully' })
  async getServerPerformanceSummary(@Param('id') id: string) {
    try {
      return await this.serverMetrics.getServerPerformanceSummary(id);
    } catch (error) {
      this.logger.error(`Failed to get server performance summary ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get server performance summary: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/system-logs')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get server system logs', description: 'Return paginated system logs for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server system logs fetched successfully', type: PaginatedSystemLogResponseDto })
  async getServerSystemLogs(@Param('id') id: string, @Query() query: SystemLogQueryDto): Promise<PaginatedSystemLogResponseDto> {
    try {
      await this.serverManager.getServerById(id);
      this.logger.log(`Querying system logs for server ${id} with filters: ${JSON.stringify(query)}`);
      const queryParams = {
        ...query,
        serverId: id,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };
      const result = await this.systemLogService.queryLogs(queryParams);
      return {
        data: result.logs,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        hasNext: result.page < result.totalPages,
        hasPrev: result.page > 1,
      };
    } catch (error) {
      this.logger.error(`Failed to query system logs for server ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to query system logs: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/system-logs/latest')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get latest server system logs', description: 'Return the latest system log entries for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records' })
  @ApiResponse({ status: 200, description: 'Latest system logs fetched successfully', type: [SystemLogResponseDto] })
  async getLatestSystemLogs(@Param('id') id: string, @Query('limit') limit?: number): Promise<SystemLogResponseDto[]> {
    try {
      await this.serverManager.getServerById(id);
      this.logger.log(`Getting latest system logs for server ${id}, limit: ${limit || 10}`);
      return await this.systemLogService.getLatestLogs(id, limit || 10);
    } catch (error) {
      this.logger.error(`Failed to get latest system logs for server ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get latest system logs: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
