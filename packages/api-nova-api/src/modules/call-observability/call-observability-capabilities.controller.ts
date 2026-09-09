import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityCapabilitiesService } from './call-observability-capabilities.service';
import { ObservabilityCapabilitiesEnvelopeDto } from './call-observability-capabilities.dto';

@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityCapabilitiesController {
  constructor(private readonly capabilities: CallObservabilityCapabilitiesService) {}

  @Get('capabilities')
  @ApiOperation({ operationId: 'obsGetCapabilities', summary: 'Describe implemented, scope-eligible observability APIs without inventing health or historical coverage' })
  @ApiResponse({ status: 200, type: ObservabilityCapabilitiesEnvelopeDto })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  async get(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.capabilities.get(query, request.user);
  }
}
