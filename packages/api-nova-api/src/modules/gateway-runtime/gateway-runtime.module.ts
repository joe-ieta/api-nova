import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayAccessLogEntity } from '../../database/entities/gateway-access-log.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { GatewayRuntimeController } from './gateway-runtime.controller';
import { GatewayProxyEngineService } from './services/gateway-proxy-engine.service';
import { GatewayAccessLogService } from './services/gateway-access-log.service';
import { GatewayRequestCaptureService } from './services/gateway-request-capture.service';
import { GatewayRouteSnapshotService } from './services/gateway-route-snapshot.service';
import { GatewayRuntimeMetricsService } from './services/gateway-runtime-metrics.service';
import { GatewayRuntimeService } from './services/gateway-runtime.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EndpointDefinitionEntity,
      EndpointPublishBindingEntity,
      GatewayAccessLogEntity,
      GatewayRouteBindingEntity,
      RuntimeAssetEndpointBindingEntity,
      RuntimeAssetEntity,
      SourceServiceAssetEntity,
    ]),
    RuntimeObservabilityModule,
  ],
  controllers: [GatewayRuntimeController],
  providers: [
    GatewayRuntimeService,
    GatewayRuntimeMetricsService,
    GatewayRouteSnapshotService,
    GatewayProxyEngineService,
    GatewayAccessLogService,
    GatewayRequestCaptureService,
  ],
  exports: [
    GatewayRuntimeService,
    GatewayRuntimeMetricsService,
    GatewayRouteSnapshotService,
    GatewayAccessLogService,
  ],
})
export class GatewayRuntimeModule {}
