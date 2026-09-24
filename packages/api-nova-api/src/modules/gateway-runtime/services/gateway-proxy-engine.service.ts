import { GATEWAY_TRUSTED_NETWORK_PROVIDER, assertGatewayTrustedNetworkProvider, type GatewayTrustedNetworkProvider, type GatewayNetworkLease } from './gateway-trusted-network.provider';
import { forwardGatewayNetworkStream } from './gateway-network-stream';
import { GatewayUpstreamSecurityRuntimeGuard, assertGatewayUpstreamDeclaration } from './gateway-upstream-security-runtime.guard';
import {
  BadGatewayException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  HttpException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { PassThrough, Transform } from 'node:stream';
import { URL } from 'node:url';
import { resolveRuntimeCredentialRefHeaders, runRuntimeUpstreamAttempt, type CompiledHeaderPolicyV1 } from 'api-nova-parser';
import { filterGatewayRequestHeadersV1, filterGatewayResponseHeadersV1, GatewayHeaderWireError } from './gateway-header-wire-policy';
import { ensureGatewayRequestId, gatewayAuditContext } from './gateway-audit-context';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayHeaderCacheRequest } from '../types/gateway-cache.types';
import { GatewayProxyResult } from '../types/gateway-proxy.types';
import {
  GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER,
  type GatewayUpstreamCredentialHeaders,
  type GatewayUpstreamCredentialResolver,
} from './gateway-upstream-credential-resolver';

export type GatewayPreparedProxyRequest = {
  networkLease?: GatewayNetworkLease;
  url: URL;
  credentials: GatewayUpstreamCredentialHeaders;
  compiledHeaderPolicy?: CompiledHeaderPolicyV1;
  historicalAuthenticationHeaderNames?: readonly string[];
  requestPolicy?: ReturnType<typeof filterGatewayRequestHeadersV1> & GatewayHeaderCacheRequest;
};

@Injectable()
export class GatewayProxyEngineService {
  private readonly preparations = new WeakMap<GatewayPreparedProxyRequest, { request: Request; route: string; url: string; detach?: () => void; resolver?: GatewayUpstreamCredentialResolver; used: boolean }>();
  constructor(
    private readonly gatewayRequestCaptureService: GatewayRequestCaptureService,
    @Optional()
    @Inject(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER)
    private readonly upstreamCredentialResolver?: GatewayUpstreamCredentialResolver,
    @Optional() private readonly gatewayRuntimeMetricsService?: GatewayRuntimeMetricsService,
    @Optional() private readonly upstreamSecurityGuard?: GatewayUpstreamSecurityRuntimeGuard,
    @Optional() @Inject(GATEWAY_TRUSTED_NETWORK_PROVIDER) private readonly networkProvider?: GatewayTrustedNetworkProvider,
  ) { if (networkProvider) assertGatewayTrustedNetworkProvider(networkProvider); }

  async forward(
    resolvedRoute: GatewayResolvedRoute, req: Request, res: Response,
    options?: { captureResponseBodyMaxBytes?: number; attemptIndex?: number; upstreamOperationId?: string; preparedRequest?: GatewayPreparedProxyRequest },
  ): Promise<GatewayProxyResult & { targetUrl: string }> {
    const prior = options?.preparedRequest;
    if (prior) {
      const ownership = this.preparations.get(prior);
      ownership?.detach?.();
      if (!ownership || ownership.used || ownership.request !== req || ownership.route !== this.preparationRoute(resolvedRoute) || ownership.resolver !== this.upstreamCredentialResolver || ownership.url !== prior.url.href) {
        if (prior.networkLease) this.networkProvider?.close(prior.networkLease);
        throw new ServiceUnavailableException('gateway_prepared_request_reused');
      }
      ownership.used = true;
    }
    // Network leases already pin one authorized operation; legacy cache paths retain their fresh re-resolution.
    const current = prior?.networkLease ? prior : await this.prepareRequest(resolvedRoute, req);
    this.preparations.get(current)!.used = true;
    this.preparations.get(current)!.detach?.();
    if (prior && (prior.url.href !== current.url.href ||
      prior.credentials.cacheIdentity !== current.credentials.cacheIdentity ||
      JSON.stringify(prior.credentials.headers) !== JSON.stringify(current.credentials.headers))) {
      throw new ServiceUnavailableException('gateway_upstream_security_context_changed');
    }
    const { url, credentials, requestPolicy, compiledHeaderPolicy: policy, historicalAuthenticationHeaderNames } = current;
    if (current.networkLease) return forwardGatewayNetworkStream(this.networkProvider!, current, resolvedRoute, req, res, this.gatewayRequestCaptureService, {
      attemptIndex: options?.attemptIndex, upstreamOperationId: options?.upstreamOperationId,
      discardedTrailers: direction => this.auditDiscardedTrailers(resolvedRoute, req, direction),
    });
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs = resolvedRoute.policies?.traffic?.timeoutMs ?? resolvedRoute.routeBinding.timeoutMs ?? 30000;
    // Rebuild framing from the validated exchange, never from the raw TE value.
    // Node does not default to chunked encoding for GET/HEAD, even when piped bytes exist.
    const headers = requestPolicy ? { ...requestPolicy.headers,
      ...(requestPolicy.chunked ? { 'transfer-encoding': 'chunked' } : {}) }
      : this.buildForwardHeaders(req.headers, url, req, credentials.headers, credentials.managedHeaderNames);
    const requestCapture = this.gatewayRequestCaptureService.createTracker(req.headers['content-type']);
    let upstreamReq: http.ClientRequest | undefined;
    let upstreamRes: http.IncomingMessage | undefined;
    let requestTap: Transform | undefined;
    let responseTap: Transform | undefined;
    let rejectAttempt: ((error: Error) => void) | undefined;
    let rejectClient: (error: Error) => void = () => undefined;
    let clientFinished: () => void = () => undefined;
    const cancellation = () => Object.assign(new BadGatewayException('Client disconnected'), { code: 'ABORT_ERR' });
    const onCancelled = () => {
      const error = cancellation();
      rejectAttempt?.(error);
      rejectClient(error);
      upstreamReq?.destroy();
      upstreamRes?.destroy();
      requestTap?.destroy();
      responseTap?.destroy();
    };
    const onClientClose = () => { if (!res.writableFinished) onCancelled(); };
    const clientCompletion = new Promise<void>((resolve, reject) => {
      rejectClient = reject;
      clientFinished = resolve;
      res.once('finish', clientFinished);
      res.once('close', onClientClose);
      res.once('error', onCancelled);
      req.once('aborted', onCancelled);
      req.once('error', onCancelled);
    });
    const upstream = runRuntimeUpstreamAttempt({
      context: { ...gatewayAuditContext(req, this.ensureRequestId(req), resolvedRoute),
        upstreamOperationId: options?.upstreamOperationId },
      method: resolvedRoute.routeBinding.upstreamMethod, url: url.toString(),
      attemptIndex: options?.attemptIndex ?? 1, redirectHopIndex: 0,
      requestHeaders: headers, requestContentType: String(req.headers['content-type'] || ''),
      credentialHeaderNames: [...credentials.credentialHeaderNames],
    }, observer => new Promise<GatewayProxyResult & { targetUrl: string }>((resolve, reject) => {
      let settled = false;
      let requestFinished = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(this.mapWireError(error));
      };
      rejectAttempt = fail;
      if (req.aborted || res.destroyed) { fail(cancellation()); return; }
      upstreamReq = transport.request({
        // A v1 exchange owns its connection; unread parser suffixes must not reach a later request.
        ...(policy ? { agent: false as const } : {}),
        protocol: url.protocol, hostname: url.hostname, port: url.port,
        method: resolvedRoute.routeBinding.upstreamMethod, path: url.pathname + url.search, headers,
      }, response => {
        if (settled) { response.destroy(); return; }
        if (policy && !requestFinished) {
          fail(new GatewayHeaderWireError(502, 'gateway_header_early_response')); response.destroy(); return;
        }
        upstreamRes = response;
        const responseCapture = this.gatewayRequestCaptureService.createTracker(response.headers['content-type']);
        let responsePolicy: ReturnType<typeof filterGatewayResponseHeadersV1> | undefined;
        try {
          if (policy) responsePolicy = filterGatewayResponseHeadersV1({
            policy, rawHeaders: response.rawHeaders, headers: response.headers,
            statusCode: response.statusCode || 502, requestMethod: resolvedRoute.routeBinding.upstreamMethod,
            managedHeaderNames: credentials.managedHeaderNames,
            consumerAuthenticationHeaderNames: resolvedRoute.policies.upstream?.consumerAuthenticationHeaderNames,
            historicalAuthenticationHeaderNames,
          });
        } catch (error) { fail(error as Error); response.destroy(); return; }
        const normalizedHeaders = responsePolicy?.headers ?? this.normalizeResponseHeaders(response.headers);
        responseTap = responsePolicy
          ? this.checkedBodyStream(responsePolicy.bodyAllowed ? responsePolicy.contentLength : undefined, 502, !responsePolicy.bodyAllowed)
          : new PassThrough();
        responseTap.once('error', fail);
        const responseBodyChunks: Buffer[] = [];
        let responseBodyBytes = 0, overflow = false;
        observer.responseStarted(response.statusCode || 502, normalizedHeaders, String(response.headers['content-type'] || ''));
        const interrupted = () => fail(Object.assign(new BadGatewayException('Upstream response interrupted'), { code: 'ECONNRESET' }));
        response.once('error', error => fail(Object.assign(new BadGatewayException('Upstream response failed'),
          { code: (error as NodeJS.ErrnoException).code || 'ECONNRESET' })));
        response.once('aborted', interrupted);
        response.once('close', () => { if (!response.complete) interrupted(); });
        responseTap.on('data', chunk => {
          observer.responseChunk(chunk);
          responseCapture.observeChunk(chunk);
          if (overflow || !options?.captureResponseBodyMaxBytes || options.captureResponseBodyMaxBytes <= 0) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (responseBodyBytes + buffer.length > options.captureResponseBodyMaxBytes) {
            overflow = true;
            responseBodyChunks.length = 0;
            return;
          }
          responseBodyChunks.push(buffer);
          responseBodyBytes += buffer.length;
        });
        responseTap.once('end', () => {
          if (policy && response.rawTrailers.length) this.auditDiscardedTrailers(resolvedRoute, req, 'response');
          observer.responseComplete();
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode || 502, headers: normalizedHeaders,
            headerCacheSignals: responsePolicy ? { ...responsePolicy.cacheSignals, policyIdentity: policy!.identity, credentialCacheIdentity: requestPolicy?.credentialCacheIdentity } : undefined,
            requestCapture: requestCapture.finalize(), responseCapture: responseCapture.finalize(),
            responseBodyBuffer: options?.captureResponseBodyMaxBytes && !overflow
              ? Buffer.concat(responseBodyChunks) : undefined,
            targetUrl: url.toString(),
          });
        });
        try {
          res.status(response.statusCode || 502);
          for (const [key, value] of Object.entries(normalizedHeaders)) {
            if (value !== undefined) res.setHeader(key, value);
          }
          res.setHeader('x-request-id', this.ensureRequestId(req, res));
          res.flushHeaders?.();
          response.pipe(responseTap).pipe(res);
        } catch (error) { fail(error as Error); }
      });
      if (policy) {
        upstreamReq.on('information', () => fail(new GatewayHeaderWireError(502, 'gateway_header_response_status')));
        upstreamReq.on('upgrade', (_response, socket) => {
          socket.destroy(); fail(new GatewayHeaderWireError(502, 'gateway_header_upgrade_unsupported'));
        });
      }
      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq?.destroy(new GatewayTimeoutException('Gateway upstream timeout'));
      });
      upstreamReq.once('finish', () => { requestFinished = true; observer.requestComplete(); });
      upstreamReq.on('error', error => {
        if (error instanceof GatewayTimeoutException) { fail(error); return; }
        const code = (error as NodeJS.ErrnoException).code;
        if (policy && code?.startsWith('HPE_')) { fail(new GatewayHeaderWireError(502, 'gateway_header_upstream_parse')); return; }
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
          fail(Object.assign(new BadGatewayException('Gateway upstream connection failed'), { code }));
        } else fail(error);
      });
      requestTap = requestPolicy ? this.checkedBodyStream(requestPolicy.contentLength, 400) : new PassThrough();
      requestTap.on('data', chunk => {
        requestCapture.observeChunk(chunk);
        observer.requestChunk(chunk);
      });
      requestTap.once('error', fail);
      if (policy) requestTap.once('end', () => {
        if (req.rawTrailers?.length) this.auditDiscardedTrailers(resolvedRoute, req, 'request');
      });
      // Only empty-body retries are permitted by the runtime service.
      requestTap.pipe(upstreamReq);
      if (req.readableEnded) requestTap.end();
      else req.pipe(requestTap);
    }));
    try {
      // An upstream completion and a successful client send are separate facts.
      const [result] = await Promise.all([upstream, clientCompletion]);
      return result;
    } catch (error) {
      upstreamReq?.destroy();
      upstreamRes?.destroy();
      requestTap?.destroy();
      responseTap?.destroy();
      if (res.headersSent && !res.writableFinished && !res.destroyed) res.destroy();
      throw this.mapWireError(error);
    } finally {
      res.removeListener('finish', clientFinished);
      res.removeListener('close', onClientClose);
      res.removeListener('error', onCancelled);
      req.removeListener('aborted', onCancelled);
      req.removeListener('error', onCancelled);
      if (requestTap) req.unpipe(requestTap);
    }
  }

  requiresPreparation(route: GatewayResolvedRoute): boolean {
    return Boolean(this.networkProvider?.requires(route) || this.upstreamSecurityGuard || route.policies?.upstream?.compiledHeaderPolicy || this.upstreamCredentialResolver?.headerPolicyEnabled);
  }

  /** Validate current declaration and credentials before every cache lookup. */
  async prepareRequest(resolvedRoute: GatewayResolvedRoute, req: Request): Promise<GatewayPreparedProxyRequest> {
    const deadline = Date.now() + (resolvedRoute.policies?.traffic?.timeoutMs ?? resolvedRoute.routeBinding.timeoutMs ?? 30000);
    assertGatewayUpstreamDeclaration(resolvedRoute.endpointDefinition);
    await this.upstreamSecurityGuard?.assertCurrent(resolvedRoute);
    const url = new URL(this.buildTargetUrl(resolvedRoute.upstreamBaseUrl,
      resolvedRoute.routeBinding.upstreamPath, req.originalUrl, resolvedRoute.params));
    const consumerQueryKey = resolvedRoute.policies?.auth?.apiKeyQueryParamName;
    if (consumerQueryKey) url.searchParams.delete(consumerQueryKey);
    const usesNetwork = this.networkProvider?.requires(resolvedRoute) ?? false;
    const controller = new AbortController();
    let networkLease: GatewayNetworkLease | undefined;
    let keepCancellation = false;
    const detach = () => { if (!usesNetwork) return; req.removeListener('aborted', cancel); req.removeListener('error', cancel); req.res?.removeListener('close', cancel); req.res?.removeListener('finish', cancel); };
    const cancel = () => { controller.abort(); if (networkLease) this.networkProvider?.close(networkLease); detach(); };
    if (usesNetwork) { req.once('aborted', cancel); req.once('error', cancel); req.res?.once('close', cancel); req.res?.once('finish', cancel); }
    if (req.aborted || req.destroyed) cancel();
    try {
      const network = usesNetwork ? await this.networkProvider!.prepare(resolvedRoute, url.href,
        () => this.resolveCredentialHeaders(resolvedRoute, url), { deadline, signal: controller.signal }) : undefined;
      networkLease = network?.lease;
      const credentials = network?.credentials ?? await this.resolveCredentialHeaders(resolvedRoute, url);
      const routePolicy = resolvedRoute.policies?.upstream?.compiledHeaderPolicy;
      if (routePolicy && credentials.compiledHeaderPolicy) {
        throw new ServiceUnavailableException('gateway_header_policy_source_conflict');
      }
      const policy = credentials.compiledHeaderPolicy ?? routePolicy;
      const historicalAuthenticationHeaderNames = Object.freeze([...new Set([
        ...resolvedRoute.policies?.upstream?.historicalAuthenticationHeaderNames ?? [],
        ...credentials.historicalAuthenticationHeaderNames ?? [],
      ])]);
      let requestPolicy: GatewayPreparedProxyRequest['requestPolicy'];
      try {
        if (policy) requestPolicy = filterGatewayRequestHeadersV1({
          policy, rawHeaders: req.rawHeaders, headers: req.headers, targetUrl: url,
          peerAddress: req.socket?.remoteAddress, tls: (req.socket as any)?.encrypted === true,
          requestId: this.ensureRequestId(req), managedHeaderNames: credentials.managedHeaderNames,
          credentialHeaders: { ...credentials.headers },
          consumerAuthenticationHeaderNames: resolvedRoute.policies.upstream?.consumerAuthenticationHeaderNames,
          historicalAuthenticationHeaderNames,
        });
      } catch (error) { throw this.mapWireError(error); }
      if (requestPolicy) requestPolicy.credentialCacheIdentity = credentials.cacheIdentity;

      if (networkLease && requestPolicy) requestPolicy.cacheBypass = true;
      if (networkLease && requestPolicy) { Object.freeze(requestPolicy.headers); Object.freeze(requestPolicy); }
      const prepared = Object.freeze({ networkLease, url, credentials, requestPolicy, compiledHeaderPolicy: policy, historicalAuthenticationHeaderNames });
      keepCancellation = Boolean(networkLease);
      this.preparations.set(prepared, { detach, request: req, route: this.preparationRoute(resolvedRoute), url: url.href, resolver: this.upstreamCredentialResolver, used: false });
      return prepared;
    } catch (failure) { if (networkLease) this.networkProvider?.close(networkLease); throw failure; }
    finally { if (!keepCancellation) detach(); }
  }

  private preparationRoute(route: GatewayResolvedRoute): string {
    return JSON.stringify([route.runtimeAsset?.id, route.runtimeAsset?.updatedAt, route.runtimeAsset?.metadata,
      route.membership?.id, route.membership?.publicationRevision, route.membership?.updatedAt, route.endpointDefinition?.id, route.endpointDefinition?.updatedAt,
      route.sourceServiceAsset?.id, route.sourceServiceInstance?.id, route.sourceServiceInstance?.updatedAt,
      route.upstreamBaseUrl, route.routeBinding]);
  }

  private auditDiscardedTrailers(route: GatewayResolvedRoute, req: Request, direction: 'request' | 'response'): void {
    void this.gatewayRuntimeMetricsService?.recordPolicyObservabilityEvent({
      runtimeAssetId: route.runtimeAsset.id, runtimeMembershipId: route.membership.id,
      routePath: route.routeBinding.routePath, routeMethod: route.routeBinding.routeMethod,
      requestId: this.ensureRequestId(req), policyName: 'gateway.header_trailers_discarded',
      errorMessage: direction + '_trailers_discarded',
    }).catch(() => undefined);
  }

  private mapWireError(error: unknown): Error {
    return error instanceof GatewayHeaderWireError
      ? new HttpException(error.code, error.statusCode)
      : error as Error;
  }

  private checkedBodyStream(expected: number | undefined, status: number, forbidBody = false): Transform {
    let bytes = 0;
    return new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if ((forbidBody && bytes > 0) || (expected !== undefined && bytes > expected)) {
          callback(new GatewayHeaderWireError(status, 'gateway_header_body_length'));
        } else callback(null, buffer);
      },
      flush(callback) {
        callback(expected !== undefined && bytes !== expected
          ? new GatewayHeaderWireError(status, 'gateway_header_body_length') : undefined);
      },
    });
  }

  private async resolveCredentialHeaders(
    resolvedRoute: GatewayResolvedRoute,
    url: URL,
  ): Promise<GatewayUpstreamCredentialHeaders> {
    if (!this.upstreamCredentialResolver) {
      const headers = Object.freeze(resolveRuntimeCredentialRefHeaders(
        resolvedRoute.sourceServiceInstance.credentialRef,
      ));
      const names = Object.freeze(Object.keys(headers));
      return Object.freeze({ headers, credentialHeaderNames: names, managedHeaderNames: names });
    }
    try {
      return await this.upstreamCredentialResolver.resolve(resolvedRoute, url.toString(), resolvedRoute.routeBinding.upstreamMethod);
    } catch {
      throw new ServiceUnavailableException('gateway_upstream_credential_unavailable');
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

  private applyPathParams(pathTemplate: string, params: Record<string, string>) {
    const normalizedPath = pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`;
    return normalizedPath.replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (!(key in params)) {
        throw new BadGatewayException(`Missing path parameter '${key}' for upstream route`);
      }
      return encodeURIComponent(params[key]);
    });
  }

  private buildForwardHeaders(
    headers: Request['headers'],
    url: URL,
    req: Request,
    credentialHeadersOrRef?: Readonly<Record<string, string>> | string,
    managedHeaderNames: readonly string[] = [],
  ): Record<string, string> {
    const credentialHeaders = typeof credentialHeadersOrRef === 'string' || credentialHeadersOrRef === undefined
      ? resolveRuntimeCredentialRefHeaders(credentialHeadersOrRef)
      : credentialHeadersOrRef;
    const protectedCredentialNames = managedHeaderNames.length > 0
      ? managedHeaderNames
      : Object.keys(credentialHeaders);
    const nextHeaders: Record<string, string> = {};
    // Middleware/adapters may supply mixed-case keys even though native HTTP input
    // is lowercase. Every Connection field contributes to the removal set.
    const connectionTokens = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() === 'connection')
      .flatMap(([, value]) => Array.isArray(value) ? value : [value || ''])
      .flatMap(value => String(value).split(','))
      .map(header => header.trim().toLowerCase())
      .filter(Boolean);
    const ignoredHeaders = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'trailers',
      'transfer-encoding',
      'upgrade',
      'host',
      'authorization',
      'x-api-key',
      'cookie',
      // These fields have one authoritative value from the proxy generator.
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-for',
      'x-request-id',
      ...protectedCredentialNames.map(name => name.toLowerCase()),
      ...connectionTokens,
    ]);

    for (const [key, value] of Object.entries(headers)) {
      if (!value) {
        continue;
      }
      const normalizedKey = key.toLowerCase();
      if (ignoredHeaders.has(normalizedKey)) {
        continue;
      }
      nextHeaders[key] = Array.isArray(value) ? value.join(',') : String(value);
    }

    Object.assign(nextHeaders, credentialHeaders);
    nextHeaders.host = url.host;
    nextHeaders['x-forwarded-host'] = String(req.headers.host || '');
    nextHeaders['x-forwarded-proto'] = String(req.protocol || url.protocol.replace(':', ''));
    nextHeaders['x-forwarded-for'] = this.buildForwardedForHeader(req, !connectionTokens.includes('x-forwarded-for'));
    nextHeaders['x-request-id'] = this.ensureRequestId(req);

    return nextHeaders;
  }

  private buildForwardedForHeader(req: Request, preservePresented = true) {
    // Preserve the existing append policy, except Connection-nominated input must
    // not be reintroduced after hop-by-hop filtering. This chain is not trusted identity.
    const current = preservePresented ? req.headers['x-forwarded-for'] : undefined;
    const prior = Array.isArray(current) ? current.join(',') : String(current || '');
    const remoteAddress = req.socket.remoteAddress || '';
    return prior ? `${prior}, ${remoteAddress}` : remoteAddress;
  }

  private ensureRequestId(req: Request, res?: Response) {
    return ensureGatewayRequestId(req, res);
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
}
