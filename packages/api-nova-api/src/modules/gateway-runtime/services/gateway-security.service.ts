import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  AuditAction,
  AuditLevel,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';
import {
  GatewayConsumerCredentialEntity,
  GatewayConsumerCredentialStatus,
} from '../../../database/entities/gateway-consumer-credential.entity';
import { AuditService } from '../../security/services/audit.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayRequestAuthContext } from '../types/gateway-security.types';
import { authenticateRuntimeRequest, RuntimeAuthError } from 'api-nova-parser';

@Injectable()
export class GatewaySecurityService {
  constructor(
    private readonly auditService: AuditService,
    @InjectRepository(GatewayConsumerCredentialEntity)
    private readonly credentialRepository: Repository<GatewayConsumerCredentialEntity>,
  ) {}

  async authorize(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
  ): Promise<GatewayRequestAuthContext> {
    const configuredMode = resolvedRoute.policies.auth.mode;
    const visibility = String(resolvedRoute.routeBinding.routeVisibility || 'internal')
      .trim().toLowerCase();
    const mode = configuredMode === 'anonymous' && visibility !== 'external'
      ? 'jwt' : configuredMode;
    if (mode === 'jwt') {
      try {
        const principal = await this.authenticateJwt(req.headers);
        const context: GatewayRequestAuthContext = { mode, principal };
        this.attachAuthContext(req, context);
        return context;
      } catch (error) {
        if (error instanceof RuntimeAuthError) throw new HttpException(error.code, error.status);
        throw error;
      }
    }
    if (mode === 'anonymous') {
      const context: GatewayRequestAuthContext = { mode };
      this.attachAuthContext(req, context);
      return context;
    }

    const presentedKey = this.extractApiKey(
      req,
      resolvedRoute.policies.auth.apiKeyQueryParamName,
    );
    if (!presentedKey) {
      throw new UnauthorizedException('Gateway API key is required');
    }

    const [keyId, secret] = this.parseApiKey(presentedKey);
    const credential = await this.credentialRepository.findOne({
      where: {
        keyId,
        status: GatewayConsumerCredentialStatus.ACTIVE,
      },
    });
    if (!credential || !this.matchesSecret(secret, credential.secretHash)) {
      throw new UnauthorizedException('Gateway API key is invalid');
    }

    if (
      credential.routeBindingId &&
      credential.routeBindingId !== resolvedRoute.routeBinding.id
    ) {
      throw new ForbiddenException('Gateway API key is not allowed for this route');
    }
    if (
      credential.runtimeAssetId &&
      credential.runtimeAssetId !== resolvedRoute.runtimeAsset.id
    ) {
      throw new ForbiddenException('Gateway API key is not allowed for this runtime');
    }

    credential.lastUsedAt = new Date();
    await this.credentialRepository.save(credential);
    void this.recordApiKeyUsageAudit(credential, resolvedRoute, req);

    const context: GatewayRequestAuthContext = {
      mode,
      consumerId: credential.id,
      keyId: credential.keyId,
    };
    this.attachAuthContext(req, context);
    return context;
  }

  private extractApiKey(req: Request, queryParamName?: string) {
    const fromHeader = this.headerValue(req.headers['x-api-key']);
    if (fromHeader) {
      return fromHeader;
    }
    if (!queryParamName) {
      return undefined;
    }

    const raw = (req.query?.[queryParamName] ?? undefined) as
      | string
      | string[]
      | undefined;
    return this.headerValue(raw);
  }

  private authenticateJwt(headers: Request['headers']) {
    return authenticateRuntimeRequest(headers, 'gateway', 'jwt');
  }

  private parseApiKey(presentedKey: string) {
    const normalized = String(presentedKey || '').trim();
    const separatorIndex = normalized.indexOf('.');
    if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
      throw new UnauthorizedException('Gateway API key format is invalid');
    }

    return [
      normalized.slice(0, separatorIndex),
      normalized.slice(separatorIndex + 1),
    ] as const;
  }

  private matchesSecret(secret: string, expectedHash: string) {
    const incomingHash = createHash('sha256').update(secret).digest('hex');
    const incomingBuffer = Buffer.from(incomingHash, 'utf8');
    const expectedBuffer = Buffer.from(expectedHash, 'utf8');
    if (incomingBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(incomingBuffer, expectedBuffer);
  }

  private attachAuthContext(req: Request, context: GatewayRequestAuthContext) {
    (req as Request & { gatewayAuth?: GatewayRequestAuthContext }).gatewayAuth = context;
  }

  private headerValue(value?: string | string[]) {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private async recordApiKeyUsageAudit(
    credential: GatewayConsumerCredentialEntity,
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
  ) {
    try {
      await this.auditService.log({
        action: AuditAction.API_KEY_USED,
        level: AuditLevel.INFO,
        status: AuditStatus.SUCCESS,
        resource: 'gateway_consumer_credential',
        resourceId: credential.id,
        ipAddress: req.ip || req.socket?.remoteAddress,
        userAgent: this.headerValue(req.headers['user-agent']),
        details: {
          context: {
            runtimeAssetId: resolvedRoute.runtimeAsset.id,
            routeBindingId: resolvedRoute.routeBinding.id,
            routePath: resolvedRoute.routeBinding.routePath,
            routeMethod: resolvedRoute.routeBinding.routeMethod,
            keyId: credential.keyId,
          },
        },
        metadata: {
          runtimeAssetId: resolvedRoute.runtimeAsset.id,
          routeBindingId: resolvedRoute.routeBinding.id,
          keyId: credential.keyId,
        },
      });
    } catch {
      // Audit persistence must not interrupt request admission.
    }
  }
}
