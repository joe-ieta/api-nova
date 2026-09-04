import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayConsumerCredentialEntity } from '../../database/entities/gateway-consumer-credential.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { MCPServerEntity } from '../../database/entities/mcp-server.entity';
import { PublicationProfileEntity } from '../../database/entities/publication-profile.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { GatewayRuntimeModule } from '../gateway-runtime/gateway-runtime.module';
import { RuntimeObservabilityModule } from '../runtime-observability/runtime-observability.module';
import { SecurityModule } from '../security/security.module';
import { RuntimeAssetsController } from './runtime-assets.controller';
import { RuntimeAssetsService } from './services/runtime-assets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SourceServiceAssetEntity,
      EndpointDefinitionEntity,
      MCPServerEntity,
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      PublicationProfileEntity,
      EndpointPublishBindingEntity,
      GatewayConsumerCredentialEntity,
      GatewayRouteBindingEntity,
    ]),
    GatewayRuntimeModule,
    RuntimeObservabilityModule,
    SecurityModule,
  ],
  controllers: [RuntimeAssetsController],
  providers: [RuntimeAssetsService],
  exports: [RuntimeAssetsService],
})
export class RuntimeAssetsModule {}
