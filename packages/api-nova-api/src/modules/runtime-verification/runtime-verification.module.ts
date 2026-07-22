import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointTestSampleEntity } from '../../database/entities/endpoint-test-sample.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../database/entities/runtime-asset.entity';
import { RuntimeVerificationRunEntity } from '../../database/entities/runtime-verification-run.entity';
import { RuntimeVerificationResultEntity } from '../../database/entities/runtime-verification-result.entity';
import { RuntimeUpstreamBindingsModule } from '../runtime-upstream-bindings/runtime-upstream-bindings.module';
import { GatewayRuntimeModule } from '../gateway-runtime/gateway-runtime.module';
import { RuntimeVerificationController } from './runtime-verification.controller';
import { RuntimeVerificationService } from './services/runtime-verification.service';
import { GatewayCandidateReplayService } from './services/gateway-candidate-replay.service';
import { McpCandidateReplayService } from './services/mcp-candidate-replay.service';
import { RuntimeResponseAssertionService } from './services/runtime-response-assertion.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RuntimeAssetEntity,
      RuntimeAssetEndpointBindingEntity,
      EndpointTestSampleEntity,
      RuntimeVerificationRunEntity,
      RuntimeVerificationResultEntity,
    ]),
    RuntimeUpstreamBindingsModule,
    GatewayRuntimeModule,
  ],
  controllers: [RuntimeVerificationController],
  providers: [
    RuntimeVerificationService,
    GatewayCandidateReplayService,
    McpCandidateReplayService,
    RuntimeResponseAssertionService,
  ],
  exports: [RuntimeVerificationService],
})
export class RuntimeVerificationModule {}
