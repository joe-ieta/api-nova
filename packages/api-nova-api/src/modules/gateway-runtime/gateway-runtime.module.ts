import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PublicationModule } from '../publication/publication.module';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { GatewayRuntimeController } from './gateway-runtime.controller';
import { GatewayRuntimeMetricsService } from './services/gateway-runtime-metrics.service';
import { GatewayRuntimeService } from './services/gateway-runtime.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    PublicationModule,
    RuntimeObservabilityModule,
  ],
  controllers: [GatewayRuntimeController],
  providers: [GatewayRuntimeService, GatewayRuntimeMetricsService],
  exports: [GatewayRuntimeService, GatewayRuntimeMetricsService],
})
export class GatewayRuntimeModule {}
