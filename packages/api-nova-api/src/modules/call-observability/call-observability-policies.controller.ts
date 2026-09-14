import { applyDecorators, Body, Controller, Get, Headers, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityPoliciesService } from './call-observability-policies.service';
import { OBSERVABILITY_POLICY_PATCH_SCHEMA, ObservabilityPolicyListEnvelopeDto,
  ObservabilityPolicyMutationEnvelopeDto } from './call-observability-policies.dto';

@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityPoliciesController {
  constructor(private readonly policies: CallObservabilityPoliciesService) {}

  @Get('policies')
  @ApiOperation({ operationId: 'obsGetPolicies', summary: 'Read the effective global policy for new observability events and payloads' })
  @ApiResponse({ status: 200, type: ObservabilityPolicyListEnvelopeDto })
  @applyDecorators(...[400, 401, 403, 503].map(status => ApiResponse({ status, type: ObservabilityErrorEnvelopeDto })))
  list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.policies.list(query, getObservabilityAuthorization(request));
  }

  @Patch('policies/:id')
  @ObservabilityAccess('monitoring:manage')
  @ApiOperation({ operationId: 'obsUpdatePolicy', summary: 'Atomically update new-event and payload retention with audit; global management scope required' })
  @ApiParam({ name: 'id', type: String, example: 'global-event-retention' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Strong edit token from policyEtag; distinct from response ETag.' })
  @ApiBody({ schema: OBSERVABILITY_POLICY_PATCH_SCHEMA })
  @ApiResponse({ status: 200, type: ObservabilityPolicyMutationEnvelopeDto,
    headers: { 'X-Policy-ETag': { schema: { type: 'string' } } } })
  @applyDecorators(...[400, 401, 403, 404, 412, 428, 503].map(status => ApiResponse({ status, type: ObservabilityErrorEnvelopeDto })))
  async update(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('if-match') ifMatch: unknown, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.policies.update(id, body, query, ifMatch,
      getObservabilityAuthorization(request).principalId, request[OBSERVABILITY_REQUEST_ID]);
    response.setHeader('X-Policy-ETag', result.data.policyEtag);
    return result;
  }
}
