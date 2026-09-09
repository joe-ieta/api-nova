import { Module } from '@nestjs/common';
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
import { CallObservabilityStore } from './call-observability.store';

@Module({
  imports: [ConfigModule, SecurityModule, TypeOrmModule.forFeature([...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity])],
  providers: [CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
  exports: [CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService,
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter, ObservabilityCursorService, ObservabilityCommandStore],
})
export class CallObservabilityModule {}
