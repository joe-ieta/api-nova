import {
  AuditBody, RuntimeCallContext, RuntimeCallRecord, beginRuntimeCall, createAuditBodyTracker,
  getRuntimeCallContext, redactAuditHeaders, redactAuditUrl, withRuntimeCallContext,
} from './runtime-call-audit';

export interface RuntimeUpstreamAttempt {
  context: RuntimeCallContext;
  method: string;
  url: string;
  attemptIndex: number;
  redirectHopIndex?: number;
  requestHeaders?: Record<string, unknown>;
  requestContentType?: string;
  credentialHeaderNames?: string[];
}

/** Observe bytes already read/written by the HTTP client; never consume or replay a stream. */
export interface RuntimeUpstreamObserver {
  requestChunk(chunk: Buffer | string): void;
  requestComplete(): void;
  responseStarted(statusCode: number, headers?: Record<string, unknown>, contentType?: string): void;
  responseChunk(chunk: Buffer | string): void;
  responseComplete(): void;
}

const health = { attemptsStarted: 0, attemptsCompleted: 0, instrumentationFailures: 0, finalizeFailures: 0 };
export function getRuntimeUpstreamAuditHealth() { return { ...health }; }

function contentType(headers: Record<string, unknown>): string {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return typeof value === 'string' ? value : '';
}

function encoded(headers: Record<string, unknown>): boolean {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-encoding')?.[1];
  return value !== undefined && String(value).trim() !== '' && String(value).toLowerCase() !== 'identity';
}

function encodedBody(body: AuditBody | undefined, isEncoded: boolean): AuditBody | undefined {
  return body && isEncoded ? { ...body, state: body.state === 'incomplete' ? 'incomplete' : 'omitted',
    reason: 'encoded_body', data: undefined, capturedBytes: 0 } : body;
}

function failure(error: unknown): Pick<RuntimeCallRecord, 'outcome' | 'errorCategory' | 'errorCode'> {
  let value = '';
  try {
    const object = error as { name?: unknown; code?: unknown };
    value = [object?.name, object?.code].filter(item => typeof item === 'string').join(' ').toLowerCase();
  } catch { /* Hostile error getters must not replace the original business error. */ }
  if (/timeout|timedout/.test(value)) return { outcome: 'timeout', errorCategory: 'timeout', errorCode: 'UPSTREAM_TIMEOUT' };
  if (/abort|cancel/.test(value)) return { outcome: 'cancelled', errorCategory: 'cancelled', errorCode: 'UPSTREAM_CANCELLED' };
  const category = /enotfound|eai_again|dns/.test(value) ? 'dns'
    : /tls|cert_|certificate|ssl/.test(value) ? 'tls'
      : /econn|enet|ehost|socket/.test(value) ? 'connection' : 'other';
  return { outcome: 'error', errorCategory: category, errorCode: 'UPSTREAM_' + category.toUpperCase() + '_ERROR' };
}

/**
 * Exactly one callback invocation represents exactly one physical HTTP attempt.
 * The caller owns redirects/retries and must invoke this adapter separately for each.
 * Completion schedules audit persistence without awaiting filesystem latency.
 */
export async function runRuntimeUpstreamAttempt<T>(
  input: RuntimeUpstreamAttempt,
  execute: (observer: RuntimeUpstreamObserver) => Promise<T>,
): Promise<T> {
  health.attemptsStarted++;
  let call: ReturnType<typeof beginRuntimeCall> | undefined;
  let requestTracker: ReturnType<typeof createAuditBodyTracker> | undefined;
  let responseTracker: ReturnType<typeof createAuditBodyTracker> | undefined;
  let requestSeen = false, requestEnded = false, responseSeen = false, responseEnded = false, finalized = false;
  let statusCode: number | undefined;
  let responseHeaders: Record<string, unknown> | undefined;
  let requestEncoded = false, responseEncoded = false;
  let childContext: RuntimeCallContext | undefined;
  const safe = <V>(operation: () => V): V | undefined => {
    try { return operation(); } catch { health.instrumentationFailures++; return undefined; }
  };
  safe(() => {
    const inherited = getRuntimeCallContext();
    const context: RuntimeCallContext = {
      ...inherited, ...input.context,
      attemptIndex: Number.isSafeInteger(input.attemptIndex) && input.attemptIndex > 0 ? input.attemptIndex : undefined,
      redirectHopIndex: Number.isSafeInteger(input.redirectHopIndex ?? 0) && (input.redirectHopIndex ?? 0) >= 0
        ? input.redirectHopIndex ?? 0 : undefined,
      byteMeasurement: 'observed_body', measurementStage: 'upstream_http', spanKind: 'upstream_api',
    };
    const headers = input.requestHeaders || {};
    const startContext = {
      ...context, method: /^[A-Za-z]{1,20}$/.test(input.method) ? input.method.toUpperCase() : undefined,
      url: redactAuditUrl(input.url),
      requestHeaders: redactAuditHeaders(headers, input.credentialHeaderNames || []),
    };
    requestEncoded = encoded(headers);
    requestTracker = createAuditBodyTracker(input.requestContentType || contentType(headers), requestEncoded ? 0 : undefined);
    call = beginRuntimeCall(startContext, 'api');
    childContext = {
      ...context, traceId: call.record.traceId, rootInvocationId: call.record.rootInvocationId,
      parentInvocationId: call.record.invocationId, requestId: call.record.requestId,
    };
  });
  const observer: RuntimeUpstreamObserver = {
    requestChunk(chunk) { if (!finalized && !requestEnded) safe(() => { requestSeen = true; requestTracker?.observe(chunk); }); },
    requestComplete() { if (!finalized) { requestSeen = true; requestEnded = true; } },
    responseStarted(status, headers = {}, type) {
      if (finalized || responseSeen) return;
      safe(() => {
        if (!Number.isInteger(status) || status < 200 || status > 599) return;
        statusCode = status;
        responseHeaders = redactAuditHeaders(headers, input.credentialHeaderNames || []);
        responseEncoded = encoded(headers);
        responseTracker = createAuditBodyTracker(type || contentType(headers), responseEncoded ? 0 : undefined);
        responseSeen = true;
      });
    },
    responseChunk(chunk) {
      if (finalized || responseEnded) return;
      safe(() => {
        responseSeen = true;
        responseTracker ||= createAuditBodyTracker('');
        responseTracker.observe(chunk);
      });
    },
    responseComplete() {
      if (finalized) return;
      safe(() => {
        responseSeen = true; responseEnded = true;
        responseTracker ||= createAuditBodyTracker('');
      });
    },
  };
  let completion: Partial<RuntimeCallRecord> = {};
  try {
    const result = childContext
      ? await withRuntimeCallContext(childContext, () => execute(observer))
      : await execute(observer);
    completion = statusCode && statusCode >= 400
      ? { outcome: 'error', errorCategory: 'http_status', errorCode: 'UPSTREAM_HTTP_ERROR' }
      : !responseSeen || !statusCode ? { outcome: 'unknown' }
        : responseEnded ? { outcome: 'success' } : { outcome: 'incomplete', errorCategory: 'connection' };
    return result;
  } catch (error) {
    completion = { ...failure(error), failureStage: responseSeen ? 'response' : requestSeen ? 'request' : 'connect' };
    throw error;
  } finally {
    finalized = true;
    health.attemptsCompleted++;
    const requestBody = safe(() => requestTracker?.finish(requestEnded));
    const responseBody = safe(() => responseTracker?.finish(responseEnded));
    const request: AuditBody | undefined = requestSeen ? encodedBody(requestBody, requestEncoded) : undefined;
    const response: AuditBody | undefined = responseSeen ? encodedBody(responseBody, responseEncoded) : undefined;
    safe(() => {
      if (call) void call.finish({ ...completion, statusCode, responseHeaders, request, response })
        .catch(() => { health.finalizeFailures++; });
    });
  }
}
