import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MCPServerEntity } from '../../database/entities/mcp-server.entity';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { PublicationProfileEntity } from '../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../database/entities/publication-profile-history.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { AssetCatalogModule } from '../asset-catalog/asset-catalog.module';
import { SecurityModule } from '../security/security.module';
import { PublicationController } from './publication.controller';
import { PublicationService } from './services/publication.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MCPServerEntity,
      EndpointDefinitionEntity,
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      SourceServiceAssetEntity,
      PublicationProfileEntity,
      PublicationProfileHistoryEntity,
      EndpointPublishBindingEntity,
      GatewayRouteBindingEntity,
    ]),
    AssetCatalogModule,
    SecurityModule,
  ],
  controllers: [PublicationController],
  providers: [PublicationService],
  exports: [PublicationService],
})
export class PublicationModule {}
