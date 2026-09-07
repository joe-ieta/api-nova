import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { PublicationAuditEventEntity } from '../../database/entities/publication-audit-event.entity';
import { PublicationProfileEntity } from '../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../database/entities/publication-profile-history.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { SecurityModule } from '../security/security.module';
import { AssetCatalogController } from './asset-catalog.controller';
import { AssetCatalogService } from './services/asset-catalog.service';
import { EndpointTestingModule } from '../endpoint-testing/endpoint-testing.module';
import { SourceServiceInstancesModule } from '../source-service-instances/source-service-instances.module';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([
      SourceServiceAssetEntity,
      EndpointDefinitionEntity,
      RuntimeAssetEndpointBindingEntity,
      EndpointPublishBindingEntity,
      GatewayRouteBindingEntity,
      PublicationProfileEntity,
      PublicationProfileHistoryEntity,
      PublicationAuditEventEntity,
    ]),
    SecurityModule,
    EndpointTestingModule,
    SourceServiceInstancesModule,
  ],
  controllers: [AssetCatalogController],
  providers: [AssetCatalogService],
  exports: [AssetCatalogService],
})
export class AssetCatalogModule {}
