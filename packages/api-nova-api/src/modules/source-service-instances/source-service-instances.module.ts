import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SourceServiceAssetEntity } from '../../database/entities/source-service-asset.entity';
import { SourceServiceInstanceEntity } from '../../database/entities/source-service-instance.entity';
import { SecurityModule } from '../security/security.module';
import { SourceServiceInstancesController } from './source-service-instances.controller';
import { SourceServiceInstancesService } from './services/source-service-instances.service';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([SourceServiceAssetEntity, SourceServiceInstanceEntity]),
    SecurityModule,
  ],
  controllers: [SourceServiceInstancesController],
  providers: [SourceServiceInstancesService],
  exports: [SourceServiceInstancesService],
})
export class SourceServiceInstancesModule {}
