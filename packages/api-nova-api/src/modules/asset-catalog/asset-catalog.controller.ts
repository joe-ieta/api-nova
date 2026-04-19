import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
  AssetCatalogQueryDto,
  ExecuteEndpointDefinitionTestDto,
  EndpointCatalogQueryDto,
  RegisterManualEndpointAssetDto,
  UpdateEndpointDefinitionGovernanceDto,
  UpdateManualEndpointAssetDto,
} from './dto/asset-catalog.dto';
import { AssetCatalogService } from './services/asset-catalog.service';

@ApiTags('Asset Catalog')
@Controller('v1/assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class AssetCatalogController {
  constructor(private readonly assetCatalogService: AssetCatalogService) {}

  @Get('source-services')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List source service assets' })
  @ApiResponse({ status: 200, description: 'Source service assets fetched successfully' })
  async listSourceServiceAssets(@Query() query: AssetCatalogQueryDto) {
    return this.assetCatalogService.listSourceServiceAssets(query);
  }

  @Get('source-services/:id')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get source service asset detail' })
  async getSourceServiceAsset(@Param('id') id: string) {
    return this.assetCatalogService.getSourceServiceAssetDetail(id);
  }

  @Get('endpoints')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List endpoint definitions' })
  async listEndpointDefinitions(@Query() query: EndpointCatalogQueryDto) {
    return this.assetCatalogService.listEndpointDefinitions(query);
  }

  @Get('endpoints/:id')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get endpoint definition detail' })
  async getEndpointDefinition(@Param('id') id: string) {
    return this.assetCatalogService.getEndpointDefinitionDetail(id);
  }

  @Post('endpoints/:id/probe')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Probe endpoint definition' })
  async probeEndpointDefinition(@Param('id') id: string) {
    return this.assetCatalogService.probeEndpointDefinition(id);
  }

  @Get('endpoints/:id/readiness')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get endpoint definition readiness' })
  async getEndpointDefinitionReadiness(@Param('id') id: string) {
    return this.assetCatalogService.getEndpointDefinitionReadiness(id);
  }

  @Get('endpoints/:id/testing-state')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get endpoint definition testing state' })
  async getEndpointDefinitionTestingState(@Param('id') id: string) {
    return this.assetCatalogService.getEndpointDefinitionTestingState(id);
  }

  @Post('endpoints/:id/test')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Execute endpoint definition functional test' })
  async executeEndpointDefinitionTest(
    @Param('id') id: string,
    @Body() body: ExecuteEndpointDefinitionTestDto,
  ) {
    return this.assetCatalogService.executeEndpointDefinitionTest(id, body);
  }

  @Post('endpoints/manual')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Register manual endpoint asset' })
  async registerManualEndpointAsset(@Body() body: RegisterManualEndpointAssetDto) {
    return this.assetCatalogService.registerManualEndpointAssetRecord(body);
  }

  @Patch('endpoints/:id/manual')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Update manual endpoint asset' })
  async updateManualEndpointAsset(
    @Param('id') id: string,
    @Body() body: UpdateManualEndpointAssetDto,
  ) {
    return this.assetCatalogService.updateManualEndpointAssetRecord(id, body);
  }

  @Delete('endpoints/:id/manual')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete manual endpoint asset' })
  async deleteManualEndpointAsset(@Param('id') id: string) {
    return this.assetCatalogService.deleteManualEndpointAssetRecord(id);
  }

  @Patch('endpoints/:id/governance')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Update endpoint definition governance' })
  async updateEndpointDefinitionGovernance(
    @Param('id') id: string,
    @Body() body: UpdateEndpointDefinitionGovernanceDto,
  ) {
    return this.assetCatalogService.updateEndpointDefinitionGovernance(id, body);
  }
}
