import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request } from 'express';

import { JwtAuthGuard } from '../../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../security/guards/permissions.guard';
import { RequirePermissions } from '../../security/decorators/permissions.decorator';
import { OpenAPIService } from '../../openapi/services/openapi.service';
import {
  SystemLogEventType,
  SystemLogLevel,
  SystemLogStatus,
} from '../../../database/entities/system-log.entity';
import { ServerManagerService } from '../services/server-manager.service';
import { ManagementEventService } from '../services/management-event.service';
import {
  BatchServerActionDto,
  CreateServerDto,
  OperationResultDto,
  PaginatedResponseDto,
  ServerActionDto,
  ServerQueryDto,
  ServerResponseDto,
  UpdateServerDto,
} from '../dto/server.dto';

@ApiTags('Servers')
@Controller('v1/servers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class ServersLifecycleController {
  private readonly logger = new Logger(ServersLifecycleController.name);

  constructor(
    private readonly serverManager: ServerManagerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly openApiService: OpenAPIService,
    private readonly managementEvents: ManagementEventService,
  ) {}

  @Post()
  @RequirePermissions('server:create', 'server:manage')
  @ApiOperation({ summary: 'Create server', description: 'Create a managed API server from the submitted configuration.' })
  @ApiResponse({ status: 201, description: 'Server created successfully', type: ServerResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @ApiResponse({ status: 409, description: 'Server name or port already exists' })
  async createServer(@Body() createDto: CreateServerDto, @Req() req: Request & { user?: { id?: string } }): Promise<ServerResponseDto> {
    try {
      this.logger.log(`Creating server: ${createDto.name}`);
      const server = await this.serverManager.createServer(createDto);
      await this.managementEvents.record({
        action: 'server.create',
        message: `Server ${server.name} created`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_CREATED,
        serverId: server.id,
        serverName: server.name,
        serverPort: server.port,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.SUCCESS,
        details: { transport: server.transport },
      });
      return server;
    } catch (error) {
      this.logger.error(`Failed to create server: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'server.create',
        message: `Server creation failed for ${createDto.name}`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_CREATED,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { name: createDto.name, error: error.message },
      });

      if (error.message.includes('already exists') || error.message.includes('already in use')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }

      throw new HttpException(`Failed to create server: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  @Get()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List servers', description: 'Return the paginated list of managed API servers.' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size', example: 10 })
  @ApiQuery({ name: 'status', required: false, description: 'Status filter', enum: ['stopped', 'starting', 'running', 'stopping', 'error'] })
  @ApiQuery({ name: 'transport', required: false, description: 'Transport filter', enum: ['streamable', 'sse'] })
  @ApiQuery({ name: 'search', required: false, description: 'Keyword search' })
  @ApiQuery({ name: 'tags', required: false, description: 'Tag filter, comma separated' })
  @ApiResponse({ status: 200, description: 'Servers fetched successfully', type: PaginatedResponseDto })
  async getAllServers(@Query() query: ServerQueryDto): Promise<PaginatedResponseDto<ServerResponseDto>> {
    try {
      return await this.serverManager.getAllServers(query);
    } catch (error) {
      this.logger.error(`Failed to get servers: ${error.message}`, error.stack);
      throw new HttpException(`Failed to get servers: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get server', description: 'Return the detail of a managed API server by id.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server fetched successfully', type: ServerResponseDto })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async getServerById(@Param('id') id: string): Promise<ServerResponseDto> {
    try {
      return await this.serverManager.getServerById(id);
    } catch (error) {
      this.logger.error(`Failed to get server ${id}: ${error.message}`, error.stack);

      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }

      throw new HttpException(`Failed to get server: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/tools')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get server tools', description: 'Resolve the current tool list from OpenAPI or runtime MCP state.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Tools fetched successfully', schema: { type: 'array', items: { type: 'object' } } })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async getServerTools(@Param('id') id: string) {
    try {
      const server = await this.serverManager.getServerById(id);

      try {
        const openApiData = await this.openApiService.getOpenApiByServerId(id);
        if (openApiData) {
          const parseResult = await this.openApiService.parseOpenAPI({
            source: { type: 'content' as any, content: JSON.stringify(openApiData) },
            options: { includeDeprecated: false, requestTimeout: 30000 },
          });

          return {
            success: true,
            data: parseResult.tools || [],
            message: 'Tools retrieved successfully from OpenAPI document',
          };
        }
      } catch (openApiError) {
        this.logger.warn(`Failed to get tools from OpenAPI document: ${openApiError.message}`);
      }

      if (server.status !== 'running') {
        return {
          success: true,
          data: [],
          message: `Server is not running (status: ${server.status}) and no OpenAPI document available`,
        };
      }

      const serverInstance = this.serverManager.getServerInstance(id);
      if (!serverInstance) {
        return {
          success: true,
          data: [],
          message: 'Server instance not found in running instances and no OpenAPI document available',
        };
      }

      if (serverInstance.mcpServer && typeof serverInstance.mcpServer.getTools === 'function') {
        try {
          const tools = serverInstance.mcpServer.getTools();
          return {
            success: true,
            data: tools || [],
            message: 'Tools retrieved successfully from MCP server instance',
          };
        } catch (mcpError) {
          this.logger.warn(`Failed to get tools from MCP server instance: ${mcpError.message}`);
          return {
            success: true,
            data: [],
            message: 'MCP server tools unavailable',
          };
        }
      }

      return {
        success: true,
        data: [],
        message: 'No MCP server instance available for tools retrieval and no OpenAPI document available',
      };
    } catch (error) {
      this.logger.error(`Failed to get server tools ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to get server tools: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Put(':id')
  @RequirePermissions('server:update', 'server:manage')
  @ApiOperation({ summary: 'Update server', description: 'Update the configuration of a managed API server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server updated successfully', type: ServerResponseDto })
  @ApiResponse({ status: 404, description: 'Server not found' })
  @ApiResponse({ status: 409, description: 'Configuration conflict' })
  async updateServer(
    @Param('id') id: string,
    @Body() updateDto: UpdateServerDto,
    @Req() req: Request & { user?: { id?: string } },
  ): Promise<ServerResponseDto> {
    try {
      this.logger.log(`Updating server ${id}`);
      const server = await this.serverManager.updateServer(id, updateDto);
      await this.managementEvents.record({
        action: 'server.update',
        message: `Server ${server.name} updated`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_UPDATED,
        serverId: server.id,
        serverName: server.name,
        serverPort: server.port,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        details: { updatedFields: Object.keys(updateDto ?? {}) },
      });
      return server;
    } catch (error) {
      this.logger.error(`Failed to update server ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'server.update',
        message: `Server ${id} update failed`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_UPDATED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { updatedFields: Object.keys(updateDto ?? {}), error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      if (error.message.includes('conflict') || error.message.includes('already')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      throw new HttpException(`Failed to update server: ${error.message}`, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':id')
  @RequirePermissions('server:delete', 'server:manage')
  @ApiOperation({ summary: 'Delete server', description: 'Delete a managed API server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Server deleted successfully', type: OperationResultDto })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async deleteServer(@Param('id') id: string, @Req() req: Request & { user?: { id?: string } }): Promise<OperationResultDto> {
    try {
      this.logger.log(`Deleting server ${id}`);
      await this.serverManager.deleteServer(id);
      await this.managementEvents.record({
        action: 'server.delete',
        message: `Server ${id} deleted`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_DELETED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
      });
      return { success: true, message: 'Server deleted successfully' };
    } catch (error) {
      this.logger.error(`Failed to delete server ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: 'server.delete',
        message: `Server ${id} deletion failed`,
        source: 'servers-lifecycle-controller',
        eventType: SystemLogEventType.SERVER_DELETED,
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(`Failed to delete server: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/actions')
  @RequirePermissions('server:execute', 'server:manage')
  @ApiOperation({ summary: 'Run server action', description: 'Start, stop, or restart a managed API server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Action completed successfully', type: OperationResultDto })
  @ApiResponse({ status: 404, description: 'Server not found' })
  @ApiResponse({ status: 409, description: 'Action conflict' })
  async performServerAction(
    @Param('id') id: string,
    @Body() actionDto: ServerActionDto,
    @Req() req: Request & { user?: { id?: string } },
  ): Promise<OperationResultDto> {
    try {
      this.logger.log(`Performing server action ${actionDto.action} for ${id}`);
      switch (actionDto.action) {
        case 'start':
          await this.serverManager.startServer(id);
          break;
        case 'stop':
          await this.serverManager.stopServer(id);
          break;
        case 'restart':
          await this.serverManager.restartServer(id);
          break;
        default:
          throw new Error(`Unknown action: ${actionDto.action}`);
      }
      await this.managementEvents.record({
        action: `server.${actionDto.action}`,
        message: `Server ${id} ${actionDto.action} completed`,
        source: 'servers-lifecycle-controller',
        eventType: this.getActionEventType(actionDto.action),
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
      });
      return {
        success: true,
        message: `Server ${actionDto.action} operation completed successfully`,
      };
    } catch (error) {
      this.logger.error(`Failed to ${actionDto.action} server ${id}: ${error.message}`, error.stack);
      await this.managementEvents.record({
        action: `server.${actionDto.action}`,
        message: `Server ${id} ${actionDto.action} failed`,
        source: 'servers-lifecycle-controller',
        eventType: this.getActionEventType(actionDto.action),
        serverId: id,
        actorId: this.getActorId(req),
        requestId: this.getRequestId(req),
        status: SystemLogStatus.FAILED,
        level: SystemLogLevel.ERROR,
        details: { error: error.message },
      });
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      if (error.message.includes('already')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      throw new HttpException(`Failed to ${actionDto.action} server: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('batch/actions')
  @RequirePermissions('server:execute', 'server:manage')
  @ApiOperation({ summary: 'Run batch server action', description: 'Execute start, stop, or restart across multiple managed API servers.' })
  @ApiResponse({ status: 200, description: 'Batch action completed', type: OperationResultDto })
  async performBatchAction(@Body() batchDto: BatchServerActionDto): Promise<OperationResultDto> {
    try {
      this.logger.log(`Performing batch ${batchDto.action} on ${batchDto.serverIds.length} servers`);
      const results = [];
      const errors = [];

      for (const serverId of batchDto.serverIds) {
        try {
          switch (batchDto.action) {
            case 'start':
              await this.serverManager.startServer(serverId);
              break;
            case 'stop':
              await this.serverManager.stopServer(serverId);
              break;
            case 'restart':
              await this.serverManager.restartServer(serverId);
              break;
          }
          results.push({ serverId, success: true });
        } catch (error) {
          errors.push({ serverId, error: error.message });
          if (!batchDto.force) {
            break;
          }
        }
      }

      return {
        success: errors.length === 0,
        message: `Batch ${batchDto.action} completed. Success: ${results.length}, Errors: ${errors.length}`,
        data: { results, errors },
      };
    } catch (error) {
      this.logger.error(`Failed to perform batch action: ${error.message}`, error.stack);
      throw new HttpException(`Failed to perform batch action: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/mcp/connections/stats')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get server MCP connection stats', description: 'Request current MCP connection statistics for a managed server.' })
  @ApiParam({ name: 'id', description: 'Server ID' })
  @ApiResponse({ status: 200, description: 'Stats fetched successfully' })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async getMCPConnectionStats(@Param('id') id: string) {
    try {
      await this.serverManager.getServerById(id);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Request timeout')), 5000);
        this.eventEmitter.once(`mcp.connection.stats.response.${id}`, (stats) => {
          clearTimeout(timeout);
          resolve({ success: true, data: stats, serverId: id });
        });
        this.eventEmitter.emit('mcp.connection.stats.request', { serverId: id });
      });
    } catch (error) {
      this.logger.error(`Failed to get MCP connection stats for server ${id}: ${error.message}`, error.stack);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      if (error.message.includes('timeout')) {
        throw new HttpException('Request timeout', HttpStatus.REQUEST_TIMEOUT);
      }
      throw new HttpException(`Failed to get MCP connection stats: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('mcp/connections/stats')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get all MCP connection stats', description: 'Request current MCP connection statistics for all managed servers.' })
  @ApiResponse({ status: 200, description: 'Stats fetched successfully' })
  async getAllMCPConnectionStats() {
    try {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Request timeout')), 5000);
        this.eventEmitter.once('mcp.connection.stats.response.all', (allStats) => {
          clearTimeout(timeout);
          resolve({ success: true, data: allStats });
        });
        this.eventEmitter.emit('mcp.connection.stats.request.all');
      });
    } catch (error) {
      this.logger.error(`Failed to get all MCP connection stats: ${error.message}`, error.stack);
      if (error.message.includes('timeout')) {
        throw new HttpException('Request timeout', HttpStatus.REQUEST_TIMEOUT);
      }
      throw new HttpException(`Failed to get all MCP connection stats: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private getActorId(req?: Request & { user?: { id?: string } }): string | undefined {
    return req?.user?.id;
  }

  private getRequestId(req?: Request): string | undefined {
    return req?.headers?.['x-request-id']?.toString();
  }

  private getActionEventType(action: ServerActionDto['action']): SystemLogEventType {
    switch (action) {
      case 'start':
        return SystemLogEventType.SERVER_STARTED;
      case 'stop':
        return SystemLogEventType.SERVER_STOPPED;
      case 'restart':
        return SystemLogEventType.SERVER_RESTARTED;
      default:
        return SystemLogEventType.SERVER_CONFIG_CHANGED;
    }
  }
}
