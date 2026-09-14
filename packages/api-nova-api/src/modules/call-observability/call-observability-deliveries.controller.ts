import { applyDecorators, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import {
  OBSERVABILITY_DELIVERY_RETRY_SCHEMA, OBSERVABILITY_SUBSCRIPTION_TEST_SCHEMA,
  ObservabilityDeliveryDetailEnvelopeDto, ObservabilityDeliveryEnvelopeDto, ObservabilityDeliveryPageEnvelopeDto,
} from './call-observability-deliveries.dto';
import { CallObservabilityDeliveriesService } from './call-observability-deliveries.service';

@ApiTags('Call observability')
@Controller('monitoring/observability')
export class CallObservabilityDeliveriesController {
  constructor(private readonly deliveries: CallObservabilityDeliveriesService) {}

  @Post('subscriptions/:id/test')
  @HttpCode(202)
  @ObservabilityAccess('monitoring:subscription:manage')
  @ApiOperation({ operationId: 'obsTestSubscription', summary: 'Queue one explicit test event without synchronous network traffic' })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ schema: OBSERVABILITY_SUBSCRIPTION_TEST_SCHEMA })
  @ApiResponse({ status: 202, type: ObservabilityDeliveryEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  test(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('idempotency-key') key: unknown, @Req() request: any) {
    return this.deliveries.testSubscription(id, body, query, key,
      getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
  }

  @Get('deliveries')
  @ObservabilityAccess('monitoring:subscription:manage')
  @ApiOperation({ operationId: 'obsListDeliveries', summary: 'List authorized durable webhook deliveries' })
  @applyDecorators(...['subscriptionId', 'eventId', 'status', 'from', 'to', 'cursor', 'limit'].map(name =>
    ApiQuery({ name, required: false, schema: name === 'limit'
      ? { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      : name === 'status' ? { type: 'string', enum: ['pending', 'in_flight', 'retry_wait', 'succeeded', 'dead', 'cancelled'] }
        : { type: 'string' } })))
  @ApiResponse({ status: 200, type: ObservabilityDeliveryPageEnvelopeDto })
  list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.deliveries.list(query, getObservabilityAuthorization(request));
  }

  @Get('deliveries/:id')
  @ObservabilityAccess('monitoring:subscription:manage')
  @ApiOperation({ operationId: 'obsGetDelivery', summary: 'Read a delivery and bounded redacted attempt history' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'attemptsCursor', required: false, type: String })
  @ApiQuery({ name: 'attemptsLimit', required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } })
  @ApiResponse({ status: 200, type: ObservabilityDeliveryDetailEnvelopeDto })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  get(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() request: any) {
    return this.deliveries.get(id, query, getObservabilityAuthorization(request));
  }

  @Post('deliveries/:id/retry')
  @HttpCode(202)
  @ObservabilityAccess('monitoring:subscription:manage', 'monitoring:delivery:retry')
  @ApiOperation({ operationId: 'obsRetryDelivery', summary: 'Idempotently requeue an eligible retained delivery' })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: OBSERVABILITY_DELIVERY_RETRY_SCHEMA })
  @ApiResponse({ status: 202, type: ObservabilityDeliveryEnvelopeDto })
  @ApiResponse({ status: 409, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 410, type: ObservabilityErrorEnvelopeDto })
  retry(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('idempotency-key') key: unknown, @Req() request: any) {
    return this.deliveries.retry(id, body, query, key,
      getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
  }
}
