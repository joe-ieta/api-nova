import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { User } from '../../database/entities/user.entity';
import { CurrentUser } from '../security/decorators/current-user.decorator';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import {
  CreateGatewayConsumerCredentialDto,
  DeployRuntimeAssetMcpDto,
  DeployRuntimeAssetGatewayDto,
  GatewayConsumerCredentialQueryDto,
  RevokeGatewayConsumerCredentialDto,
  RuntimeAssetAssemblyQueryDto,
  RuntimeAssetQueryDto,
  UpdateRuntimeAssetPolicyDto,
} from './dto/runtime-assets.dto';
import { RuntimeAssetsService } from './services/runtime-assets.service';
import { OperationResultDto } from '../servers/dto/server.dto';

@ApiTags('Runtime Assets')
@Controller('v1/runtime-assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class RuntimeAssetsController {
  constructor(private readonly runtimeAssetsService: RuntimeAssetsService) {}

  @Get()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List runtime assets' })
  async listRuntimeAssets(@Query() query: RuntimeAssetQueryDto) {
    return this.runtimeAssetsService.listRuntimeAssets(query);
  }

  @Get(':id')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get runtime asset detail' })
  async getRuntimeAssetDetail(@Param('id') id: string) {
    return this.runtimeAssetsService.getRuntimeAssetDetail(id);
  }

  @Get(':id/memberships')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List runtime asset memberships' })
  async listRuntimeAssetMemberships(@Param('id') id: string) {
    return this.runtimeAssetsService.listRuntimeAssetMemberships(id);
  }

  @Get(':id/mcp-assembly')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Assemble MCP payload for one runtime asset' })
  async getMcpAssembly(@Param('id') id: string) {
    return this.runtimeAssetsService.assembleMcpRuntimeAssetPayload(id);
  }

  @Get(':id/gateway-assembly')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Assemble gateway payload for one runtime asset' })
  async getGatewayAssembly(
    @Param('id') id: string,
    @Query() query: RuntimeAssetAssemblyQueryDto,
  ) {
    return this.runtimeAssetsService.assembleGatewayRuntimeAssetPayload(
      id,
      query.publishedOnly ?? true,
    );
  }

  @Get(':id/observability')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'Get runtime asset observability summary' })
  async getRuntimeAssetObservability(@Param('id') id: string) {
    return this.runtimeAssetsService.getRuntimeAssetObservability(id);
  }

  @Get(':id/access-logs')
  @RequirePermissions('monitoring:read')
  @ApiOperation({ summary: 'List gateway access logs for one runtime asset' })
  async listRuntimeAssetAccessLogs(
    @Param('id') id: string,
    @Query('limit') limit?: number,
  ) {
    return this.runtimeAssetsService.listRuntimeAssetAccessLogs(
      id,
      limit ? Number(limit) : 20,
    );
  }

  @Get(':id/gateway-consumer-credentials')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List gateway consumer credentials for one runtime asset' })
  async listGatewayConsumerCredentials(
    @Param('id') id: string,
    @Query() query: GatewayConsumerCredentialQueryDto,
  ) {
    return this.runtimeAssetsService.listGatewayConsumerCredentials(id, query);
  }

  @Post(':id/gateway-consumer-credentials')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Create one gateway consumer credential scoped to this runtime asset' })
  async createGatewayConsumerCredential(
    @Param('id') id: string,
    @Body() body: CreateGatewayConsumerCredentialDto,
    @CurrentUser() currentUser: User,
    @Req() req: Request,
  ) {
    return this.runtimeAssetsService.createGatewayConsumerCredential(id, body, {
      actorId: currentUser?.id,
      ipAddress: this.getClientIp(req),
      userAgent: this.getUserAgent(req),
    });
  }

  @Post(':id/gateway-consumer-credentials/:credentialId/revoke')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Revoke one gateway consumer credential' })
  async revokeGatewayConsumerCredential(
    @Param('id') id: string,
    @Param('credentialId') credentialId: string,
    @Body() body: RevokeGatewayConsumerCredentialDto,
    @CurrentUser() currentUser: User,
    @Req() req: Request,
  ) {
    return this.runtimeAssetsService.revokeGatewayConsumerCredential(id, credentialId, body, {
      actorId: currentUser?.id,
      ipAddress: this.getClientIp(req),
      userAgent: this.getUserAgent(req),
    });
  }

  @Post(':id/deploy-mcp')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Deploy MCP runtime asset into one managed server record' })
  async deployMcpRuntimeAsset(
    @Param('id') id: string,
    @Body() body: DeployRuntimeAssetMcpDto,
  ) {
    return this.runtimeAssetsService.deployMcpRuntimeAsset(id, body);
  }

  @Post(':id/deploy-gateway')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Assemble and deploy one gateway runtime asset into active gateway config' })
  async deployGatewayRuntimeAsset(
    @Param('id') id: string,
    @Body() body: DeployRuntimeAssetGatewayDto,
  ) {
    return this.runtimeAssetsService.deployGatewayRuntimeAsset(id, body);
  }

  @Put(':id/policy-binding')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Update top-level runtime asset policy binding reference' })
  async updateRuntimeAssetPolicyBinding(
    @Param('id') id: string,
    @Body() body: UpdateRuntimeAssetPolicyDto,
  ) {
    return this.runtimeAssetsService.updateRuntimeAssetPolicyBinding(id, body);
  }

  @Post(':id/start')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Start managed MCP server bound to this runtime asset' })
  async startRuntimeAsset(@Param('id') id: string) {
    return this.runtimeAssetsService.startRuntimeAsset(id);
  }

  @Post(':id/stop')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Stop managed MCP server bound to this runtime asset' })
  async stopRuntimeAsset(@Param('id') id: string) {
    return this.runtimeAssetsService.stopRuntimeAsset(id);
  }

  @Post(':id/redeploy')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Re-assemble and redeploy one MCP runtime asset' })
  async redeployRuntimeAsset(
    @Param('id') id: string,
    @Body() body: DeployRuntimeAssetMcpDto,
  ) {
    return this.runtimeAssetsService.redeployRuntimeAsset(id, body);
  }

  @Delete(':id')
  @RequirePermissions('server:delete', 'server:manage')
  @ApiOperation({ summary: 'Delete runtime asset and its derived deployment records' })
  async deleteRuntimeAsset(@Param('id') id: string): Promise<OperationResultDto> {
    await this.runtimeAssetsService.deleteRuntimeAsset(id);
    return {
      success: true,
      message: 'Runtime asset deleted successfully',
    };
  }

  private getClientIp(req: Request) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor)) {
      return forwardedFor[0];
    }
    return forwardedFor || req.ip || req.socket?.remoteAddress;
  }

  private getUserAgent(req: Request) {
    const userAgent = req.headers['user-agent'];
    return Array.isArray(userAgent) ? userAgent[0] : userAgent;
  }
}
