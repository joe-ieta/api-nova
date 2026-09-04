import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Request, Response } from 'express';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayProxyResult } from '../types/gateway-proxy.types';

@Injectable()
export class GatewayRuntimeService {
  constructor(
    private readonly gatewayRouteSnapshotService: GatewayRouteSnapshotService,
    private readonly gatewaySecurityService: GatewaySecurityService,
    private readonly gatewayTrafficControlService: GatewayTrafficControlService,
    private readonly gatewayCacheService: GatewayCacheService,
    private readonly gatewayProxyEngineService: GatewayProxyEngineService,
    private readonly gatewayAccessLogService: GatewayAccessLogService,
    private readonly gatewayRuntimeMetricsService: GatewayRuntimeMetricsService,
  ) {}

  async forwardRequest(routePath: string, req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const target = this.gatewayRouteSnapshotService.resolve(
      req.headers.host,
      req.method,
      routePath,
    );

    if (!target) {
      const requestId = this.resolveRequestId(req, res);
      const correlationId = this.resolveCorrelationId(req);
      const latencyMs = Date.now() - startedAt;
      await this.gatewayRuntimeMetricsService.recordRouteMiss({
        method: String(req.method || '').toUpperCase(),
        routePath,
        host: Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host,
        requestId,
        correlationId,
        clientIp: req.ip || req.socket?.remoteAddress,
      });
      await this.gatewayAccessLogService.recordUnmatchedRequest({
        requestId,
        correlationId,
        req,
        routePath,
        latencyMs,
        statusCode: 404,
        errorMessage: `No active gateway route for ${req.method} ${routePath}`,
      });
      throw new NotFoundException(`No active gateway route for ${req.method} ${routePath}`);
    }

    try {
      const authContext = await this.gatewaySecurityService.authorize(target, req);
      const admission = await this.gatewayTrafficControlService.admit(target, authContext);
      try {
        const requestId = this.resolveRequestId(req, res);
        const correlationId = this.resolveCorrelationId(req);
        const cacheLookup = this.gatewayCacheService.resolve(target, req, authContext);

        if (cacheLookup) {
          await this.gatewayRuntimeMetricsService.recordCacheResult({
            runtimeAssetId: target.runtimeAsset.id,
            runtimeMembershipId: target.membership.id,
            routePath: target.routeBinding.routePath,
            routeMethod: target.routeBinding.routeMethod,
            requestId,
            correlationId,
            cacheStatus: cacheLookup.hit ? 'hit' : 'miss',
          });
        }

        if (cacheLookup?.hit) {
          this.gatewayCacheService.writeHit(res, cacheLookup.entry, requestId);
          const latencyMs = Date.now() - startedAt;
          const cachedProxyResult = this.buildCachedProxyResult(cacheLookup.entry);
          await this.gatewayRuntimeMetricsService.recordForwardResult({
            runtimeAssetId: target.runtimeAsset.id,
            runtimeMembershipId: target.membership.id,
            routePath: target.routeBinding.routePath,
            routeMethod: target.routeBinding.routeMethod,
            requestId,
            correlationId,
            latencyMs,
            statusCode: cacheLookup.entry.statusCode,
            success: cacheLookup.entry.statusCode < 500,
          });
          await this.gatewayAccessLogService.recordRequest({
            resolvedRoute: target,
            requestId,
            correlationId,
            req,
            proxyResult: cachedProxyResult,
            latencyMs,
            upstreamUrl: 'cache://gateway',
          });
          return;
        }

        const upstreamResponse = await this.forwardWithRetry(target, req, res);
        this.gatewayCacheService.store(target, req, authContext, upstreamResponse);
        const latencyMs = Date.now() - startedAt;
        await this.gatewayRuntimeMetricsService.recordForwardResult({
          runtimeAssetId: target.runtimeAsset.id,
          runtimeMembershipId: target.membership.id,
          routePath: target.routeBinding.routePath,
          routeMethod: target.routeBinding.routeMethod,
          requestId,
          correlationId,
          latencyMs,
          statusCode: upstreamResponse.statusCode,
          success: upstreamResponse.statusCode < 500,
        });
        await this.gatewayAccessLogService.recordRequest({
          resolvedRoute: target,
          requestId,
          correlationId,
          req,
          upstreamUrl: upstreamResponse.targetUrl,
          proxyResult: upstreamResponse,
          latencyMs,
        });
      } finally {
        admission.release();
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const statusCode = this.resolveStatusCode(error);
      if (statusCode === 401 || statusCode === 403) {
        this.gatewayRuntimeMetricsService.recordPolicyEvent({
          runtimeAssetId: target.runtimeAsset.id,
          runtimeMembershipId: target.membership.id,
          routePath: target.routeBinding.routePath,
          routeMethod: target.routeBinding.routeMethod,
          policyName: 'gateway.auth_rejected',
        });
        await this.gatewayRuntimeMetricsService.recordPolicyObservabilityEvent({
          runtimeAssetId: target.runtimeAsset.id,
          runtimeMembershipId: target.membership.id,
          routePath: target.routeBinding.routePath,
          routeMethod: target.routeBinding.routeMethod,
          policyName: 'gateway.auth_rejected',
          requestId: this.resolveRequestId(req, res),
          correlationId: this.resolveCorrelationId(req),
          clientIp: req.ip || req.socket?.remoteAddress,
          errorMessage: (error as Error).message,
        });
      }
      await this.gatewayRuntimeMetricsService.recordForwardResult({
        runtimeAssetId: target.runtimeAsset.id,
        runtimeMembershipId: target.membership.id,
        routePath: target.routeBinding.routePath,
        routeMethod: target.routeBinding.routeMethod,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        latencyMs,
        success: false,
        statusCode,
        errorMessage: (error as Error).message,
      });
      await this.gatewayAccessLogService.recordRequest({
        resolvedRoute: target,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        req,
        latencyMs,
        statusCode,
        errorMessage: (error as Error).message,
      });
      throw error;
    }
  }

  private resolveRequestId(req: Request, res: Response) {
    const responseValue =
      typeof res.getHeader === 'function' ? res.getHeader('x-request-id') : undefined;
    if (typeof responseValue === 'string') {
      return responseValue;
    }
    const requestValue = req.headers['x-request-id'];
    if (Array.isArray(requestValue)) {
      return requestValue[0];
    }
    return String(requestValue || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  private resolveCorrelationId(req: Request) {
    const value = req.headers['x-correlation-id'];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value ? String(value) : undefined;
  }

  private resolveStatusCode(error: unknown) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    return undefined;
  }

  private async forwardWithRetry(
    target: GatewayResolvedRoute,
    req: Request,
    res: Response,
  ) {
    const attempts = this.resolveMaxAttempts(target, req);
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < attempts) {
      attempt += 1;
      try {
        if (attempt > 1) {
          await this.gatewayTrafficControlService.beforeAttempt(target);
        }
        const result = await this.gatewayProxyEngineService.forward(target, req, res, {
          captureResponseBodyMaxBytes: target.policies.cache.enabled
            ? target.policies.cache.maxBodyBytes
            : undefined,
        });
        await this.gatewayTrafficControlService.recordAttemptSuccess(target);
        return result;
      } catch (error) {
        lastError = error as Error;
        await this.gatewayTrafficControlService.recordAttemptFailure(target, lastError);

        if (
          attempt >= attempts ||
          res.headersSent ||
          !this.isRetryable(target, req, lastError)
        ) {
          throw lastError;
        }

        await this.gatewayTrafficControlService.recordRetryAttempt(target, attempt + 1, lastError);
        await this.delay(this.resolveRetryDelayMs(target, attempt));
      }
    }

    throw lastError || new Error('Gateway proxy request failed');
  }

  private isRetryable(
    target: GatewayResolvedRoute,
    req: Request,
    error: Error,
  ) {
    const code = this.resolveStatusCode(error);
    if (code && code < 500 && code !== 504) {
      return false;
    }

    const method = String(req.method || '').toUpperCase();
    if (['GET', 'HEAD'].includes(method)) {
      return true;
    }

    return Boolean(target.policies?.traffic?.retryPolicy?.allowNonIdempotent);
  }

  private resolveMaxAttempts(target: GatewayResolvedRoute, req: Request) {
    const configuredAttempts = Number(target.policies?.traffic?.retryPolicy?.attempts || 1);
    const method = String(req.method || '').toUpperCase();
    if (['GET', 'HEAD'].includes(method)) {
      return Math.max(1, Math.min(configuredAttempts, 3));
    }
    return target.policies?.traffic?.retryPolicy?.allowNonIdempotent
      ? Math.max(1, Math.min(configuredAttempts, 2))
      : 1;
  }

  private resolveRetryDelayMs(target: GatewayResolvedRoute, attempt: number) {
    const baseDelayMs = Number(target.policies?.traffic?.retryPolicy?.baseDelayMs || 0);
    if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
      return 0;
    }
    return Math.min(baseDelayMs * attempt, 1000);
  }

  private async delay(ms: number) {
    if (ms <= 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private buildCachedProxyResult(entry: {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    responseBytes: number;
    responseBodyPreview?: string;
    responseBodyHash?: string;
    body: Buffer;
  }): GatewayProxyResult {
    return {
      statusCode: entry.statusCode,
      headers: entry.headers,
      responseBodyBuffer: Buffer.from(entry.body),
      responseCapture: {
        totalBytes: entry.responseBytes,
        preview: entry.responseBodyPreview,
        hash: entry.responseBodyHash || '',
        truncated: false,
      },
    };
  }
}
