import { applyDecorators, Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getObservabilityAuthorization, ObservabilityAccess } from './call-observability-access.guard';
import { OBSERVABILITY_REQUEST_ID, ObservabilityErrorEnvelopeDto } from './call-observability-api.contract';
import {
  OBSERVABILITY_SUBSCRIPTION_CREATE_SCHEMA, OBSERVABILITY_SUBSCRIPTION_PATCH_SCHEMA,
  ObservabilitySubscriptionEnvelopeDto, ObservabilitySubscriptionPageEnvelopeDto,
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

  @Get('subscriptions')
  @ApiOperation({ operationId: 'obsListSubscriptions', summary: 'List authorized webhook subscriptions from a fixed snapshot' })
  @applyDecorators(...['state', 'cursor', 'limit'].map(name => ApiQuery({ name, required: false,
    schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      : name === 'state' ? { type: 'string', enum: ['enabled', 'paused'] } : { type: 'string' } })))
  @ApiResponse({ status: 200, type: ObservabilitySubscriptionPageEnvelopeDto })
  list(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.subscriptions.list(query, getObservabilityAuthorization(request));
  }

  @Get('subscriptions/:id')
  @ApiOperation({ operationId: 'obsGetSubscription', summary: 'Read an authorized subscription without exposing signing secrets' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ObservabilitySubscriptionEnvelopeDto,
    headers: { 'X-Subscription-ETag': { schema: { type: 'string' }, description: 'Current subscription edit token.' } } })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  async get(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() request: any,
    @Res({ passthrough: true }) response: any) {
    const result = await this.subscriptions.get(id, query, getObservabilityAuthorization(request));
    response.setHeader('X-Subscription-ETag', result.data.editEtag);
    return result;
  }

  @Patch('subscriptions/:id')
  @ApiOperation({ operationId: 'obsUpdateSubscription', summary: 'Create a new effective subscription revision atomically' })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiBody({ schema: OBSERVABILITY_SUBSCRIPTION_PATCH_SCHEMA })
  @ApiResponse({ status: 200, type: ObservabilitySubscriptionEnvelopeDto,
    headers: { 'X-Subscription-ETag': { schema: { type: 'string' }, description: 'Updated subscription edit token.' } } })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 412, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 428, type: ObservabilityErrorEnvelopeDto })
  async update(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown>,
    @Headers('if-match') ifMatch: unknown, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.subscriptions.update(id, body, query, ifMatch,
      getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
    response.setHeader('X-Subscription-ETag', result.data.editEtag);
    return result;
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'obsDeleteSubscription', summary: 'Soft-delete a subscription and cancel unfinished deliveries atomically' })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 412, type: ObservabilityErrorEnvelopeDto })
  @ApiResponse({ status: 428, type: ObservabilityErrorEnvelopeDto })
  remove(@Param('id') id: string, @Query() query: Record<string, unknown>,
    @Headers('if-match') ifMatch: unknown, @Req() request: any) {
    return this.subscriptions.remove(id, query, ifMatch,
      getObservabilityAuthorization(request), request[OBSERVABILITY_REQUEST_ID]);
  }
}
