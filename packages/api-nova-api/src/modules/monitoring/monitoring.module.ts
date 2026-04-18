import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MonitoringController } from './monitoring.controller';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { SecurityModule } from '../security/security.module';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [EventEmitterModule, SecurityModule, ServersModule, RuntimeObservabilityModule],
  controllers: [MonitoringController],
})
export class MonitoringModule {}
