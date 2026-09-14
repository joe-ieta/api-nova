import { applyDecorators, Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ObservabilityAccess, getObservabilityAuthorization } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { OBSERVABILITY_OVERVIEW_QUERY_KEYS } from './call-observability-overview-query';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { ObservabilityServerStatusesEnvelopeDto } from './call-observability-server-status.dto';
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
export class CallObservabilityServerStatusController {
  constructor(private readonly service: CallObservabilityServerStatusService) {}
  @Get('servers/status')
  @ApiOperation({ operationId: 'obsGetServerStatuses', summary: 'Persisted authorized asset lifecycle and historical reports; live health, heartbeat and stateVersion remain unknown.' })
  @queries()
  @ApiResponse({ status: 200, type: ObservabilityServerStatusesEnvelopeDto })
  @errors()
  list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.service.list(query, getObservabilityAuthorization(request));
  }
}
