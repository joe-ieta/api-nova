import { applyDecorators, Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { authorizeObservability, ObservabilityAuthorization } from './call-observability-access';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityApiError, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityInvocationsService, INVOCATION_QUERY_KEYS } from './call-observability-invocations.service';
import { ObservabilityInvocationEnvelopeDto, ObservabilityInvocationListEnvelopeDto,
  ObservabilityTraceEnvelopeDto } from './call-observability-invocations.dto';

const ENUMS: Record<string, string[]> = {
  timeBasis: ['startedAt', 'completedAt'], origin: ['external', 'test', 'probe', 'internal'],
  serverType: ['gateway', 'mcp'], spanKind: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcome: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
};
function listQueries() {
  return applyDecorators(...INVOCATION_QUERY_KEYS.map(name => ApiQuery({
    name, required: false, schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      : name === 'includeTotal' ? { type: 'boolean', default: false }
      : { type: 'string', ...(ENUMS[name] ? { enum: ENUMS[name] } : {}),
        ...(['from', 'to'].includes(name) ? { format: 'date-time' } : {}),
        ...(name === 'timeBasis' ? { default: 'startedAt' } : {}),
        ...(name === 'origin' ? { default: 'external' } : {}) },
  })));
}

@ApiTags('Call observability')
@ObservabilityAccess()
@ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
@Controller('monitoring/observability')
export class CallObservabilityInvocationsController {
  constructor(private readonly invocations: CallObservabilityInvocationsService) {}

  @Get('invocations')
  @ApiOperation({ operationId: 'obsListInvocations', summary: 'List authorized invocation metadata at a stable snapshot' })
  @listQueries()
  @ApiResponse({ status: 200, type: ObservabilityInvocationListEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
  async list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.invocations.list(query, getObservabilityAuthorization(request), this.sourceScope(request));
  }

  @Get('invocations/:id')
  @ApiOperation({ operationId: 'obsGetInvocation', summary: 'Read the latest authorized invocation metadata' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'timeBasis', required: false, enum: ['startedAt', 'completedAt'] })
  @ApiResponse({ status: 200, type: ObservabilityInvocationEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  async get(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() request: any) {
    return this.invocations.get(id, query, getObservabilityAuthorization(request), this.sourceScope(request));
  }

  @Get('traces/:traceId')
  @ApiOperation({ operationId: 'obsGetTrace', summary: 'Read up to 200 retained, authorized trace nodes without silent truncation' })
  @ApiParam({ name: 'traceId', type: String })
  @ApiQuery({ name: 'origin', required: false, schema: {
    type: 'string', enum: ['external', 'test', 'probe', 'internal'], default: 'external',
  } })
  @ApiResponse({ status: 200, type: ObservabilityTraceEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
  async trace(@Param('traceId') traceId: string, @Query() query: Record<string, unknown>, @Req() request: any) {
    return this.invocations.trace(traceId, query, getObservabilityAuthorization(request), this.sourceScope(request));
  }

  private sourceScope(request: any): ObservabilityAuthorization | undefined {
    try { return authorizeObservability(request.user, ['monitoring:source:read']); }
    catch (error) {
      if (error instanceof ObservabilityApiError && error.code === 'FORBIDDEN') return undefined;
      throw error;
    }
  }
}
