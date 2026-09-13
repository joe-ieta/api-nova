import { Body, Controller, Headers, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import {
  OBSERVABILITY_SUBSCRIPTION_CREATE_SCHEMA, ObservabilitySubscriptionEnvelopeDto,
} from './call-observability-subscriptions.dto';
import { CallObservabilitySubscriptionsService } from './call-observability-subscriptions.service';

@ApiTags('Call observability')
@ObservabilityAccess('monitoring:subscription:manage')
@Controller('monitoring/observability')
export class CallObservabilitySubscriptionsController {
  constructor(private readonly subscriptions: CallObservabilitySubscriptionsService) {}

  @Post('subscriptions')
  @ApiOperation({ operationId: 'obsCreateSubscription', summary: 'Create a versioned webhook subscription without sending network traffic' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Optional visible ASCII key, scoped to the management principal and request.' })
  @ApiBody({ schema: OBSERVABILITY_SUBSCRIPTION_CREATE_SCHEMA })
  @ApiResponse({ status: 201, type: ObservabilitySubscriptionEnvelopeDto,
    headers: { 'X-Subscription-ETag': { schema: { type: 'string' }, description: 'Current subscription edit token.' } } })
  @ApiResponse({ status: 400, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 401, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 403, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 409, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 413, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 503, type: ObservabilityErrorEnvelopeDto })
  async create(@Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: unknown, @Req() request: any,
    @Res({ passthrough: true }) response: any) {
    const result = await this.subscriptions.create(body, query, idempotencyKey,
      getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
    response.setHeader('X-Subscription-ETag', result.data.editEtag);
    return result;
  }
}
