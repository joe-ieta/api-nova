import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointDefinitionEntity } from '../../database/entities/endpoint-definition.entity';
import { EndpointTestCaseEntity } from '../../database/entities/endpoint-test-case.entity';
import { EndpointTestRunEntity } from '../../database/entities/endpoint-test-run.entity';
import { EndpointTestSampleEntity } from '../../database/entities/endpoint-test-sample.entity';
import { SecurityModule } from '../security/security.module';
import { EndpointTestingController } from './endpoint-testing.controller';
import { EndpointTestingService } from './services/endpoint-testing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EndpointDefinitionEntity,
      EndpointTestCaseEntity,
      EndpointTestRunEntity,
      EndpointTestSampleEntity,
    ]),
    SecurityModule,
  ],
  controllers: [EndpointTestingController],
  providers: [EndpointTestingService],
  exports: [EndpointTestingService],
})
export class EndpointTestingModule {}
