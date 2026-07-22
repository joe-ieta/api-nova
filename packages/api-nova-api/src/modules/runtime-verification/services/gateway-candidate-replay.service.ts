import { Injectable } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import { EndpointTestSampleEntity } from '../../../database/entities/endpoint-test-sample.entity';
import { GatewayRouteSnapshotService } from '../../gateway-runtime/services/gateway-route-snapshot.service';
import { GatewayRuntimeService } from '../../gateway-runtime/services/gateway-runtime.service';

type ReplayResponse = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  bodyBytes: number;
  truncated: boolean;
};

const MAX_RESPONSE_CAPTURE_BYTES = 1024 * 1024;

@Injectable()
export class GatewayCandidateReplayService {
  constructor(
    private readonly snapshotService: GatewayRouteSnapshotService,
    private readonly gatewayRuntimeService: GatewayRuntimeService,
  ) {}

  async replay(input: {
    candidateRevision: string;
    runtimeMembershipId: string;
    verificationRunId: string;
    sample: EndpointTestSampleEntity;
  }) {
    const entry = this.snapshotService.getCandidateRoute(
      input.candidateRevision,
      input.runtimeMembershipId,
    );
    if (!entry) {
      throw new Error(
        `Gateway candidate route for membership '${input.runtimeMembershipId}' was not found`,
      );
    }
    const parameters = this.objectPayload(input.sample.requestPayload);
    const routePath = this.applyPathParameters(entry.normalizedRoutePath, parameters);
    const method = String(entry.routeMethod || 'GET').toUpperCase();
    const query = ['GET', 'HEAD'].includes(method)
      ? this.buildQuery(parameters, entry.normalizedRoutePath)
      : '';
    const originalUrl = `${routePath}${query}`;
    const body = ['GET', 'HEAD'].includes(method)
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(input.sample.requestPayload ?? {}));
    const headers = this.buildHeaders(input.sample.requestHeaders, body, input.verificationRunId);
    const req = this.createRequest(method, originalUrl, headers, body);
    const response = this.createResponse();
    const target = this.snapshotService.resolveCandidate(
      input.candidateRevision,
      this.headerValue(headers.host),
      method,
      routePath,
    );
    if (!target) {
      throw new Error(`Gateway candidate route did not resolve for ${method} ${routePath}`);
    }
    const startedAt = Date.now();
    await this.gatewayRuntimeService.forwardResolvedRoute(
      target,
      req as any,
      response.stream as any,
      startedAt,
      { bypassCache: true },
    );
    const captured = await response.completed;
    return {
      statusCode: captured.statusCode,
      headers: captured.headers,
      body: this.parseBody(captured.body, captured.headers),
      bodyBytes: captured.bodyBytes,
      truncated: captured.truncated,
      durationMs: Date.now() - startedAt,
      routePath,
      method,
    };
  }

  private createRequest(
    method: string,
    originalUrl: string,
    headers: Record<string, string>,
    body: Buffer,
  ) {
    let sent = false;
    const req = new Readable({
      read() {
        if (sent) return;
        sent = true;
        if (body.length) this.push(body);
        this.push(null);
      },
    }) as any;
    req.method = method;
    req.url = originalUrl;
    req.originalUrl = originalUrl;
    req.headers = headers;
    req.ip = '127.0.0.1';
    req.socket = { remoteAddress: '127.0.0.1' };
    return req;
  }

  private createResponse() {
    const chunks: Buffer[] = [];
    const headers: Record<string, string | string[]> = {};
    let statusCode = 200;
    let bodyBytes = 0;
    let truncated = false;
    let resolveCompleted!: (value: ReplayResponse) => void;
    const completed = new Promise<ReplayResponse>(resolve => {
      resolveCompleted = resolve;
    });
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.byteLength;
        const capturedBytes = chunks.reduce((total, item) => total + item.byteLength, 0);
        const remaining = MAX_RESPONSE_CAPTURE_BYTES - capturedBytes;
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        if (buffer.byteLength > remaining) truncated = true;
        callback();
      },
    }) as any;
    stream.status = (value: number) => {
      statusCode = value;
      stream.statusCode = value;
      return stream;
    };
    stream.setHeader = (name: string, value: string | string[]) => {
      headers[name.toLowerCase()] = value;
      return stream;
    };
    stream.getHeader = (name: string) => headers[name.toLowerCase()];
    stream.getHeaders = () => ({ ...headers });
    stream.flushHeaders = () => undefined;
    stream.statusCode = statusCode;
    stream.on('finish', () => {
      resolveCompleted({
        statusCode,
        headers,
        body: Buffer.concat(chunks),
        bodyBytes,
        truncated,
      });
    });
    return { stream, completed };
  }

  private buildHeaders(
    input: Record<string, unknown> | undefined,
    body: Buffer,
    verificationRunId: string,
  ) {
    const headers: Record<string, string> = {
      host: 'candidate.gateway.internal',
      'x-api-nova-verification-run-id': verificationRunId,
      'x-request-id': `verify-${verificationRunId}-${Date.now()}`,
    };
    for (const [name, value] of Object.entries(input || {})) {
      if (value === undefined || value === null || String(value) === '[REDACTED]') continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    if (body.length) {
      headers['content-type'] ||= 'application/json';
      headers['content-length'] = String(body.length);
    }
    return headers;
  }

  private objectPayload(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }

  private applyPathParameters(template: string, parameters: Record<string, unknown>) {
    return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = parameters[name];
      if (value === undefined || value === null) {
        throw new Error(`Verification sample is missing path parameter '${name}'`);
      }
      return encodeURIComponent(String(value));
    });
  }

  private buildQuery(parameters: Record<string, unknown>, routeTemplate: string) {
    const pathNames = new Set(
      Array.from(routeTemplate.matchAll(/\{([^}]+)\}/g)).map(match => match[1]),
    );
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(parameters)) {
      if (pathNames.has(name) || value === undefined || value === null) continue;
      if (Array.isArray(value)) value.forEach(item => query.append(name, String(item)));
      else query.append(name, String(value));
    }
    const serialized = query.toString();
    return serialized ? `?${serialized}` : '';
  }

  private parseBody(body: Buffer, headers: Record<string, string | string[]>) {
    const contentType = this.headerValue(headers['content-type']) || '';
    const text = body.toString('utf8');
    if (contentType.includes('json') && text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  private headerValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
  }
}
