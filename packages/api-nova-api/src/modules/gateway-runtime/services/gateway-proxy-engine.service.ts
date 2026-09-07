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
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayProxyResult } from '../types/gateway-proxy.types';

@Injectable()
export class GatewayProxyEngineService {
  constructor(
    private readonly gatewayRequestCaptureService: GatewayRequestCaptureService,
  ) {}

  async forward(
    resolvedRoute: GatewayResolvedRoute,
    req: Request,
    res: Response,
    options?: {
      captureResponseBodyMaxBytes?: number;
    },
  ): Promise<GatewayProxyResult & { targetUrl: string }> {
    const targetUrl = this.buildTargetUrl(
      resolvedRoute.upstreamBaseUrl,
      resolvedRoute.routeBinding.upstreamPath,
      req.originalUrl,
      resolvedRoute.params,
    );
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs =
      resolvedRoute.policies?.traffic?.timeoutMs ??
      resolvedRoute.routeBinding.timeoutMs ??
      30000;
    const headers = this.buildForwardHeaders(req.headers, url, req);
    const requestCapture = this.gatewayRequestCaptureService.createTracker(
      req.headers['content-type'],
    );

    return new Promise<GatewayProxyResult & { targetUrl: string }>((resolve, reject) => {
      let settled = false;
      const finalizeResolve = (value: GatewayProxyResult & { targetUrl: string }) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const finalizeReject = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const upstreamReq = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          method: resolvedRoute.routeBinding.upstreamMethod,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        upstreamRes => {
          const responseCapture = this.gatewayRequestCaptureService.createTracker(
            upstreamRes.headers['content-type'] as string | string[] | undefined,
          );
          const responseTap = new PassThrough();
          const responseBodyChunks: Buffer[] = [];
          let responseBodyBytes = 0;
          let responseBodyOverflow = false;
          let responseCaptureFinalized = false;
          let finalizedResponseCapture = responseCapture.finalize();
          const normalizedHeaders = this.normalizeResponseHeaders(
            upstreamRes.headers as Record<string, unknown>,
          );
          res.status(upstreamRes.statusCode || 502);
          for (const [key, value] of Object.entries(normalizedHeaders)) {
            if (value === undefined) {
              continue;
            }
            res.setHeader(key, value as string | string[]);
          }
          res.setHeader('x-request-id', this.ensureRequestId(req, res));
          res.flushHeaders?.();

          upstreamRes.on('error', error => {
            finalizeReject(new BadGatewayException(error.message));
          });
          responseTap.on('data', chunk => {
            responseCapture.observeChunk(chunk);
            if (
              responseBodyOverflow ||
              !options?.captureResponseBodyMaxBytes ||
              options.captureResponseBodyMaxBytes <= 0
            ) {
              return;
            }

            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = options.captureResponseBodyMaxBytes - responseBodyBytes;
            if (buffer.byteLength > remaining) {
              responseBodyOverflow = true;
              responseBodyChunks.length = 0;
              return;
            }

            responseBodyChunks.push(buffer);
            responseBodyBytes += buffer.byteLength;
          });
          res.on('close', () => {
            if (!res.writableEnded) {
              upstreamRes.destroy();
              responseTap.destroy();
            }
          });
          res.on('finish', () => {
            if (!responseCaptureFinalized) {
              finalizedResponseCapture = responseCapture.finalize();
              responseCaptureFinalized = true;
            }
            finalizeResolve({
              statusCode: upstreamRes.statusCode || 502,
              headers: normalizedHeaders,
              requestCapture: requestCapture.finalize(),
              responseCapture: finalizedResponseCapture,
              responseBodyBuffer:
                options?.captureResponseBodyMaxBytes && !responseBodyOverflow
                  ? Buffer.concat(responseBodyChunks)
                  : undefined,
              targetUrl,
            });
          });
          responseTap.on('end', () => {
            finalizedResponseCapture = responseCapture.finalize();
            responseCaptureFinalized = true;
          });
          upstreamRes.pipe(responseTap).pipe(res);
        },
      );

      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq.destroy(
          new GatewayTimeoutException(`Gateway upstream timeout after ${timeoutMs}ms`),
        );
      });
      upstreamReq.on('error', error => {
        if (error instanceof GatewayTimeoutException) {
          finalizeReject(error);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
          finalizeReject(new BadGatewayException(error.message));
          return;
        }
        finalizeReject(error);
      });

      req.on('aborted', () => {
        upstreamReq.destroy();
        if (!settled) {
          finalizeReject(new BadGatewayException('Client aborted request'));
        }
      });
      const requestTap = new PassThrough();
      requestTap.on('data', chunk => {
        requestCapture.observeChunk(chunk);
      });

      req.pipe(requestTap).pipe(upstreamReq);
    });
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
    const existing = req.headers['x-request-id'];
    const requestId = Array.isArray(existing)
      ? existing[0]
      : existing || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (res && !res.headersSent) {
      res.setHeader('x-request-id', requestId);
    }
    return String(requestId);
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
