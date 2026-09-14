import { applyDecorators, Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ObservabilityAccess, getObservabilityAuthorization } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { OBSERVABILITY_OVERVIEW_QUERY_KEYS } from './call-observability-overview-query';
import { CallObservabilityOverviewService } from './call-observability-overview.service';
import { ObservabilityOverviewEnvelopeDto } from './call-observability-overview.dto';
function queries() {
  return applyDecorators(...OBSERVABILITY_OVERVIEW_QUERY_KEYS.map(name => ApiQuery({ name, required: false,
    description: name === 'from' || name === 'to' ? 'Paired UTC bounds, at most 30 days; default last hour. Selection uses startedAt.' :
      name === 'runtimeAssetId' ? 'Intersected with current asset permissions.' : undefined,
    schema: { type: 'string', ...(['from', 'to'].includes(name) ? { format: 'date-time' } : {}),
      ...(name === 'origin' ? { enum: ['external', 'test', 'probe', 'internal'], default: 'external' } : {}),
      ...(name === 'serverType' ? { enum: ['gateway', 'mcp'] } : {}) } })));
}
function errors() {
  return applyDecorators(...[400, 401, 403, 413, 503].map(status =>
    ApiResponse({ status, type: ObservabilityErrorEnvelopeDto })));
}
@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityOverviewController {
  constructor(private readonly service: CallObservabilityOverviewService) {}
  @Get('overview')
  @ApiOperation({ operationId: 'obsGetOverview', summary: 'Authorized business/upstream snapshot and persisted server state; pipeline and recentEvents are unavailable.' })
  @queries()
  @ApiResponse({ status: 200, type: ObservabilityOverviewEnvelopeDto })
  @errors()
  get(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.service.get(query, getObservabilityAuthorization(request));
  }
}
