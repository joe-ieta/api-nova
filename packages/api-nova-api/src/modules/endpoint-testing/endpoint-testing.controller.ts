import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
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

  @Get('test-samples/:sampleId/binary-content')
  @RequirePermissions('server:manage')
  @ApiProduces('application/octet-stream')
  @ApiOperation({ summary: 'Download a stored binary response sample' })
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async readBinaryContent(
    @Param('sampleId') sampleId: string,
    @Headers('range') range?: string,
  ) {
    if (range !== undefined) throw new BadRequestException('Range is not supported');
    const bytes = await this.endpointTestingService.readBinaryContent(sampleId);
    return new StreamableFile(bytes, {
      type: 'application/octet-stream',
      disposition: 'attachment; filename="endpoint-test-sample.bin"',
      length: bytes.length,
    });
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
  @ApiOperation({ summary: 'Delete ordinary expired samples and mark binary objects pending removal' })
  cleanupExpiredSamples() {
    return this.endpointTestingService.cleanupExpiredSamples();
  }

  @Post('test-samples/binary-objects/cleanup')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Explicitly reclaim revoked and abandoned staged binary objects in a bounded pass' })
  cleanupPendingBinaryObjects() {
    return this.endpointTestingService.cleanupPendingBinaryObjects();
  }

  @Delete('test-samples/:sampleId')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete an ordinary sample or revoke a binary sample pending object removal' })
  deleteTestSample(@Param('sampleId') sampleId: string) {
    return this.endpointTestingService.deleteTestSample(sampleId);
  }
}
