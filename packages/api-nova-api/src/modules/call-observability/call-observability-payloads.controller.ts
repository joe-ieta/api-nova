import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto, OBSERVABILITY_REQUEST_ID } from './call-observability-api.contract';
import { CallObservabilityPayloadsService } from './call-observability-payloads.service';
import { ObservabilityPayloadEnvelopeDto } from './call-observability-payloads.dto';

@ApiTags('Call observability')
@ObservabilityAccess('monitoring:payload:read')
@Controller('monitoring/observability')
export class CallObservabilityPayloadsController {
  constructor(private readonly payloads: CallObservabilityPayloadsService) {}

  @Get('invocations/:id/payloads/:side')
  @ApiOperation({ operationId: 'obsGetInvocationPayload',
    summary: 'Read an authorized request or response body with mandatory management audit' })
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'side', enum: ['request', 'response'] })
  @ApiResponse({ status: 200, type: ObservabilityPayloadEnvelopeDto })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 429, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  get(@Param('id') id: string, @Param('side') side: string,
    @Query() query: Record<string, unknown>, @Req() request: any) {
    return this.payloads.get(id, side, query, getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
  }
}
