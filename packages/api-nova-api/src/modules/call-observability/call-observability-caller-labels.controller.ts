import { Body, Controller, Headers, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityCallerLabelsService } from './call-observability-caller-labels.service';
import { OBSERVABILITY_CALLER_PATCH_SCHEMA, ObservabilityCallerMutationEnvelopeDto } from './call-observability-visitors.dto';

@ApiTags('Call observability')
@ObservabilityAccess('monitoring:manage')
@Controller('monitoring/observability')
export class CallObservabilityCallerLabelsController {
  constructor(private readonly labels: CallObservabilityCallerLabelsService) {}

  @Patch('callers/:id')
  @ApiOperation({ operationId: 'obsUpdateCallerLabels', summary: 'Update a fully authorized caller profile and management audit atomically' })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'If-Match', required: true, description: 'One strong edit token from data.profileEtag or X-Profile-ETag; never use the full-response ETag.' })
  @ApiBody({ schema: OBSERVABILITY_CALLER_PATCH_SCHEMA })
  @ApiResponse({ status: 200, type: ObservabilityCallerMutationEnvelopeDto,
    headers: { 'X-Profile-ETag': { schema: { type: 'string' }, description: 'Current caller profile edit token; independent of the full response.' } } })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 412, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 428, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  async update(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('if-match') ifMatch: unknown, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.labels.update(id, body, query, ifMatch,
      getObservabilityAuthorization(request).principalId, request[OBSERVABILITY_REQUEST_ID]);
    response.setHeader('X-Profile-ETag', result.data.profileEtag);
    return result;
  }
}
