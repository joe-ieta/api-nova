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
import { HealthCheckQueryDto, LogQueryDto, OperationResultDto } from '../dto/server.dto';
import { LogLevel } from '../interfaces/process.interface';
import { ProcessErrorHandlerService } from '../services/process-error-handler.service';
import { ProcessHealthService } from '../services/process-health.service';
import { ProcessLogMonitorService } from '../services/process-log-monitor.service';
import { ProcessManagerService } from '../services/process-manager.service';
import { ProcessResourceMonitorService } from '../services/process-resource-monitor.service';

@ApiTags('Servers')
@Controller('v1/servers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class ServersProcessController {
  private readonly logger = new Logger(ServersProcessController.name);

  constructor(
    private readonly processManager: ProcessManagerService,
    private readonly processHealth: ProcessHealthService,
    private readonly processErrorHandler: ProcessErrorHandlerService,
    private readonly processResourceMonitor: ProcessResourceMonitorService,
    private readonly processLogMonitor: ProcessLogMonitorService,
  ) {}

  @Get(':id/process')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process info', description: 'Return process detail for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Process info fetched successfully' })
  async getProcessInfo(@Param('id') id: string) {
    try {
      return await this.processManager.getProcessInfo(id);
    } catch (error) {
      this.logger.error(`Failed to get process info ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get process info: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/logs')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process logs', description: 'Return process logs for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'level', required: false, description: 'Log level filter', enum: ['error', 'warn', 'info', 'debug'] })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of log entries', example: 100 })
  @ApiResponse({ status: 200, description: 'Process logs fetched successfully' })
  async getProcessLogs(@Param('id') id: string, @Query() query: LogQueryDto) {
    try {
      return await this.processErrorHandler.getProcessLogs(id, query.level as LogLevel, query.limit || 100);
    } catch (error) {
      this.logger.error(`Failed to get process logs ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get process logs: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/health/history')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process health history', description: 'Return process health history for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 50 })
  @ApiResponse({ status: 200, description: 'Process health history fetched successfully' })
  async getProcessHealthHistory(@Param('id') id: string, @Query() query: HealthCheckQueryDto) {
    try {
      return await this.processHealth.getHealthCheckHistory(id, query.limit);
    } catch (error) {
      this.logger.error(`Failed to get process health history ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get process health history: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/health/stats')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process health stats', description: 'Return process health statistics for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'period', required: false, description: 'Statistic period in hours' })
  @ApiResponse({ status: 200, description: 'Process health stats fetched successfully' })
  async getProcessHealthStats(@Param('id') id: string, @Query('period') period?: string) {
    try {
      return await this.processHealth.getHealthStats(id, period ? parseInt(period, 10) : 24);
    } catch (error) {
      this.logger.error(`Failed to get process health stats ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get process health stats: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/errors/stats')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process error stats', description: 'Return process error statistics for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'period', required: false, description: 'Statistic period in hours' })
  @ApiResponse({ status: 200, description: 'Process error stats fetched successfully' })
  async getProcessErrorStats(@Param('id') id: string, @Query('period') period?: string) {
    try {
      return await this.processErrorHandler.getErrorStats(id, period ? parseInt(period, 10) : 24);
    } catch (error) {
      this.logger.error(`Failed to get process error stats ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get process error stats: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/reset-restart-counter')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Reset restart counter', description: 'Reset the recorded process restart counter for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Restart counter reset successfully', type: OperationResultDto })
  async resetRestartCounter(@Param('id') id: string): Promise<OperationResultDto> {
    try {
      await this.processErrorHandler.resetRestartCounter(id);
      return { success: true, message: 'Restart counter reset successfully' };
    } catch (error) {
      this.logger.error(`Failed to reset restart counter ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to reset restart counter: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/cancel-restart')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Cancel process restart', description: 'Cancel a pending process restart for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Restart cancelled successfully', type: OperationResultDto })
  async cancelRestart(@Param('id') id: string): Promise<OperationResultDto> {
    try {
      await this.processErrorHandler.cancelRestart(id);
      return { success: true, message: 'Process restart cancelled successfully' };
    } catch (error) {
      this.logger.error(`Failed to cancel restart ${id}: ${error.message}`, error.stack);
      throw new HttpException(`Failed to cancel restart: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/resources')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process resources', description: 'Return current CPU and memory metrics for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Process resource metrics fetched successfully' })
  async getProcessResources(@Param('id') id: string) {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      return await this.processResourceMonitor.getProcessResourceMetrics(processInfo.pid);
    } catch (error) {
      this.logger.error(`Failed to get process resources ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get process resources: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/resources/history')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process resource history', description: 'Return historical resource metrics for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 100 })
  @ApiResponse({ status: 200, description: 'Process resource history fetched successfully' })
  async getProcessResourceHistory(@Param('id') id: string, @Query('limit') limit?: number) {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      return await this.processResourceMonitor.getResourceHistory(id, limit || 100);
    } catch (error) {
      this.logger.error(`Failed to get process resource history ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get process resource history: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/resources/monitor/start')
  @RequirePermissions('server:manage', 'monitoring:manage')
  @ApiOperation({ summary: 'Start resource monitoring', description: 'Start resource monitoring for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'interval', required: false, description: 'Monitor interval in milliseconds', example: 5000 })
  @ApiResponse({ status: 200, description: 'Resource monitoring started successfully', type: OperationResultDto })
  async startResourceMonitoring(@Param('id') id: string, @Query('interval') interval?: number): Promise<OperationResultDto> {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      await this.processResourceMonitor.startMonitoring(id, processInfo.pid, interval || 5000);
      return { success: true, message: 'Resource monitoring started successfully' };
    } catch (error) {
      this.logger.error(`Failed to start resource monitoring ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to start resource monitoring: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/resources/monitor/stop')
  @RequirePermissions('server:manage', 'monitoring:manage')
  @ApiOperation({ summary: 'Stop resource monitoring', description: 'Stop resource monitoring for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Resource monitoring stopped successfully', type: OperationResultDto })
  async stopResourceMonitoring(@Param('id') id: string): Promise<OperationResultDto> {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      await this.processResourceMonitor.stopMonitoring(id);
      return { success: true, message: 'Resource monitoring stopped successfully' };
    } catch (error) {
      this.logger.error(`Failed to stop resource monitoring ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to stop resource monitoring: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/full-info')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process full info', description: 'Return aggregated process info, resources, and latest logs for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Full process info fetched successfully' })
  async getProcessFullInfo(@Param('id') id: string) {
    try {
      return await this.processManager.getProcessFullInfo(id);
    } catch (error) {
      this.logger.error(`Failed to get process full info ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get process full info: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/logs/history')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get process log history', description: 'Return historical process log records for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 100 })
  @ApiResponse({ status: 200, description: 'Process log history fetched successfully' })
  async getProcessLogHistory(@Param('id') id: string, @Query('limit') limit?: number) {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      return await this.processLogMonitor.getLogHistory(id, limit || 100);
    } catch (error) {
      this.logger.error(`Failed to get process log history ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get process log history: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/process/logs/search')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Search process logs', description: 'Search process logs for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'keyword', required: true, description: 'Search keyword' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of records', example: 50 })
  @ApiResponse({ status: 200, description: 'Process log search completed successfully' })
  async searchProcessLogs(@Param('id') id: string, @Query('keyword') keyword: string, @Query('limit') limit?: number) {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      return await this.processLogMonitor.searchLogs(id, { keyword, limit: limit || 50 });
    } catch (error) {
      this.logger.error(`Failed to search process logs ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to search process logs: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/logs/monitor/start')
  @RequirePermissions('server:manage', 'monitoring:manage')
  @ApiOperation({ summary: 'Start log monitoring', description: 'Start log monitoring for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiQuery({ name: 'logFile', required: false, description: 'Explicit log file path' })
  @ApiResponse({ status: 200, description: 'Log monitoring started successfully', type: OperationResultDto })
  async startLogMonitoring(@Param('id') id: string, @Query('logFile') logFile?: string): Promise<OperationResultDto> {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      await this.processLogMonitor.startLogMonitoring(id, processInfo.pid, logFile);
      return { success: true, message: 'Log monitoring started successfully' };
    } catch (error) {
      this.logger.error(`Failed to start log monitoring ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to start log monitoring: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/logs/monitor/stop')
  @RequirePermissions('server:manage', 'monitoring:manage')
  @ApiOperation({ summary: 'Stop log monitoring', description: 'Stop log monitoring for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Log monitoring stopped successfully', type: OperationResultDto })
  async stopLogMonitoring(@Param('id') id: string): Promise<OperationResultDto> {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      await this.processLogMonitor.stopLogMonitoring(id);
      return { success: true, message: 'Log monitoring stopped successfully' };
    } catch (error) {
      this.logger.error(`Failed to stop log monitoring ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to stop log monitoring: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/process/logs/clear')
  @RequirePermissions('server:manage', 'monitoring:manage')
  @ApiOperation({ summary: 'Clear log buffer', description: 'Clear the in-memory log buffer for a managed server process.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Log buffer cleared successfully', type: OperationResultDto })
  async clearProcessLogBuffer(@Param('id') id: string): Promise<OperationResultDto> {
    try {
      const processInfo = await this.processManager.getProcessInfo(id);
      if (!processInfo || !processInfo.pid) {
        throw new HttpException('Process not found or not running', HttpStatus.NOT_FOUND);
      }
      await this.processLogMonitor.clearLogBuffer(id);
      return { success: true, message: 'Log buffer cleared successfully' };
    } catch (error) {
      this.logger.error(`Failed to clear log buffer ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found') || error.message.includes('not running')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to clear log buffer: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
