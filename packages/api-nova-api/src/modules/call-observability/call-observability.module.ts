import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CALL_OBSERVABILITY_ENTITIES } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityGarbageService } from './call-observability-garbage.service';
import { CallObservabilityStore } from './call-observability.store';

@Module({
  imports: [TypeOrmModule.forFeature([...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity])],
  providers: [CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService],
  exports: [CallObservabilityPayloadStore, CallObservabilityStore, CallObservabilityGarbageService],
})
export class CallObservabilityModule {}
