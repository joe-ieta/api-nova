import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Request } from 'express';
import { PublicationService } from '../../publication/services/publication.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';

type GatewayForwardResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  data: unknown;
};

@Injectable()
export class GatewayRuntimeService {
  // Transitional implementation: route resolution still depends on endpoint-direct bindings
  // and will move to gateway runtime assets in the corrected model.
  constructor(
    private readonly httpService: HttpService,
    private readonly publicationService: PublicationService,
    private readonly gatewayRuntimeMetricsService: GatewayRuntimeMetricsService,
  ) {}

  async forwardRequest(routePath: string, req: Request): Promise<GatewayForwardResult> {
    const startedAt = Date.now();
    const target = await this.publicationService.resolveActiveGatewayTarget(
      routePath,
      req.method,
    );

    if (!target) {
      throw new NotFoundException(`No active gateway route for ${req.method} ${routePath}`);
    }
    const { binding, params, publishBinding, upstreamBaseUrl } = target;
    if (!publishBinding.publishedToHttp) {
      throw new BadRequestException('HTTP publication is not active for this endpoint');
    }
    try {
      const targetUrl = this.buildTargetUrl(
        upstreamBaseUrl,
        binding.upstreamPath,
        req.originalUrl,
        params,
      );
      const upstreamResponse = await firstValueFrom(
        this.httpService.request({
          method: binding.upstreamMethod,
          url: targetUrl,
          data: req.body,
          headers: this.buildForwardHeaders(req.headers),
          validateStatus: () => true,
          timeout: binding.timeoutMs ?? 30000,
        }),
      );

      await this.gatewayRuntimeMetricsService.recordForwardResult({
        runtimeAssetId: target.runtimeAsset.id,
        runtimeMembershipId: target.membership.id,
        routePath: binding.routePath,
        routeMethod: binding.routeMethod,
        latencyMs: Date.now() - startedAt,
        statusCode: upstreamResponse.status,
        success: upstreamResponse.status < 500,
      });

      return {
        status: upstreamResponse.status,
        headers: this.normalizeResponseHeaders(upstreamResponse.headers as Record<string, unknown>),
        data: upstreamResponse.data,
      };
    } catch (error) {
      await this.gatewayRuntimeMetricsService.recordForwardResult({
        runtimeAssetId: target.runtimeAsset.id,
        runtimeMembershipId: target.membership.id,
        routePath: binding.routePath,
        routeMethod: binding.routeMethod,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorMessage: (error as Error).message,
      });
      throw error;
    }
  }

  private buildTargetUrl(
    baseUrl: string,
    upstreamPath: string,
    originalUrl: string,
    params: Record<string, string>,
  ) {
    const normalizedPath = this.applyPathParams(upstreamPath, params);
    const queryIndex = originalUrl.indexOf('?');
    const queryString = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
    return `${baseUrl}${normalizedPath}${queryString}`;
  }

  private buildForwardHeaders(headers: Request['headers']) {
    const nextHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!value) {
        continue;
      }
      const normalizedKey = key.toLowerCase();
      if (['host', 'content-length', 'connection'].includes(normalizedKey)) {
        continue;
      }
      nextHeaders[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
    return nextHeaders;
  }

  private normalizeResponseHeaders(headers: Record<string, unknown>) {
    const nextHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (value === undefined || value === null) {
        continue;
      }
      nextHeaders[key] = Array.isArray(value)
        ? value.map(item => String(item))
        : String(value);
    }
    return nextHeaders;
  }

  private applyPathParams(pathTemplate: string, params: Record<string, string>) {
    const normalizedPath = pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`;
    return normalizedPath.replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (!(key in params)) {
        throw new BadRequestException(`Missing path parameter '${key}' for upstream route`);
      }
      return encodeURIComponent(params[key]);
    });
  }
}
