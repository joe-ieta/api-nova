import { Module } from '@nestjs/common';
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
  controllers: [CallObservabilityStatisticsController, CallObservabilityCapabilitiesController, CallObservabilityCallerLabelsController, CallObservabilityVisitorsController, CallObservabilityInvocationsController, CallObservabilityPayloadsController],
  providers: [CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
  exports: [CallObservabilityStatisticsService, CallObservabilityCapabilitiesService, CallObservabilityCallerLabelsService, CallObservabilityVisitorsService, CallObservabilityPayloadsService, CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
})
export class CallObservabilityModule {}
