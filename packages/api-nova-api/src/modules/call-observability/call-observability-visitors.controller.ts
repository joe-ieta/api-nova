import { applyDecorators, Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { authorizeObservability, ObservabilityAuthorization } from './call-observability-access';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityApiError, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityVisitorsService, CALLER_QUERY_KEYS, SOURCE_QUERY_KEYS, CALLER_DETAIL_QUERY_KEYS }
  from './call-observability-visitors.service';
import { ObservabilityCallerListEnvelopeDto, ObservabilityCallerEnvelopeDto, ObservabilitySourceListEnvelopeDto }
  from './call-observability-visitors.dto';

function queries(keys: readonly string[]) {
  const enums: Record<string, string[]> = { origin: ['external'], timeBasis: ['startedAt', 'completedAt'],
    serverType: ['gateway', 'mcp'], authState: ['authenticated', 'anonymous', 'authentication_failed', 'unknown'] };
  return applyDecorators(...keys.map(name => ApiQuery({ name, required: false,
    schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      : name === 'includeTotal' ? { type: 'boolean', default: false }
      : { type: 'string', ...(enums[name] ? { enum: enums[name] } : {}),
        ...(['from', 'to'].includes(name) ? { format: 'date-time' } : {}),
        ...(name === 'origin' ? { default: 'external' } : {}),
        ...(name === 'timeBasis' ? { default: 'startedAt' } : {}) } })));
}

@ApiTags('Call observability')
@ObservabilityAccess()
@ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
@ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
@Controller('monitoring/observability')
export class CallObservabilityVisitorsController {
  constructor(private readonly visitors: CallObservabilityVisitorsService) {}

  @Get('callers')
  @ApiOperation({ operationId: 'obsListCallers', summary: 'List authenticated callers observed in an authorized call snapshot' })
  @queries(CALLER_QUERY_KEYS)
  @ApiResponse({ status: 200, type: ObservabilityCallerListEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  async callers(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.visitors.callers(query, getObservabilityAuthorization(request));
  }

  @Get('callers/:id')
  @ApiOperation({ operationId: 'obsGetCaller', summary: 'Read caller profile and scoped retained observations' })
  @ApiParam({ name: 'id', type: String })
  @queries(CALLER_DETAIL_QUERY_KEYS)
  @ApiResponse({ status: 200, type: ObservabilityCallerEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  async caller(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() request: any) {
    return this.visitors.caller(id, query, getObservabilityAuthorization(request));
  }

  @Get('sources')
  @ApiOperation({ operationId: 'obsListSources', summary: 'List daily access-source observations, with separately authorized IP fields' })
  @queries(SOURCE_QUERY_KEYS)
  @ApiResponse({ status: 200, type: ObservabilitySourceListEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  async sources(@Query() query: Record<string, unknown>, @Req() request: any) {
    let source: ObservabilityAuthorization | undefined;
    try { source = authorizeObservability(request.user, ['monitoring:source:read']); }
    catch (error) {
      if (!(error instanceof ObservabilityApiError) || error.code !== 'FORBIDDEN') throw error;
    }
    return this.visitors.sources(query, getObservabilityAuthorization(request), source);
  }
}
