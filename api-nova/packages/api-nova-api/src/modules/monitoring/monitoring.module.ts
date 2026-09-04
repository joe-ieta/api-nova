import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MonitoringController } from './monitoring.controller';
import { GatewayRuntimeModule } from '../gateway-runtime/gateway-runtime.module';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { SecurityModule } from '../security/security.module';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [
    EventEmitterModule,
    SecurityModule,
    ServersModule,
    RuntimeObservabilityModule,
    GatewayRuntimeModule,
  ],
  controllers: [MonitoringController],
})
export class MonitoringModule {}
