import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { GatewayUpstreamCredentialAdminService } from './services/gateway-upstream-credential-admin.service';

@ApiTags('Upstream credential administration')
@ApiBearerAuth()
@Controller('security/upstream-credentials')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class GatewayUpstreamCredentialAdminController {
  constructor(private readonly admin: GatewayUpstreamCredentialAdminService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read process-local credential registry metadata' })
  @RequirePermissions('config:read')
  status() { return this.admin.status(); }

  @Post('reload')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Reload the configured credential file with generation precondition' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['expectedGeneration', 'reason'],
    properties: { expectedGeneration: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Operation reason; only its digest is retained in audit' } } } })
  @HttpCode(200)
  @RequirePermissions('config:update')
  reload(@Body() body: unknown, @Req() request: any) {
    return this.admin.reload(body, request.user?.id);
  }
}
