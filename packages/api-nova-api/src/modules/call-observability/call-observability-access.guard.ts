import {
  applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata, UseFilters, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiExtraModels } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { UserService } from '../security/services/user.service';
import {
  MANAGEMENT_TOKEN_AUDIENCE, MANAGEMENT_TOKEN_ISSUER, MANAGEMENT_TOKEN_USE,
} from '../security/management-access-token';
import {
  authorizeObservability, ObservabilityAuthorization, ObservabilityPermission,
} from './call-observability-access';
import {
  ObservabilityApiError, ObservabilityApiExceptionFilter, ObservabilityErrorEnvelopeDto,
  ObservabilityMetaDto, OBSERVABILITY_REQUEST_ID,
} from './call-observability-api.contract';

const REQUIRED = 'observability.requiredPermissions';
export const OBSERVABILITY_AUTHORIZATION = Symbol('observability.authorization');

@Injectable()
export class ObservabilityAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly users: UserService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    request[OBSERVABILITY_REQUEST_ID] = randomUUID();
    delete request[OBSERVABILITY_AUTHORIZATION];
    response.setHeader('Cache-Control', 'no-store');
    const header = request.headers?.authorization;
    if (typeof header !== 'string' || header.length > 8192 || !/^Bearer [A-Za-z0-9_.-]+$/i.test(header)) {
      throw new ObservabilityApiError('UNAUTHENTICATED');
    }
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret) < 32) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    let payload: { sub: string; tokenUse: string; exp: number; iat: number };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), {
        secret, algorithms: ['HS256'], audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER,
      });
      const now = Math.floor(Date.now() / 1000);
      if (payload.tokenUse !== MANAGEMENT_TOKEN_USE || typeof payload.sub !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(payload.sub) ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
        !Number.isSafeInteger(payload.iat) || payload.iat > now + 30) throw new Error('Invalid management token');
    } catch { throw new ObservabilityApiError('UNAUTHENTICATED'); }
    let user;
    try { user = await this.users.findUserById(payload.sub); }
    catch (error) {
      if (error?.getStatus?.() === 404) throw new ObservabilityApiError('UNAUTHENTICATED');
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    // Class-level restrictions cannot be weakened by method-level metadata.
    const permissions = this.reflector.getAllAndMerge<ObservabilityPermission[]>(REQUIRED, [
      context.getClass(), context.getHandler(),
    ]) || [];
    const scope = authorizeObservability(user, permissions);
    request.user = user;
    request[OBSERVABILITY_AUTHORIZATION] = scope;
    return true;
  }
}

export const ObservabilityAccess = (...permissions: ObservabilityPermission[]) => applyDecorators(
  SetMetadata(REQUIRED, permissions),
  UseGuards(ObservabilityAccessGuard),
  UseFilters(ObservabilityApiExceptionFilter),
  ApiBearerAuth(),
  ApiExtraModels(ObservabilityMetaDto, ObservabilityErrorEnvelopeDto),
);

export function getObservabilityAuthorization(request: object): ObservabilityAuthorization {
  const scope = request[OBSERVABILITY_AUTHORIZATION] as ObservabilityAuthorization | undefined;
  if (!scope) throw new ObservabilityApiError('UNAUTHENTICATED');
  return scope;
}
