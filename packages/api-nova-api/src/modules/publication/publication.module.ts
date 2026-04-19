import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointPublishBindingEntity } from '../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../database/entities/gateway-route-binding.entity';
import { PublicationProfileEntity } from '../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../database/entities/publication-profile-history.entity';
import { PublicationBatchRunEntity } from '../../database/entities/publication-batch-run.entity';
import { PublicationAuditEventEntity } from '../../database/entities/publication-audit-event.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { SecurityModule } from '../security/security.module';
import { PublicationController } from './publication.controller';
import { PublicationService } from './services/publication.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EndpointDefinitionEntity,
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      SourceServiceAssetEntity,
      PublicationProfileEntity,
      PublicationProfileHistoryEntity,
      PublicationBatchRunEntity,
      PublicationAuditEventEntity,
      EndpointPublishBindingEntity,
      GatewayRouteBindingEntity,
    ]),
    SecurityModule,
  ],
  controllers: [PublicationController],
  providers: [PublicationService],
  exports: [PublicationService],
})
export class PublicationModule {}
