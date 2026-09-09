import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { PassThrough } from 'node:stream';
import { URL } from 'node:url';
import { resolveRuntimeCredentialRefHeaders, runRuntimeUpstreamAttempt } from 'api-nova-parser';
import { ensureGatewayRequestId, gatewayAuditContext } from './gateway-audit-context';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayProxyResult } from '../types/gateway-proxy.types';

@Injectable()
export class GatewayProxyEngineService {
  constructor(
    private readonly gatewayRequestCaptureService: GatewayRequestCaptureService,
  ) {}

  async forward(
    resolvedRoute: GatewayResolvedRoute, req: Request, res: Response,
    options?: { captureResponseBodyMaxBytes?: number; attemptIndex?: number; upstreamOperationId?: string },
  ): Promise<GatewayProxyResult & { targetUrl: string }> {
    const url = new URL(this.buildTargetUrl(resolvedRoute.upstreamBaseUrl,
      resolvedRoute.routeBinding.upstreamPath, req.originalUrl, resolvedRoute.params));
    const consumerQueryKey = resolvedRoute.policies?.auth?.apiKeyQueryParamName;
    if (consumerQueryKey) url.searchParams.delete(consumerQueryKey);
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs = resolvedRoute.policies?.traffic?.timeoutMs ?? resolvedRoute.routeBinding.timeoutMs ?? 30000;
    const headers = this.buildForwardHeaders(req.headers, url, req, resolvedRoute.sourceServiceInstance.credentialRef);
    const requestCapture = this.gatewayRequestCaptureService.createTracker(req.headers['content-type']);
    let upstreamReq: http.ClientRequest | undefined;
    let upstreamRes: http.IncomingMessage | undefined;
    let requestTap: PassThrough | undefined;
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
      credentialHeaderNames: Object.keys(resolveRuntimeCredentialRefHeaders(resolvedRoute.sourceServiceInstance.credentialRef)),
    }, observer => new Promise<GatewayProxyResult & { targetUrl: string }>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      rejectAttempt = fail;
      if (req.aborted || res.destroyed) { fail(cancellation()); return; }
      upstreamReq = transport.request({
        protocol: url.protocol, hostname: url.hostname, port: url.port,
        method: resolvedRoute.routeBinding.upstreamMethod, path: url.pathname + url.search, headers,
      }, response => {
        upstreamRes = response;
        const responseCapture = this.gatewayRequestCaptureService.createTracker(response.headers['content-type']);
        const normalizedHeaders = this.normalizeResponseHeaders(response.headers);
        const responseBodyChunks: Buffer[] = [];
        let responseBodyBytes = 0, overflow = false;
        observer.responseStarted(response.statusCode || 502, normalizedHeaders, String(response.headers['content-type'] || ''));
        const interrupted = () => fail(Object.assign(new BadGatewayException('Upstream response interrupted'), { code: 'ECONNRESET' }));
        response.once('error', error => fail(Object.assign(new BadGatewayException('Upstream response failed'),
          { code: (error as NodeJS.ErrnoException).code || 'ECONNRESET' })));
        response.once('aborted', interrupted);
        response.once('close', () => { if (!response.complete) interrupted(); });
        response.on('data', chunk => {
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
        response.once('end', () => {
          observer.responseComplete();
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode || 502, headers: normalizedHeaders,
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
          response.pipe(res);
        } catch (error) { fail(error as Error); }
      });
      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq?.destroy(new GatewayTimeoutException('Gateway upstream timeout'));
      });
      upstreamReq.once('finish', () => observer.requestComplete());
      upstreamReq.on('error', error => {
        if (error instanceof GatewayTimeoutException) { fail(error); return; }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
          fail(Object.assign(new BadGatewayException('Gateway upstream connection failed'), { code }));
        } else fail(error);
      });
      requestTap = new PassThrough();
      requestTap.on('data', chunk => {
        requestCapture.observeChunk(chunk);
        observer.requestChunk(chunk);
      });
      requestTap.once('error', fail);
      // Only empty-body retries are permitted by the runtime service.
      if (req.readableEnded) upstreamReq.end();
      else req.pipe(requestTap).pipe(upstreamReq);
    }));
    try {
      // An upstream completion and a successful client send are separate facts.
      const [result] = await Promise.all([upstream, clientCompletion]);
      return result;
    } catch (error) {
      upstreamReq?.destroy();
      upstreamRes?.destroy();
      requestTap?.destroy();
      if (res.headersSent && !res.writableFinished && !res.destroyed) res.destroy();
      throw error;
    } finally {
      res.removeListener('finish', clientFinished);
      res.removeListener('close', onClientClose);
      res.removeListener('error', onCancelled);
      req.removeListener('aborted', onCancelled);
      req.removeListener('error', onCancelled);
      if (requestTap) req.unpipe(requestTap);
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
    credentialRef?: string,
  ): Record<string, string> {
    const nextHeaders: Record<string, string> = {};
    const ignoredHeaders = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'upgrade',
      'host',
      'authorization',
      'x-api-key',
      'cookie',
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

    Object.assign(nextHeaders, resolveRuntimeCredentialRefHeaders(credentialRef));
    nextHeaders.host = url.host;
    nextHeaders['x-forwarded-host'] = String(req.headers.host || '');
    nextHeaders['x-forwarded-proto'] = String(req.protocol || url.protocol.replace(':', ''));
    nextHeaders['x-forwarded-for'] = this.buildForwardedForHeader(req);
    nextHeaders['x-request-id'] = this.ensureRequestId(req);

    return nextHeaders;
  }

  private buildForwardedForHeader(req: Request) {
    const current = req.headers['x-forwarded-for'];
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
