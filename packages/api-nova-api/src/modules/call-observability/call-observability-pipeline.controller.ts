import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ObservabilityAccess, getObservabilityAuthorization } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { ObservabilityPipelineStatusEnvelopeDto } from './call-observability-pipeline.dto';
import { CallObservabilityPipelineService } from './call-observability-pipeline.service';

@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityPipelineController {
  constructor(private readonly pipeline: CallObservabilityPipelineService) {}
  @Get('pipeline/status')
  @ApiOperation({ operationId: 'obsGetPipelineStatus',
    summary: 'Read persisted pipeline evidence; monitoring:read with explicit global resource scope required' })
  @ApiResponse({ status: 200, type: ObservabilityPipelineStatusEnvelopeDto })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  async get(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.pipeline.get(query, getObservabilityAuthorization(request));
  }
}
