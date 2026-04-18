import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { RuntimeMetricSeriesEntity } from '../../database/entities/runtime-metric-series.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityStateEntity } from '../../database/entities/runtime-observability-state.entity';
import { RuntimeObservabilityService } from './services/runtime-observability.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      EndpointDefinitionEntity,
      RuntimeObservabilityEventEntity,
      RuntimeMetricSeriesEntity,
      RuntimeObservabilityStateEntity,
    ]),
  ],
  providers: [RuntimeObservabilityService],
  exports: [RuntimeObservabilityService],
})
export class RuntimeObservabilityModule {}
