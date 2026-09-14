import { applyDecorators, Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { ObservabilityErrorEnvelopeDto, ObservabilityMetaDto } from './call-observability-api.contract';
import { CallObservabilityEventsService, EVENT_QUERY_KEYS } from './call-observability-events.service';

class EventHistoryPageDto {
  @ApiProperty({ type: 'array', items: { type: 'object' } }) items: object[];
  @ApiProperty() nextCursor: string;
  @ApiProperty() hasMore: boolean;
  @ApiProperty() highWatermark: string;
  @ApiProperty() highWatermarkCursor: string;
  @ApiProperty() scannedEvents: number;
}
class EventHistoryEnvelopeDto {
  @ApiProperty({ enum: ['success'] }) status: string;
  @ApiProperty({ type: EventHistoryPageDto }) data: EventHistoryPageDto;
  @ApiProperty({ type: ObservabilityMetaDto }) meta: ObservabilityMetaDto;
}

@ApiTags('Call observability')
@ObservabilityAccess()
@Controller('monitoring/observability')
export class CallObservabilityEventsController {
  constructor(private readonly events: CallObservabilityEventsService) {}

  @Get('events')
  @ApiOperation({ operationId: 'obsListEvents', summary: 'Read authorized durable events in commit sequence order' })
  @applyDecorators(...EVENT_QUERY_KEYS.map(name => ApiQuery({ name, required: false,
    schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 200, default: 50 } : { type: 'string' } })))
  @ApiResponse({ status: 200, type: EventHistoryEnvelopeDto })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.events.list(query, getObservabilityAuthorization(request));
  }
}
