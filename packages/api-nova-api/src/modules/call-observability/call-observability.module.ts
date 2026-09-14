import { CallObservabilitySubscriptionsQueryService } from './call-observability-subscriptions-query.service';
import { CallObservabilityDeliveriesQueryService } from './call-observability-deliveries-query.service';
import { CallObservabilitySubscriptionsService } from './call-observability-subscriptions.service';
import { CallObservabilityWebhookWorker, WEBHOOK_SENDER } from './call-observability-webhook.worker';
import { CallObservabilityWebhookSender, WebhookSenderDependencies } from './call-observability-webhook-sender';
import { CallObservabilityDeliveryLeaseService } from './call-observability-delivery-lease.service';
import { CallObservabilityOverviewSnapshotAuthorizer } from './call-observability-overview-snapshot-authorizer.service';
import { CallObservabilityBucketRecomputeService } from './call-observability-bucket-recompute.service';
import { CallObservabilityBucketRecomputeWorker } from './call-observability-bucket-recompute.worker';
import { CallObservabilityEventsDispatcher, EVENTS_DISPATCH_AUTHORIZER } from './call-observability-events.dispatcher';
import { CallObservabilityDispatchAuthorization } from './call-observability-dispatch-authorization';
import { CallObservabilityDispatchWorker } from './call-observability-dispatch.worker';
import { CallObservabilityOverviewService } from './call-observability-overview.service';
import { CallObservabilityOverviewController } from './call-observability-overview.controller';
import { CallObservabilityDependenciesService } from './call-observability-dependencies.service';
import { CallObservabilityDependenciesController } from './call-observability-dependencies.controller';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { CallObservabilityServerStatusController } from './call-observability-server-status.controller';
import { CallObservabilityEventsController, CallObservabilityEventsExceptionFilter } from './call-observability-events.controller';
import { CallObservabilityEventsService, EVENTS_SNAPSHOT_AUTHORIZER } from './call-observability-events.service';
import { CallObservabilityPipelineController } from './call-observability-pipeline.controller';
import { CallObservabilityPipelineService } from './call-observability-pipeline.service';
import { CallObservabilityBucketsProjector } from './call-observability-buckets.projector';
import { CallObservabilityBucketRecomputeQueue } from './call-observability-bucket-recompute.queue';
import { DynamicModule, Module } from '@nestjs/common';
import { CallObservabilityStatisticsController } from './call-observability-statistics.controller';
import { CallObservabilityStatisticsService } from './call-observability-statistics.service';
import { CallObservabilityCapabilitiesController } from './call-observability-capabilities.controller';
import { CallObservabilityCapabilitiesService } from './call-observability-capabilities.service';
import { CallObservabilityCallerLabelsController } from './call-observability-caller-labels.controller';
import { CallObservabilityCallerLabelsService } from './call-observability-caller-labels.service';
import { CallObservabilityVisitorsController } from './call-observability-visitors.controller';
import { CallObservabilityVisitorsService } from './call-observability-visitors.service';
import { CallObservabilityPayloadsController } from './call-observability-payloads.controller';
import { CallObservabilityPayloadsService } from './call-observability-payloads.service';
import { CallObservabilityInvocationsController } from './call-observability-invocations.controller';
import { CallObservabilityInvocationsService } from './call-observability-invocations.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SecurityModule } from '../security/security.module';
import { ObservabilityAccessGuard } from './call-observability-access.guard';
import { ObservabilityApiExceptionFilter } from './call-observability-api.contract';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { ObservabilityCommandStore } from './call-observability-command.store';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CALL_OBSERVABILITY_ENTITIES } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityGarbageService } from './call-observability-garbage.service';
import { CallObservabilityCallersProjector } from './call-observability-callers.projector';
import { CallObservabilityWorker } from './call-observability.worker';
import { CallObservabilitySourceLifecycle } from './call-observability-source-lifecycle.service';
import { CallObservabilityCollector } from './call-observability.collector';
import { CallObservabilityStore } from './call-observability.store';

@Module({
  imports: [ConfigModule, SecurityModule, TypeOrmModule.forFeature([...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity])],
  controllers: [CallObservabilityOverviewController, CallObservabilityDependenciesController, CallObservabilityServerStatusController, CallObservabilityEventsController, CallObservabilityPipelineController, CallObservabilityStatisticsController, CallObservabilityCapabilitiesController, CallObservabilityCallerLabelsController, CallObservabilityVisitorsController, CallObservabilityInvocationsController, CallObservabilityPayloadsController],
  providers: [CallObservabilitySubscriptionsQueryService, CallObservabilityDeliveriesQueryService, CallObservabilitySubscriptionsService, CallObservabilityWebhookWorker, CallObservabilityDeliveryLeaseService, CallObservabilityOverviewSnapshotAuthorizer,
    { provide: EVENTS_SNAPSHOT_AUTHORIZER, useExisting: CallObservabilityOverviewSnapshotAuthorizer }, CallObservabilityOverviewService, CallObservabilityDependenciesService, CallObservabilityServerStatusService,
    CallObservabilityEventsDispatcher, CallObservabilityDispatchAuthorization, CallObservabilityDispatchWorker,
    { provide: EVENTS_DISPATCH_AUTHORIZER, useExisting: CallObservabilityDispatchAuthorization },
    { provide: CallObservabilityBucketRecomputeService, inject: [CallObservabilityStore, CallObservabilityBucketRecomputeQueue],
      useFactory: (store: CallObservabilityStore, queue: CallObservabilityBucketRecomputeQueue) => new CallObservabilityBucketRecomputeService(store, queue) },
    { provide: CallObservabilityBucketRecomputeWorker, inject: [CallObservabilityBucketRecomputeService, ConfigService],
      useFactory: (service: CallObservabilityBucketRecomputeService, config: ConfigService) => new CallObservabilityBucketRecomputeWorker(service, config) },CallObservabilityEventsService, CallObservabilityEventsExceptionFilter, CallObservabilityPipelineService, CallObservabilityBucketRecomputeQueue,
    { provide: CallObservabilityBucketsProjector, useFactory: (queue: CallObservabilityBucketRecomputeQueue) => new CallObservabilityBucketsProjector(queue), inject: [CallObservabilityBucketRecomputeQueue] }, CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
  exports: [CallObservabilitySubscriptionsQueryService, CallObservabilityDeliveriesQueryService, CallObservabilitySubscriptionsService, CallObservabilityWebhookWorker, CallObservabilityDeliveryLeaseService, CallObservabilityOverviewService, CallObservabilityDependenciesService, CallObservabilityServerStatusService, CallObservabilityEventsDispatcher, CallObservabilityBucketRecomputeService, CallObservabilityEventsService, CallObservabilityPipelineService, CallObservabilityBucketsProjector, CallObservabilityBucketRecomputeQueue, CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
})
export class CallObservabilityModule {
  /** Trusted composition root only. Replace the plain module import, do not import both variants. */
  static withWebhook(dependencies: WebhookSenderDependencies): DynamicModule {
    if (!dependencies || !Array.isArray(dependencies.allowedOrigins) || !dependencies.allowedOrigins.length ||
        typeof dependencies.resolveAll !== 'function' || typeof dependencies.resolveSecret !== 'function') {
      throw new Error('INVALID_WEBHOOK_DEPENDENCIES');
    }
    const configured: WebhookSenderDependencies = Object.freeze({ ...dependencies,
      allowedOrigins: Object.freeze([...dependencies.allowedOrigins]) });
    return { module: CallObservabilityModule, providers: [{ provide: WEBHOOK_SENDER,
      inject: [CallObservabilityDeliveryLeaseService],
      useFactory: (leases: CallObservabilityDeliveryLeaseService) => new CallObservabilityWebhookSender(leases, configured),
    }], exports: [WEBHOOK_SENDER] };
  }
}
