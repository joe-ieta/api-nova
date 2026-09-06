import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { UpsertRuntimeUpstreamBindingDto } from './dto/runtime-upstream-bindings.dto';
import { RuntimeUpstreamBindingsService } from './services/runtime-upstream-bindings.service';

@ApiTags('Runtime Upstream Bindings')
@Controller('v1/runtime-memberships/:runtimeMembershipId/upstream-binding')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class RuntimeUpstreamBindingsController {
  constructor(private readonly service: RuntimeUpstreamBindingsService) {}

  @Get()
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Get the upstream binding for a runtime membership' })
  get(@Param('runtimeMembershipId') runtimeMembershipId: string) {
    return this.service.getByMembership(runtimeMembershipId);
  }

  @Put()
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Create or replace a runtime membership upstream binding' })
  upsert(
    @Param('runtimeMembershipId') runtimeMembershipId: string,
    @Body() dto: UpsertRuntimeUpstreamBindingDto,
    @Req() request: any,
  ) {
    return this.service.upsert(runtimeMembershipId, dto, this.mutationContext(request));
  }

  @Get('resolution')
  @RequirePermissions('server:read')
  @ApiOperation({ summary: 'Resolve the deterministic healthy upstream candidate' })
  resolve(@Param('runtimeMembershipId') runtimeMembershipId: string) {
    return this.service.resolve(runtimeMembershipId);
  }

  @Delete()
  @RequirePermissions('server:manage')
  @ApiOperation({ summary: 'Delete a runtime membership upstream binding' })
  async remove(@Param('runtimeMembershipId') runtimeMembershipId: string, @Req() request: any) {
    await this.service.remove(runtimeMembershipId, this.mutationContext(request));
    return { success: true };
  }

  private mutationContext(request: any) {
    return {
      actorId: request.user?.id,
      ipAddress: request.ip,
      userAgent: request.get?.('user-agent'),
    };
  }
}
