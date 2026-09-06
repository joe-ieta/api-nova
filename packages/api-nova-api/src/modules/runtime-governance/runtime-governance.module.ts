import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { RuntimeUpstreamBindingInstanceEntity } from '../../database/entities/runtime-upstream-binding-instance.entity';
import { RuntimeUpstreamBindingEntity } from '../../database/entities/runtime-upstream-binding.entity';
import { RuntimeGovernanceInvalidationService } from './services/runtime-governance-invalidation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      RuntimeUpstreamBindingEntity,
      RuntimeUpstreamBindingInstanceEntity,
    ]),
  ],
  providers: [RuntimeGovernanceInvalidationService],
  exports: [RuntimeGovernanceInvalidationService],
})
export class RuntimeGovernanceModule {}
