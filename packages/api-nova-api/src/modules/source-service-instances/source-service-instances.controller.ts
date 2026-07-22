import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import {
  CreateSourceServiceInstanceDto,
  ProbeSourceServiceInstanceDto,
  SourceServiceInstanceQueryDto,
  UpdateSourceServiceInstanceDto,
} from './dto/source-service-instances.dto';
import { SourceServiceInstancesService } from './services/source-service-instances.service';

@ApiTags('Source Service Instances')
@Controller('v1/assets/source-services/:sourceServiceAssetId/instances')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class SourceServiceInstancesController {
  constructor(private readonly sourceServiceInstancesService: SourceServiceInstancesService) {}

  @Get()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List runtime instances owned by one source service asset' })
  list(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Query() query: SourceServiceInstanceQueryDto,
  ) {
    return this.sourceServiceInstancesService.list(sourceServiceAssetId, query);
  }

  @Post()
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Create a runtime instance for one source service asset' })
  create(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Body() body: CreateSourceServiceInstanceDto,
  ) {
    return this.sourceServiceInstancesService.create(sourceServiceAssetId, body);
  }

  @Get(':instanceId')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get one source service runtime instance' })
  get(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.sourceServiceInstancesService.get(sourceServiceAssetId, instanceId);
  }

  @Patch(':instanceId')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Update one source service runtime instance' })
  update(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: UpdateSourceServiceInstanceDto,
  ) {
    return this.sourceServiceInstancesService.update(sourceServiceAssetId, instanceId, body);
  }

  @Post(':instanceId/probe')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Probe one source service runtime instance' })
  probe(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: ProbeSourceServiceInstanceDto,
  ) {
    return this.sourceServiceInstancesService.probe(sourceServiceAssetId, instanceId, body);
  }

  @Post(':instanceId/set-default')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Set the environment default runtime instance' })
  setDefault(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.sourceServiceInstancesService.setDefault(sourceServiceAssetId, instanceId);
  }

  @Post(':instanceId/archive')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Archive one source service runtime instance' })
  archive(
    @Param('sourceServiceAssetId') sourceServiceAssetId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.sourceServiceInstancesService.archive(sourceServiceAssetId, instanceId);
  }
}
