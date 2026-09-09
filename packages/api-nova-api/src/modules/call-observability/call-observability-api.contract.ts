import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { randomUUID } from 'crypto';

const ERRORS = {
  INVALID_QUERY: [400, 'Invalid query or request header'],
  CURSOR_SCOPE_MISMATCH: [400, 'Cursor does not match this query'],
  UNAUTHENTICATED: [401, 'A valid management access token is required'],
  FORBIDDEN: [403, 'Access is not permitted'],
  NOT_FOUND: [404, 'Resource not found'],
  IDEMPOTENCY_CONFLICT: [409, 'Idempotency key has different request content'],
  PAYLOAD_EXPIRED: [410, 'Payload retention has elapsed'],
  QUERY_CURSOR_EXPIRED: [410, 'Query cursor expired; obtain a new snapshot'],
  EVENT_CURSOR_EXPIRED: [410, 'Event cursor expired; obtain a new snapshot'],
  PRECONDITION_FAILED: [412, 'Resource version has changed'],
  QUERY_TOO_LARGE: [413, 'Query exceeds the supported size'],
  PRECONDITION_REQUIRED: [428, 'If-Match is required'],
  RATE_LIMITED: [429, 'Request rate limit exceeded'],
  OBSERVABILITY_UNAVAILABLE: [503, 'Observability is temporarily unavailable'],
} as const;

export type ObservabilityApiErrorCode = keyof typeof ERRORS;
export class ObservabilityApiError extends HttpException {
  constructor(readonly code: ObservabilityApiErrorCode, readonly field?: string,
    readonly resourceMetadata?: { state: 'expired'; expiredAt: string }) {
    super(ERRORS[code][1], ERRORS[code][0]);
  }
}

export const OBSERVABILITY_REQUEST_ID = Symbol('observability.requestId');

export class ObservabilityMetaDto {
  @ApiProperty({ example: '1.0' })
  schemaVersion: '1.0';

  @ApiPropertyOptional({ type: String })
  snapshotSeq?: string;

  @ApiPropertyOptional({ type: String })
  dataWatermark?: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  lagMs?: number | null;

  @ApiPropertyOptional()
  isPartial?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  historyCompleteSince?: string | null;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  gapRanges?: Array<{ from: string; to: string; reason: string }>;
}

export class ObservabilityErrorDto {
  @ApiProperty()
  code: string;
  @ApiProperty()
  message: string;
  @ApiProperty()
  requestId: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: false, properties: {
    field: { type: 'string' }, state: { type: 'string', enum: ['expired'] },
    expiredAt: { type: 'string', format: 'date-time' },
  } })
  details?: { field?: string; state?: 'expired'; expiredAt?: string };
}

export class ObservabilityErrorEnvelopeDto {
  @ApiProperty({ enum: ['error'] })
  status: 'error';
  @ApiProperty({ type: ObservabilityErrorDto })
  error: ObservabilityErrorDto;
}

export interface ObservabilityPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number | string;
}

export function observabilitySuccess<T>(data: T, meta: Omit<ObservabilityMetaDto, 'schemaVersion'> = {}) {
  return { status: 'success' as const, data, meta: { ...meta, schemaVersion: '1.0' as const } };
}

/** Local to opted-in observability routes; never echo driver errors or hidden resources. */
@Catch()
export class ObservabilityApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    if (response.headersSent) return;
    const mapped: Record<number, ObservabilityApiErrorCode> = {
      400: 'INVALID_QUERY', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
      404: 'NOT_FOUND', 413: 'QUERY_TOO_LARGE', 429: 'RATE_LIMITED',
    };
    const safe = error instanceof ObservabilityApiError ? error :
      new ObservabilityApiError(error instanceof HttpException ?
        mapped[error.getStatus()] || 'OBSERVABILITY_UNAVAILABLE' : 'OBSERVABILITY_UNAVAILABLE');
    const requestId = request[OBSERVABILITY_REQUEST_ID] || randomUUID();
    let details: ObservabilityErrorDto['details'] = safe.field && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(safe.field)
      ? { field: safe.field } : undefined;
    const metadata = safe.resourceMetadata;
    if (safe.code === 'PAYLOAD_EXPIRED' && metadata?.state === 'expired' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.expiredAt) &&
      Number.isFinite(Date.parse(metadata.expiredAt))) {
      details = { state: 'expired', expiredAt: metadata.expiredAt };
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(safe.getStatus()).json({
      status: 'error', error: { code: safe.code, message: ERRORS[safe.code][1], requestId, ...(details ? { details } : {}) },
    });
  }
}
