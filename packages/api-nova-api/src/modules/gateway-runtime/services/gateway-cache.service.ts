import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { URL } from 'node:url';
import {
  GATEWAY_SNAPSHOT_REFRESH_REQUESTED,
  GatewaySnapshotRefreshPayload,
} from '../gateway-runtime.events';
import { GatewayProxyResult } from '../types/gateway-proxy.types';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayRequestAuthContext } from '../types/gateway-security.types';
import { GatewayCacheEntry, GatewayCacheLookupResult } from '../types/gateway-cache.types';

@Injectable()
export class GatewayCacheService {
  private readonly logger = new Logger(GatewayCacheService.name);
  private readonly cache = new Map<string, GatewayCacheEntry>();

  resolve(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
    authContext?: GatewayRequestAuthContext,
  ): GatewayCacheLookupResult | null {
    const key = this.buildKey(resolvedRoute, req, authContext);
    if (!key) {
      return null;
    }

    const cached = this.cache.get(key);
    if (!cached) {
      return { key, hit: false };
    }
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return { key, hit: false };
    }

    return { key, hit: true, entry: cached };
  }

  store(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
    authContext: GatewayRequestAuthContext | undefined,
    proxyResult: GatewayProxyResult,
  ) {
    const key = this.buildKey(resolvedRoute, req, authContext);
    if (!key || !this.shouldStore(resolvedRoute, proxyResult)) {
      return false;
    }

    const ttlMs = resolvedRoute.policies.cache.ttlMs || 30000;
    const responseBody = proxyResult.responseBodyBuffer;
    if (!responseBody) {
      return false;
    }

    this.cache.set(key, {
      key,
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      routeBindingId: resolvedRoute.routeBinding.id,
      method: String(req.method || '').toUpperCase(),
      statusCode: proxyResult.statusCode,
      headers: {
        ...proxyResult.headers,
        'x-apinova-cache': 'HIT',
      },
      body: Buffer.from(responseBody),
      contentType: this.headerValue(proxyResult.headers['content-type']),
      contentLength: proxyResult.responseCapture?.totalBytes,
      responseBytes: proxyResult.responseCapture?.totalBytes ?? responseBody.byteLength,
      responseBodyPreview: proxyResult.responseCapture?.preview,
      responseBodyHash: proxyResult.responseCapture?.hash,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
    return true;
  }

  writeHit(res: Response, entry: GatewayCacheEntry, requestId: string) {
    res.status(entry.statusCode);
    for (const [key, value] of Object.entries(entry.headers)) {
      if (value === undefined) {
        continue;
      }
      res.setHeader(key, value as string | string[]);
    }
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-apinova-cache', 'HIT');
    res.end(entry.body);
  }

  @OnEvent(GATEWAY_SNAPSHOT_REFRESH_REQUESTED)
  handleSnapshotRefreshRequested(payload?: GatewaySnapshotRefreshPayload) {
    const cleared = this.cache.size;
    this.cache.clear();
    if (cleared > 0) {
      this.logger.debug(
        `Cleared ${cleared} gateway cache entries after snapshot refresh: ${payload?.reason || 'unknown'}`,
      );
    }
  }

  private buildKey(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
    authContext?: GatewayRequestAuthContext,
  ) {
    if (!this.isEligible(resolvedRoute, req)) {
      return null;
    }

    const originalUrl = String(req.originalUrl || req.url || '');
    const url = new URL(originalUrl, 'http://gateway.local');
    const varyQueryKeys = resolvedRoute.policies.cache.varyQueryKeys;
    const varyHeaderKeys = resolvedRoute.policies.cache.varyHeaderKeys;
    const queryEntries = this.normalizeQueryEntries(url, varyQueryKeys);
    const headerEntries = this.normalizeHeaderEntries(req, varyHeaderKeys);
    const consumerKey =
      resolvedRoute.policies.cache.varyByConsumer && authContext?.consumerId
        ? authContext.consumerId
        : undefined;

    return JSON.stringify({
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      routeBindingId: resolvedRoute.routeBinding.id,
      method: String(req.method || '').toUpperCase(),
      pathname: url.pathname,
      query: queryEntries,
      headers: headerEntries,
      consumer: consumerKey,
    });
  }

  private isEligible(resolvedRoute: GatewayResolvedRoute, req: Request) {
    const method = String(req.method || '').toUpperCase();
    if (!resolvedRoute.policies.cache.enabled) {
      return false;
    }
    return resolvedRoute.policies.cache.methods.includes(method);
  }

  private shouldStore(resolvedRoute: GatewayResolvedRoute, proxyResult: GatewayProxyResult) {
    if (!resolvedRoute.policies.cache.enabled) {
      return false;
    }
    if (proxyResult.statusCode < 200 || proxyResult.statusCode >= 300) {
      return false;
    }
    const contentType = this.headerValue(proxyResult.headers['content-type']) || '';
    if (contentType.includes('text/event-stream')) {
      return false;
    }
    if (this.headerValue(proxyResult.headers['set-cookie'])) {
      return false;
    }
    if (proxyResult.responseBodyBuffer === undefined) {
      return false;
    }
    return true;
  }

  private normalizeQueryEntries(url: URL, varyQueryKeys?: string[]) {
    const sourceKeys = varyQueryKeys && varyQueryKeys.length > 0
      ? [...varyQueryKeys].sort()
      : Array.from(new Set(url.searchParams.keys())).sort();

    return sourceKeys.map(key => [key, url.searchParams.getAll(key).sort()]);
  }

  private normalizeHeaderEntries(req: Request, varyHeaderKeys?: string[]) {
    return (varyHeaderKeys || [])
      .map(key => {
        const raw = req.headers[key];
        const value = Array.isArray(raw) ? raw.join(',') : raw;
        return [key, value || ''];
      })
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  }

  private headerValue(value?: string | string[]) {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }
}
