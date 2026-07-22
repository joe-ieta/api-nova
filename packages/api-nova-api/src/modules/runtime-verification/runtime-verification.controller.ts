import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { PlanRuntimeVerificationDto } from './dto/runtime-verification.dto';
import { CurrentUser } from '../security/decorators/current-user.decorator';
import { User } from '../../database/entities/user.entity';
import { RuntimeVerificationService } from './services/runtime-verification.service';

@ApiTags('Runtime Verification')
@Controller('v1/runtime-assets/:runtimeAssetId/verification-runs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class RuntimeVerificationController {
  constructor(private readonly service: RuntimeVerificationService) {}

  @Post('plan')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Build and persist a candidate deployment verification plan' })
  plan(
    @Param('runtimeAssetId') runtimeAssetId: string,
    @Body() dto: PlanRuntimeVerificationDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.service.planCandidate(runtimeAssetId, dto, {
      waiverActorId: currentUser?.id,
    });
  }

  @Get()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'List runtime deployment verification runs' })
  list(@Param('runtimeAssetId') runtimeAssetId: string) {
    return this.service.list(runtimeAssetId);
  }

  @Get(':verificationRunId')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get runtime deployment verification evidence' })
  get(
    @Param('runtimeAssetId') runtimeAssetId: string,
    @Param('verificationRunId') verificationRunId: string,
  ) {
    return this.service.get(runtimeAssetId, verificationRunId);
  }

  @Post(':verificationRunId/execute-gateway')
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Replay a planned Gateway candidate and activate it only on success' })
  executeGateway(
    @Param('runtimeAssetId') runtimeAssetId: string,
    @Param('verificationRunId') verificationRunId: string,
  ) {
    return this.service.executeGatewayCandidate(runtimeAssetId, verificationRunId);
  }
}
