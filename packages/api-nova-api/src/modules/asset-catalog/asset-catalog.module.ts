import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { SecurityModule } from '../security/security.module';
import { AssetCatalogController } from './asset-catalog.controller';
import { AssetCatalogService } from './services/asset-catalog.service';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([
      SourceServiceAssetEntity,
      EndpointDefinitionEntity,
    ]),
    SecurityModule,
  ],
  controllers: [AssetCatalogController],
  providers: [AssetCatalogService],
  exports: [AssetCatalogService],
})
export class AssetCatalogModule {}
