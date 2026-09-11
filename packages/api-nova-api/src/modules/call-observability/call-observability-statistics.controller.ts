import { applyDecorators, Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityStatisticsService, STATISTICS_SCOPES, STATISTICS_SUMMARY_QUERY_KEYS,
  STATISTICS_TIME_SERIES_QUERY_KEYS, STATISTICS_GROUPS_QUERY_KEYS, STATISTICS_INTERVALS,
  STATISTICS_GROUP_ORDER_BY, MAX_STATISTICS_GROUP_LIMIT } from './call-observability-statistics.service';
import { ObservabilityStatisticsSummaryEnvelopeDto, ObservabilityStatisticsTimeSeriesEnvelopeDto,
  ObservabilityStatisticsGroupsEnvelopeDto } from './call-observability-statistics.dto';

const ENUMS: Record<string, readonly string[]> = { scope: STATISTICS_SCOPES,
  origin: ['external', 'test', 'probe', 'internal'], timeBasis: ['startedAt', 'completedAt'],
  serverType: ['gateway', 'mcp'], spanKind: ['gateway_request', 'mcp_protocol', 'mcp_tool', 'upstream_api'],
  outcome: ['success', 'error', 'rejected', 'timeout', 'cancelled', 'incomplete', 'unknown'],
  interval: Object.keys(STATISTICS_INTERVALS), fill: ['none', 'zero'], orderBy: STATISTICS_GROUP_ORDER_BY };
function queries(keys: readonly string[] = STATISTICS_SUMMARY_QUERY_KEYS, required = ['scope']) {
  return applyDecorators(...keys.map(name => ApiQuery({
    name, required: required.includes(name), schema: name === 'top' ?
      { type: 'integer', minimum: 1, maximum: MAX_STATISTICS_GROUP_LIMIT, default: 20 } :
      { type: 'string', ...(ENUMS[name] ? { enum: [...ENUMS[name]] } : {}),
        ...(['from', 'to'].includes(name) ? { format: 'date-time' } : {}),
        ...(name === 'origin' ? { default: 'external' } : {}),
        ...(name === 'timeBasis' ? { default: 'startedAt' } : {}),
        ...(name === 'fill' ? { default: 'none' } : {}),
        ...(name === 'orderBy' ? { default: 'selectedInvocations' } : {}) },
  })));
}
function errors() {
  return applyDecorators(...[400, 401, 403, 413, 503].map(status =>
    ApiResponse({ status, type: ObservabilityErrorEnvelopeDto })));
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
  @errors()
  summary(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.statistics.summary(query, getObservabilityAuthorization(request));
  }

  @Get('statistics/time-series')
  @ApiOperation({ operationId: 'obsGetStatisticsTimeSeries',
    summary: 'Return UTC-aligned on-demand buckets from one authorized retained-invocation snapshot' })
  @queries(STATISTICS_TIME_SERIES_QUERY_KEYS, ['scope', 'interval'])
  @ApiResponse({ status: 200, type: ObservabilityStatisticsTimeSeriesEnvelopeDto })
  @errors()
  timeSeries(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.statistics.timeSeries(query, getObservabilityAuthorization(request));
  }

  @Get('statistics/groups')
  @ApiOperation({ operationId: 'obsGetStatisticsGroups',
    summary: 'Rank one or two whitelisted dimensions without summing distinct counts across groups' })
  @queries(STATISTICS_GROUPS_QUERY_KEYS, ['scope', 'groupBy'])
  @ApiResponse({ status: 200, type: ObservabilityStatisticsGroupsEnvelopeDto })
  @errors()
  groups(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.statistics.groups(query, getObservabilityAuthorization(request));
  }
}
