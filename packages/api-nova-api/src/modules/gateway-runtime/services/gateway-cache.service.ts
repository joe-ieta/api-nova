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
import { GatewayCacheEntry, GatewayCacheLookupResult, GatewayHeaderCacheRequest } from '../types/gateway-cache.types';

import { filterGatewayResponseHeadersV1 } from './gateway-header-wire-policy';

@Injectable()
export class GatewayCacheService {
  private readonly logger = new Logger(GatewayCacheService.name);
  private readonly cache = new Map<string, GatewayCacheEntry>();

  resolve(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
    authContext?: GatewayRequestAuthContext,
    headerRequest?: GatewayHeaderCacheRequest,
  ): GatewayCacheLookupResult | null {
    const key = this.buildKey(resolvedRoute, req, authContext, headerRequest);
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
    headerRequest?: GatewayHeaderCacheRequest,
  ) {
    const key = this.buildKey(resolvedRoute, req, authContext, headerRequest);
    if (!key || !this.shouldStore(resolvedRoute, proxyResult, headerRequest)) {
      return false;
    }

    const policy = resolvedRoute.policies.upstream?.compiledHeaderPolicy;
    const declaredTtl = policy ? this.responseTtl(proxyResult.headerCacheSignals?.cacheControl) : undefined;
    let ttlMs = resolvedRoute.policies.cache.ttlMs || 30000;
    if (declaredTtl !== undefined && declaredTtl !== null) {
      const age = Number(proxyResult.headerCacheSignals?.age || 0);
      if (!Number.isFinite(age) || age < 0) return false;
      ttlMs = Math.min(ttlMs, declaredTtl - age * 1000);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    const responseBody = proxyResult.responseBodyBuffer;
    if (!responseBody) {
      return false;
    }

    let safeHeaders = proxyResult.headers;
    if (policy) {
      try { safeHeaders = filterGatewayResponseHeadersV1({ policy, headers: proxyResult.headers,
        statusCode: proxyResult.statusCode, requestMethod: 'GET',
        consumerAuthenticationHeaderNames: resolvedRoute.policies.upstream.consumerAuthenticationHeaderNames,
        historicalAuthenticationHeaderNames: resolvedRoute.policies.upstream.historicalAuthenticationHeaderNames,
      }).headers; } catch { return false; }
    }
    this.cache.set(key, {
      headerPolicyIdentity: policy?.identity,
      key,
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      routeBindingId: resolvedRoute.routeBinding.id,
      method: String(req.method || '').toUpperCase(),
      statusCode: proxyResult.statusCode,
      headers: {
        ...safeHeaders,
        'x-apinova-cache': 'HIT',
      },
      body: Buffer.from(responseBody),
      contentType: this.headerValue(proxyResult.headers['content-type']),
      contentLength: responseBody.byteLength,
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
    if (entry.headerPolicyIdentity) {
      res.removeHeader('transfer-encoding');
      res.removeHeader('content-length');
      if (entry.statusCode !== 204) res.setHeader('content-length', entry.body.byteLength);
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
    headerRequest?: GatewayHeaderCacheRequest,
  ) {
    if (!this.isEligible(resolvedRoute, req)) {
      return null;
    }

    const consumer = this.resolveCacheIdentity(resolvedRoute, authContext);
    if (!consumer) {
      return null;
    }

    const policy = resolvedRoute.policies.upstream?.compiledHeaderPolicy;
    if (policy && (!headerRequest || headerRequest.cacheBypass || headerRequest.chunked ||
      (headerRequest.contentLength ?? 0) !== 0 || req.method.toUpperCase() !== 'GET' ||
      resolvedRoute.routeBinding.upstreamMethod.toUpperCase() !== 'GET')) return null;
    const originalUrl = String(req.originalUrl || req.url || '');
    const url = new URL(originalUrl, 'http://gateway.local');
    const varyQueryKeys = resolvedRoute.policies.cache.varyQueryKeys;
    const varyHeaderKeys = resolvedRoute.policies.cache.varyHeaderKeys;
    const secretQuery = resolvedRoute.policies.auth.apiKeyQueryParamName;
    if (secretQuery) url.searchParams.delete(secretQuery);
    const queryEntries = policy ? [...url.searchParams.entries()] : this.normalizeQueryEntries(url, varyQueryKeys);
    const headerEntries = policy ? this.v1VaryNames(resolvedRoute).map(name =>
      [name, Object.prototype.hasOwnProperty.call(headerRequest!.normalizedRequestHeaders, name)
        ? headerRequest!.normalizedRequestHeaders[name] : null]) : this.normalizeHeaderEntries(req, varyHeaderKeys);

    return JSON.stringify({
      headerPolicyIdentity: policy?.identity,
      credentialCacheIdentity: policy ? headerRequest?.credentialCacheIdentity : undefined,
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      routeBindingId: resolvedRoute.routeBinding.id,
      method: String(req.method || '').toUpperCase(),
      pathname: url.pathname,
      query: queryEntries,
      headers: headerEntries,
      consumer,
    });
  }

  private resolveCacheIdentity(
    resolvedRoute: GatewayResolvedRoute,
    authContext?: GatewayRequestAuthContext,
  ) {
    const configuredMode = resolvedRoute.policies?.auth?.mode;
    if (configuredMode !== 'jwt' && configuredMode !== 'api_key' && configuredMode !== 'anonymous') {
      return null;
    }
    const visibility = String(resolvedRoute.routeBinding.routeVisibility || 'internal').trim().toLowerCase();
    const mode = configuredMode === 'anonymous' && visibility !== 'external' ? 'jwt' : configuredMode;
    if (!authContext || authContext.mode !== mode) {
      return null;
    }
    if (mode === 'anonymous') {
      return { mode };
    }
    if (mode === 'api_key') {
      if (!this.isIdentity(authContext.consumerId) || !this.isIdentity(authContext.keyId)) {
        return null;
      }
      return { mode, consumerId: authContext.consumerId, keyId: authContext.keyId };
    }
    const principal = authContext.principal;
    // Only the authorization service's verified principal is a JWT cache identity.
    // Request headers and legacy actor IDs must never supply an anonymous fallback.
    if (principal?.identitySource !== 'authenticated' || !this.isIdentity(principal.callerId) ||
      !Array.isArray(principal.scopes) || principal.scopes.some(scope => typeof scope !== 'string')) {
      return null;
    }
    return {
      mode,
      callerId: principal.callerId,
      issuer: principal.issuer,
      subject: principal.subject,
      clientId: principal.clientId,
      credentialId: principal.credentialId,
      scopes: [...new Set(principal.scopes)].sort(),
    };
  }

  private isIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isEligible(resolvedRoute: GatewayResolvedRoute, req: Request) {
    const method = String(req.method || '').toUpperCase();
    if (!resolvedRoute.policies.cache.enabled) {
      return false;
    }
    return resolvedRoute.policies.cache.methods.includes(method);
  }

  private shouldStore(resolvedRoute: GatewayResolvedRoute, proxyResult: GatewayProxyResult, headerRequest?: GatewayHeaderCacheRequest) {
    const policy = resolvedRoute.policies.upstream?.compiledHeaderPolicy;
    if (policy) {
      const signals = proxyResult.headerCacheSignals;
      if (!headerRequest || !signals || signals.credentialCacheIdentity !== headerRequest.credentialCacheIdentity || signals.policyIdentity !== policy.identity || signals.setCookie || signals.pragma ||
        proxyResult.statusCode === 206 || (signals.contentType || "").toLowerCase().includes("text/event-stream") ||
        this.responseTtl(signals.cacheControl) === null) return false;
      if (signals.vary !== undefined) {
        const names = signals.vary.split(",").map(name => name.trim().toLowerCase());
        const covered = this.v1VaryNames(resolvedRoute);
        if (names.some(name => !name || !covered.includes(name))) return false;
      }
    }
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

  private v1VaryNames(route: GatewayResolvedRoute): string[] {
    const policy = route.policies.upstream.compiledHeaderPolicy!;
    // Configured vary is additive and may never include secret/proxy fields.
    return [...new Set(['accept', 'accept-language', 'accept-encoding', ...policy.requestExtensions,
      ...(route.policies.cache.varyHeaderKeys || []).map(name => name.toLowerCase())
        .filter(name => policy.requestHeaders.includes(name))])].sort();
  }

  /** null means unsafe or malformed; undefined means no explicit freshness bound. */
  private responseTtl(value?: string): number | null | undefined {
    if (value === undefined) return undefined;
    const directives = value.split(',');
    let ttl: number | undefined;
    const seen = new Set<string>();
    for (const part of directives) {
      const match = /^\s*([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([0-9]+)"|([0-9]+)))?\s*$/i.exec(part);
      if (!match) return null;
      const name = match[1].toLowerCase(), argument = match[2] ?? match[3];
      if (seen.has(name)) return null;
      seen.add(name);
      if (['max-age', 's-maxage', 'stale-while-revalidate', 'stale-if-error'].includes(name)) {
        if (argument === undefined || !Number.isSafeInteger(Number(argument))) return null;
        if (name === 'max-age' || name === 's-maxage') ttl = Math.min(ttl ?? Infinity, Number(argument) * 1000);
      } else if (!['public', 'must-revalidate', 'proxy-revalidate', 'immutable', 'no-transform'].includes(name) || argument !== undefined) return null;
    }
    return ttl;
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
