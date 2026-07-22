import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RuntimeUpstreamBindingInstanceEntity } from '../../database/entities/runtime-upstream-binding-instance.entity';
import { RuntimeUpstreamBindingEntity } from '../../database/entities/runtime-upstream-binding.entity';
import { SourceServiceInstanceEntity } from '../../database/entities/source-service-instance.entity';
import { SecurityModule } from '../security/security.module';
import { RuntimeUpstreamBindingsController } from './runtime-upstream-bindings.controller';
import { RuntimeUpstreamBindingsService } from './services/runtime-upstream-bindings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RuntimeUpstreamBindingEntity,
      RuntimeUpstreamBindingInstanceEntity,
      SourceServiceInstanceEntity,
    ]),
    SecurityModule,
  ],
  controllers: [RuntimeUpstreamBindingsController],
  providers: [RuntimeUpstreamBindingsService],
  exports: [RuntimeUpstreamBindingsService],
})
export class RuntimeUpstreamBindingsModule {}
