import { applyDecorators, Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityStatisticsService, STATISTICS_SCOPES, STATISTICS_SUMMARY_QUERY_KEYS } from './call-observability-statistics.service';
import { ObservabilityStatisticsSummaryEnvelopeDto } from './call-observability-statistics.dto';

const ENUMS: Record<string, readonly string[]> = { scope: STATISTICS_SCOPES,
  origin: ['external', 'test', 'probe', 'internal'], timeBasis: ['startedAt', 'completedAt'],
  serverType: ['gateway', 'mcp'], spanKind: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcome: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'] };
function queries() {
  return applyDecorators(...STATISTICS_SUMMARY_QUERY_KEYS.map(name => ApiQuery({
    name, required: name === 'scope', schema: { type: 'string', ...(ENUMS[name] ? { enum: [...ENUMS[name]] } : {}),
      ...(['from', 'to'].includes(name) ? { format: 'date-time' } : {}),
      ...(name === 'origin' ? { default: 'external' } : {}),
      ...(name === 'timeBasis' ? { default: 'startedAt' } : {}) },
  })));
}
@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityStatisticsController {
  constructor(private readonly statistics: CallObservabilityStatisticsService) {}

  @Get('statistics/summary')
  @ApiOperation({ operationId: 'obsGetStatisticsSummary',
    summary: 'Summarize up to 5000 authorized retained invocations without fabricating historical coverage or liveness' })
  @queries()
  @ApiResponse({ status: 200, type: ObservabilityStatisticsSummaryEnvelopeDto })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  summary(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.statistics.summary(query, getObservabilityAuthorization(request));
  }
}
