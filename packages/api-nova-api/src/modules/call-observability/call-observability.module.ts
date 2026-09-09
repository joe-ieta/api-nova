import { Module } from '@nestjs/common';
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
  controllers: [CallObservabilityInvocationsController],
  providers: [CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
  exports: [CallObservabilityInvocationsService, CallObservabilitySourceLifecycle, CallObservabilityCallersProjector, CallObservabilityWorker, CallObservabilityCollector, CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
})
export class CallObservabilityModule {}
