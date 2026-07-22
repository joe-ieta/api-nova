import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
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
