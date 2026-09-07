import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsService } from './services/documents.service';
import { DocumentsController } from './documents.controller';
import { OpenAPIDocument } from '../../database/entities/openapi-document.entity';
import { User } from '../../database/entities/user.entity';
import { AssetCatalogModule } from '../asset-catalog/asset-catalog.module';
import { SecurityModule } from '../security/security.module';
import { OpenAPIModule } from '../openapi/openapi.module';
import { PublicationModule } from '../publication/publication.module';
import { RuntimeAssetsModule } from '../runtime-assets/runtime-assets.module';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { MCPServerEntity } from '../../database/entities/mcp-server.entity';
import { PublicationProfileEntity } from '../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../database/entities/publication-profile-history.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OpenAPIDocument,
      User,
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      MCPServerEntity,
      PublicationProfileEntity,
      PublicationProfileHistoryEntity,
      EndpointPublishBindingEntity,
      GatewayRouteBindingEntity,
      EndpointDefinitionEntity,
      SourceServiceAssetEntity,
    ]),
    AssetCatalogModule,
    OpenAPIModule,
    PublicationModule,
    RuntimeAssetsModule,
    SecurityModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
