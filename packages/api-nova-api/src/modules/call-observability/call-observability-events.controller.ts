import { ArgumentsHost, Catch, Controller, Get, Query, Req, UseFilters, applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { ObservabilityAccess, getObservabilityAuthorization } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityApiExceptionFilter, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import { CallObservabilityEventsService, EVENT_QUERY_KEYS, EventsCursorExpiredError } from './call-observability-events.service';

@Catch()
export class CallObservabilityEventsExceptionFilter extends ObservabilityApiExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    if (!(error instanceof EventsCursorExpiredError)) return super.catch(error, host);
    const http = host.switchToHttp(), response = http.getResponse();
    if (response.headersSent) return;
    response.setHeader('Cache-Control', 'no-store');
    response.status(410).json({ status: 'error', error: { code: error.code,
      message: 'Event cursor expired; obtain a new snapshot',
      requestId: http.getRequest()[OBSERVABILITY_REQUEST_ID] || randomUUID(),
      details: { earliestAvailableCursor: error.earliestAvailableCursor, requiresSnapshot: true } } });
  }
}

@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityEventsController {
  constructor(private readonly events: CallObservabilityEventsService) {}

  @Get('events')
  @UseFilters(CallObservabilityEventsExceptionFilter)
  @ApiOperation({ operationId: 'obsListEvents', summary: 'Read authorized durable event history in sequence order' })
  @applyDecorators(...EVENT_QUERY_KEYS.map(name => ApiQuery({ name, required: false,
    schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 200, default: 50 } : { type: 'string' } })))
  @ApiResponse({ status: 200, description: 'items, nextCursor (scanned position), hasMore and highWatermark in a success envelope' })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 410, description: 'EVENT_CURSOR_EXPIRED; details contain earliestAvailableCursor and requiresSnapshot' })
  async list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.events.list(query, getObservabilityAuthorization(request));
  }
}
