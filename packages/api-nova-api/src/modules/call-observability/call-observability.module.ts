import { CallObservabilityOverviewSnapshotAuthorizer } from './call-observability-overview-snapshot-authorizer.service';
import { EVENTS_SNAPSHOT_AUTHORIZER } from './call-observability-events.service';
import { CallObservabilityOverviewService } from './call-observability-overview.service';
import { CallObservabilityOverviewController } from './call-observability-overview.controller';
import { CallObservabilityDependenciesService } from './call-observability-dependencies.service';
import { CallObservabilityDependenciesController } from './call-observability-dependencies.controller';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { CallObservabilityServerStatusController } from './call-observability-server-status.controller';
import { CallObservabilityPipelineService } from './call-observability-pipeline.service';
import { CallObservabilityPipelineController } from './call-observability-pipeline.controller';
import { Module } from '@nestjs/common';
import { CallObservabilityEventsController } from './call-observability-events.controller';
import { CallObservabilityEventsService } from './call-observability-events.service';
import { CallObservabilityOutboxService } from './call-observability-outbox.service';
import { CallObservabilitySubscriptionsController } from './call-observability-subscriptions.controller';
import { CallObservabilitySubscriptionsService } from './call-observability-subscriptions.service';
import { CallObservabilityDeliveriesController } from './call-observability-deliveries.controller';
import { CallObservabilityDeliveriesService } from './call-observability-deliveries.service';
import { CallObservabilityDeliveryWorker } from './call-observability-delivery.worker';
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
import { ConfigModule } from '@nestjs/config';
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
  controllers: [CallObservabilityOverviewController, CallObservabilityDependenciesController, CallObservabilityServerStatusController, CallObservabilityPipelineController, CallObservabilitySubscriptionsController, CallObservabilityDeliveriesController, CallObservabilityEventsController, CallObservabilityStatisticsController, CallObservabilityCapabilitiesController, CallObservabilityCallerLabelsController, CallObservabilityVisitorsController, CallObservabilityInvocationsController, CallObservabilityPayloadsController],
  providers: [CallObservabilityOverviewSnapshotAuthorizer,
    { provide: EVENTS_SNAPSHOT_AUTHORIZER, useExisting: CallObservabilityOverviewSnapshotAuthorizer },
    CallObservabilityOverviewService, CallObservabilityDependenciesService, CallObservabilityServerStatusService, CallObservabilityPipelineService, CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    CallObservabilitySubscriptionsService, CallObservabilityDeliveriesService, CallObservabilityDeliveryWorker, CallObservabilityEventsService, CallObservabilityOutboxService, ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
  exports: [CallObservabilityOverviewService, CallObservabilityDependenciesService, CallObservabilityServerStatusService, CallObservabilityPipelineService, CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    CallObservabilitySubscriptionsService, CallObservabilityDeliveriesService, CallObservabilityDeliveryWorker, CallObservabilityEventsService, CallObservabilityOutboxService, ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
})
export class CallObservabilityModule {}
