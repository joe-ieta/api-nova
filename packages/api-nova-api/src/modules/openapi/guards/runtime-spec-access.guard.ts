import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditAction, AuditLevel, AuditStatus } from '../../../database/entities/audit-log.entity';
import { JwtAuthGuard } from '../../security/guards/jwt-auth.guard';
import { AuditService } from '../../security/services/audit.service';
import {
  RUNTIME_SPEC_ACCESS_DENIED,
  RUNTIME_SPEC_ACCESS_HEADER,
  RuntimeSpecAccessGrant,
  RuntimeSpecAccessService,
} from '../../security/services/runtime-spec-access.service';

@Injectable()
export class RuntimeSpecAccessGuard implements CanActivate {
  private readonly logger = new Logger(RuntimeSpecAccessGuard.name);

  constructor(
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly runtimeSpecAccess: RuntimeSpecAccessService,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && /^Bearer\s+\S+/i.test(authorization)) {
      return this.jwtAuthGuard.canActivate(context);
    }

    const requestedRuntimeAssetId =
      typeof request.params?.runtimeAssetId === 'string' ? request.params.runtimeAssetId : '';
    const presented = request.headers[RUNTIME_SPEC_ACCESS_HEADER];
    if (typeof presented !== 'string' || !presented) {
      this.logger.warn(`Runtime spec access denied (missing credential) runtimeAssetId=${requestedRuntimeAssetId || 'unknown'}`);
      throw new UnauthorizedException(RUNTIME_SPEC_ACCESS_DENIED);
    }

    const grant = this.runtimeSpecAccess.verify(presented);
    if (!grant) {
      this.logger.warn(`Runtime spec access denied (invalid credential) runtimeAssetId=${requestedRuntimeAssetId || 'unknown'}`);
      throw new UnauthorizedException(RUNTIME_SPEC_ACCESS_DENIED);
    }
    if (grant.runtimeAssetId !== requestedRuntimeAssetId) {
      this.logger.warn(
        `Runtime spec access denied (foreign credential) runtimeAssetId=${requestedRuntimeAssetId || 'unknown'} grantRuntimeAssetId=${grant.runtimeAssetId}`,
      );
      throw new ForbiddenException(RUNTIME_SPEC_ACCESS_DENIED);
    }

    await this.recordAccess(request, grant);
    return true;
  }

  private async recordAccess(request: Request, grant: RuntimeSpecAccessGrant): Promise<void> {
    try {
      await this.auditService.log({
        action: AuditAction.API_CALLED,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        resource: 'openapi.spec_access',
        resourceId: grant.runtimeAssetId,
        ipAddress: this.clientIp(request),
        userAgent: this.userAgent(request),
        details: {
          channel: 'runtime-spec-token',
          runtimeAssetId: grant.runtimeAssetId,
          serverId: grant.serverId,
        },
      });
    } catch {
      this.logger.warn(`Runtime spec access audit failed runtimeAssetId=${grant.runtimeAssetId}`);
    }
  }

  private clientIp(request: Request): string {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor)) return forwardedFor[0] || '';
    return forwardedFor || request.socket?.remoteAddress || '';
  }

  private userAgent(request: Request): string {
    const userAgent = request.headers['user-agent'];
    return Array.isArray(userAgent) ? userAgent[0] || '' : userAgent || '';
  }
}
