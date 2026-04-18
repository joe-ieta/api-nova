import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
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
  EndpointCatalogQueryDto,
  UpdateEndpointDefinitionGovernanceDto,
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
