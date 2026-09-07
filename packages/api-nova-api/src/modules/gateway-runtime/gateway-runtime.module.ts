import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayAccessLogEntity } from '../../database/entities/gateway-access-log.entity';
import { GatewayConsumerCredentialEntity } from '../../database/entities/gateway-consumer-credential.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { SecurityModule } from '../security/security.module';
import { GatewayRuntimeController } from './gateway-runtime.controller';
import { GatewayProxyEngineService } from './services/gateway-proxy-engine.service';
import { GatewayAccessLogService } from './services/gateway-access-log.service';
import { GatewayPolicyService } from './services/gateway-policy.service';
import { GatewayCacheService } from './services/gateway-cache.service';
import { GatewayRequestCaptureService } from './services/gateway-request-capture.service';
import { GatewayRouteSnapshotService } from './services/gateway-route-snapshot.service';
import { GatewayRuntimeMetricsService } from './services/gateway-runtime-metrics.service';
import { GatewayRuntimeService } from './services/gateway-runtime.service';
import { GatewaySecurityService } from './services/gateway-security.service';
import { GatewayTrafficControlService } from './services/gateway-traffic-control.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EndpointDefinitionEntity,
      EndpointPublishBindingEntity,
      GatewayAccessLogEntity,
      GatewayConsumerCredentialEntity,
      GatewayRouteBindingEntity,
      RuntimeAssetEndpointBindingEntity,
      RuntimeAssetEntity,
      SourceServiceAssetEntity,
    ]),
    RuntimeObservabilityModule,
    SecurityModule,
  ],
  controllers: [GatewayRuntimeController],
  providers: [
    GatewayRuntimeService,
    GatewayRuntimeMetricsService,
    GatewayRouteSnapshotService,
    GatewayPolicyService,
    GatewayCacheService,
    GatewaySecurityService,
    GatewayTrafficControlService,
    GatewayProxyEngineService,
    GatewayAccessLogService,
    GatewayRequestCaptureService,
  ],
  exports: [
    GatewayRuntimeService,
    GatewayRuntimeMetricsService,
    GatewayRouteSnapshotService,
    GatewayAccessLogService,
    GatewayPolicyService,
    GatewayCacheService,
    GatewaySecurityService,
    GatewayTrafficControlService,
  ],
})
export class GatewayRuntimeModule {}
