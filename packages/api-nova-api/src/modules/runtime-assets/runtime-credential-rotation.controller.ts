import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '../../database/entities/user.entity';
import { CurrentUser } from '../security/decorators/current-user.decorator';
import { RequirePermissions } from '../security/decorators/permissions.decorator';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { PermissionsGuard } from '../security/guards/permissions.guard';
import { RuntimeCredentialRotationService } from './services/runtime-credential-rotation.service';

export class RotateRuntimeCredentialDto {
  @IsInt() @Min(0) @Max(86400)
  overlapSeconds: number;
}
@ApiTags('Runtime Assets')
@Controller('v1/runtime-assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT')
export class RuntimeCredentialRotationController {
  constructor(private readonly rotation: RuntimeCredentialRotationService) {}
  @Post(':id/runtime-access-credentials/:credentialId/rotate')
  @RequirePermissions('server:manage')
  rotate(@Param('id') id: string, @Param('credentialId') credentialId: string,
    @Body() body: RotateRuntimeCredentialDto, @CurrentUser() user: User) {
    return this.rotation.rotate(id, credentialId, body.overlapSeconds, user?.id);
  }
}
