import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { GatewayAccessLogEntity } from '../../../database/entities/gateway-access-log.entity';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayProxyResult } from '../types/gateway-proxy.types';

@Injectable()
export class GatewayAccessLogService {
  private readonly logger = new Logger(GatewayAccessLogService.name);

  constructor(
    @InjectRepository(GatewayAccessLogEntity)
    private readonly gatewayAccessLogRepository: Repository<GatewayAccessLogEntity>,
  ) {}

  async recordRequest(input: {
    resolvedRoute: GatewayResolvedRoute;
    requestId: string;
    correlationId?: string;
    req: Request;
    upstreamUrl?: string;
    proxyResult?: GatewayProxyResult;
    latencyMs: number;
    statusCode?: number;
    errorMessage?: string;
  }) {
    try {
      const requestHeaders = this.normalizeHeaders(input.req.headers);
      const responseHeaders = input.proxyResult?.headers
        ? this.normalizeHeaders(input.proxyResult.headers)
        : undefined;

      const entity = this.gatewayAccessLogRepository.create({
        requestId: input.requestId,
        correlationId: input.correlationId,
        runtimeAssetId: input.resolvedRoute.runtimeAsset.id,
        runtimeMembershipId: input.resolvedRoute.membership.id,
        routeBindingId: input.resolvedRoute.routeBinding.id,
        endpointDefinitionId: input.resolvedRoute.endpointDefinition.id,
        method: input.req.method,
        routePath: input.resolvedRoute.routeBinding.routePath,
        upstreamUrl: input.upstreamUrl,
        statusCode: input.proxyResult?.statusCode ?? input.statusCode,
        latencyMs: input.latencyMs,
        clientIp: this.ip(input.req),
        actorId: this.resolveActorId(input.req),
        authMode: this.resolveAuthMode(input.req),
        consumerId: this.resolveConsumerId(input.req),
        credentialKeyId: this.resolveCredentialKeyId(input.req),
        requestContentType: this.headerValue(input.req.headers['content-type']),
        responseContentType: this.headerValue(input.proxyResult?.headers?.['content-type']),
        requestBytes:
          input.proxyResult?.requestCapture?.totalBytes ??
          this.numericHeaderValue(input.req.headers['content-length']),
        responseBytes:
          input.proxyResult?.responseCapture?.totalBytes ??
          this.numericHeaderValue(input.proxyResult?.headers?.['content-length']),
        requestHeaders,
        responseHeaders,
        requestQuery: (input.req.query || {}) as Record<string, unknown>,
        requestBodyPreview: input.proxyResult?.requestCapture?.preview,
        responseBodyPreview: input.proxyResult?.responseCapture?.preview,
        requestBodyHash: input.proxyResult?.requestCapture?.hash,
        responseBodyHash: input.proxyResult?.responseCapture?.hash,
        captureMode: this.resolveCaptureMode(input.proxyResult, input.errorMessage),
        errorMessage: input.errorMessage,
      });

      await this.gatewayAccessLogRepository.save(entity);
    } catch (error: any) {
      this.logger.warn(`Failed to persist gateway access log: ${error.message}`);
    }
  }

  async recordUnmatchedRequest(input: {
    requestId: string;
    correlationId?: string;
    req: Request;
    routePath: string;
    latencyMs: number;
    statusCode: number;
    errorMessage: string;
  }) {
    try {
      const entity = this.gatewayAccessLogRepository.create({
        requestId: input.requestId,
        correlationId: input.correlationId,
        method: input.req.method,
        routePath: input.routePath,
        statusCode: input.statusCode,
        latencyMs: input.latencyMs,
        clientIp: this.ip(input.req),
        actorId: this.resolveActorId(input.req),
        authMode: this.resolveAuthMode(input.req),
        consumerId: this.resolveConsumerId(input.req),
        credentialKeyId: this.resolveCredentialKeyId(input.req),
        requestContentType: this.headerValue(input.req.headers['content-type']),
        requestBytes: this.numericHeaderValue(input.req.headers['content-length']),
        requestHeaders: this.normalizeHeaders(input.req.headers),
        requestQuery: (input.req.query || {}) as Record<string, unknown>,
        captureMode: 'meta_only',
        errorMessage: input.errorMessage,
      });

      await this.gatewayAccessLogRepository.save(entity);
    } catch (error: any) {
      this.logger.warn(`Failed to persist unmatched gateway access log: ${error.message}`);
    }
  }

  async queryLogs(query: {
    page?: number;
    limit?: number;
    runtimeAssetId?: string;
    runtimeMembershipId?: string;
    routeBindingId?: string;
    requestId?: string;
    statusCode?: number;
    method?: string;
  }) {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.max(1, Math.min(Number(query.limit || 20), 100));

    const queryBuilder = this.gatewayAccessLogRepository.createQueryBuilder('log');
    if (query.runtimeAssetId) {
      queryBuilder.andWhere('log.runtimeAssetId = :runtimeAssetId', {
        runtimeAssetId: query.runtimeAssetId,
      });
    }
    if (query.runtimeMembershipId) {
      queryBuilder.andWhere('log.runtimeMembershipId = :runtimeMembershipId', {
        runtimeMembershipId: query.runtimeMembershipId,
      });
    }
    if (query.routeBindingId) {
      queryBuilder.andWhere('log.routeBindingId = :routeBindingId', {
        routeBindingId: query.routeBindingId,
      });
    }
    if (query.requestId) {
      queryBuilder.andWhere('log.requestId = :requestId', {
        requestId: query.requestId,
      });
    }
    if (query.statusCode) {
      queryBuilder.andWhere('log.statusCode = :statusCode', {
        statusCode: Number(query.statusCode),
      });
    }
    if (query.method) {
      queryBuilder.andWhere('log.method = :method', {
        method: String(query.method).toUpperCase(),
      });
    }

    queryBuilder.orderBy('log.createdAt', 'DESC');
    queryBuilder.skip((page - 1) * limit).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();
    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async listRuntimeAssetLogs(runtimeAssetId: string, limit: number = 20) {
    const take = Math.max(1, Math.min(Number(limit || 20), 100));
    return this.gatewayAccessLogRepository.find({
      where: { runtimeAssetId },
      order: { createdAt: 'DESC' },
      take,
    });
  }

  private normalizeHeaders(
    headers: Record<string, string | string[] | number | undefined>,
  ): Record<string, string | string[]> {
    const next: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (value === undefined || value === null) {
        continue;
      }
      const normalizedKey = key.toLowerCase();
      if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(normalizedKey)) {
        next[key] = '[REDACTED]';
        continue;
      }
      next[key] = Array.isArray(value) ? value.map(item => String(item)) : String(value);
    }
    return next;
  }

  private numericHeaderValue(value?: string | string[]) {
    const normalized = this.headerValue(value);
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private headerValue(value?: string | string[]) {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private ip(req: Request) {
    return (
      req.ip ||
      req.socket?.remoteAddress ||
      this.headerValue(req.headers['x-forwarded-for']) ||
      undefined
    );
  }

  private resolveActorId(req: Request) {
    const user = (req as Request & { user?: { id?: string; userId?: string } }).user;
    return user?.id || user?.userId;
  }

  private resolveAuthMode(req: Request) {
    const auth = (req as Request & { gatewayAuth?: { mode?: string } }).gatewayAuth;
    return auth?.mode;
  }

  private resolveConsumerId(req: Request) {
    const auth = (req as Request & { gatewayAuth?: { consumerId?: string } }).gatewayAuth;
    return auth?.consumerId;
  }

  private resolveCredentialKeyId(req: Request) {
    const auth = (req as Request & { gatewayAuth?: { keyId?: string } }).gatewayAuth;
    return auth?.keyId;
  }

  private resolveCaptureMode(
    proxyResult?: GatewayProxyResult,
    errorMessage?: string,
  ) {
    if (proxyResult?.requestCapture?.preview || proxyResult?.responseCapture?.preview) {
      return 'body_preview';
    }
    if (errorMessage) {
      return 'body_on_error';
    }
    return 'meta_only';
  }
}
