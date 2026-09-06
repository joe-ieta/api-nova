import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import {
  CreateEndpointTestCaseDto,
  EndpointTestRunQueryDto,
  EndpointTestSampleQueryDto,
  UpdateEndpointTestCaseDto,
  UpdateEndpointTestSampleDto,
} from './dto/endpoint-testing.dto';
import { EndpointTestingService } from './services/endpoint-testing.service';

@ApiTags('Endpoint Testing')
@Controller('v1/endpoint-testing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class EndpointTestingController {
  constructor(private readonly endpointTestingService: EndpointTestingService) {}

  @Get('endpoints/:endpointDefinitionId/test-cases')
  @SkipThrottle()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List endpoint test cases' })
  listTestCases(@Param('endpointDefinitionId') endpointDefinitionId: string) {
    return this.endpointTestingService.listTestCases(endpointDefinitionId);
  }

  @Post('endpoints/:endpointDefinitionId/test-cases')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Create endpoint test case' })
  createTestCase(
    @Param('endpointDefinitionId') endpointDefinitionId: string,
    @Body() body: CreateEndpointTestCaseDto,
  ) {
    return this.endpointTestingService.createTestCase(endpointDefinitionId, body);
  }

  @Patch('test-cases/:testCaseId')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Update endpoint test case' })
  updateTestCase(
    @Param('testCaseId') testCaseId: string,
    @Body() body: UpdateEndpointTestCaseDto,
  ) {
    return this.endpointTestingService.updateTestCase(testCaseId, body);
  }

  @Delete('test-cases/:testCaseId')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete endpoint test case' })
  deleteTestCase(@Param('testCaseId') testCaseId: string) {
    return this.endpointTestingService.deleteTestCase(testCaseId);
  }

  @Get('endpoints/:endpointDefinitionId/test-runs')
  @SkipThrottle()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List endpoint test runs' })
  listTestRuns(
    @Param('endpointDefinitionId') endpointDefinitionId: string,
    @Query() query: EndpointTestRunQueryDto,
  ) {
    return this.endpointTestingService.listTestRuns(endpointDefinitionId, query);
  }

  @Get('endpoints/:endpointDefinitionId/test-samples')
  @SkipThrottle()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List automatically captured endpoint test samples' })
  listTestSamples(
    @Param('endpointDefinitionId') endpointDefinitionId: string,
    @Query() query: EndpointTestSampleQueryDto,
  ) {
    return this.endpointTestingService.listTestSamples(endpointDefinitionId, query);
  }

  @Patch('test-samples/:sampleId')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Maintain an automatically captured test sample' })
  updateTestSample(
    @Param('sampleId') sampleId: string,
    @Body() body: UpdateEndpointTestSampleDto,
  ) {
    return this.endpointTestingService.updateTestSample(sampleId, body);
  }

  @Post('test-samples/:sampleId/archive')
  @RequirePermissions('server:update')
  @ApiOperation({ summary: 'Archive an endpoint test sample' })
  archiveTestSample(@Param('sampleId') sampleId: string) {
    return this.endpointTestingService.archiveTestSample(sampleId);
  }

  @Post('test-samples/cleanup')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete archived endpoint samples past the retention window' })
  cleanupExpiredSamples() {
    return this.endpointTestingService.cleanupExpiredSamples();
  }

  @Delete('test-samples/:sampleId')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete an endpoint test sample' })
  deleteTestSample(@Param('sampleId') sampleId: string) {
    return this.endpointTestingService.deleteTestSample(sampleId);
  }
}
