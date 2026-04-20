import { Injectable, NotFoundException } from '@nestjs/common';
import { Request, Response } from 'express';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';

@Injectable()
export class GatewayRuntimeService {
  constructor(
    private readonly gatewayRouteSnapshotService: GatewayRouteSnapshotService,
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
      throw new NotFoundException(`No active gateway route for ${req.method} ${routePath}`);
    }

    try {
      const upstreamResponse = await this.gatewayProxyEngineService.forward(target, req, res);
      const latencyMs = Date.now() - startedAt;

      await this.gatewayRuntimeMetricsService.recordForwardResult({
        runtimeAssetId: target.runtimeAsset.id,
        runtimeMembershipId: target.membership.id,
        routePath: target.routeBinding.routePath,
        routeMethod: target.routeBinding.routeMethod,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        latencyMs,
        statusCode: upstreamResponse.statusCode,
        success: upstreamResponse.statusCode < 500,
      });
      await this.gatewayAccessLogService.recordRequest({
        resolvedRoute: target,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        req,
        upstreamUrl: upstreamResponse.targetUrl,
        proxyResult: upstreamResponse,
        latencyMs,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      await this.gatewayRuntimeMetricsService.recordForwardResult({
        runtimeAssetId: target.runtimeAsset.id,
        runtimeMembershipId: target.membership.id,
        routePath: target.routeBinding.routePath,
        routeMethod: target.routeBinding.routeMethod,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        latencyMs,
        success: false,
        errorMessage: (error as Error).message,
      });
      await this.gatewayAccessLogService.recordRequest({
        resolvedRoute: target,
        requestId: this.resolveRequestId(req, res),
        correlationId: this.resolveCorrelationId(req),
        req,
        latencyMs,
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
}
