import { Request, Response } from 'express';
import {
  RuntimeCallContext, RuntimeCallRecord, beginRuntimeCall, createAuditBodyTracker,
  getRuntimeCallContext, redactAuditHeaders, withRuntimeCallContext,
} from 'api-nova-parser';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { gatewayAuditContext, gatewayAuditUrl } from './gateway-audit-context';

type Tracker = ReturnType<typeof createAuditBodyTracker>;
export interface GatewayRequestAudit {
  run<T>(operation: () => T): T;
  authenticated(): void;
  failed(error: unknown): void;
  cacheHit(): void;
}
const audits = new WeakMap<Request, GatewayRequestAudit>();
const health = { instrumentationFailures: 0, finalizeFailures: 0 };
export function getGatewayRequestAuditHealth() { return { ...health }; }
function safe<T>(operation: () => T): T | undefined {
  try { return operation(); } catch { health.instrumentationFailures++; return undefined; }
}

/** Observe existing reads and writes without making IncomingMessage flow or replaying it. */
export function beginGatewayRequestAudit(
  req: Request, res: Response, requestId: string, route?: GatewayResolvedRoute, routePath?: string,
): GatewayRequestAudit {
  const existing = audits.get(req);
  if (existing) return existing;
  const inherited = getRuntimeCallContext();
  const context: RuntimeCallContext = {
    ...inherited, ...gatewayAuditContext(req, requestId, route),
    byteMeasurement: 'observed_body', measurementStage: 'gateway_http',
  };
  const startContext = {
    ...context, method: req.method, path: route?.routeBinding.routePath || routePath,
    url: gatewayAuditUrl(req, route), requestHeaders: redactAuditHeaders(req.headers),
  };
  const call = safe(() => beginRuntimeCall(startContext, 'admission'));
  let requestTracker = safe(() => createAuditBodyTracker(String(req.headers['content-type'] || '')));
  let responseTracker: Tracker | undefined;
  let requestSeen = false, requestEnded = false, responseSeen = false, finished = false, cacheHit = false;
  let failure: Partial<RuntimeCallRecord> = {};
  const originalEmit = req.emit;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const captureResponse = (chunk?: unknown, encoding?: unknown) => safe(() => {
    if (finished) return;
    responseSeen = true;
    responseTracker ||= createAuditBodyTracker(String(res.getHeader('content-type') || ''));
    // ServerResponse suppresses bodies for HEAD, 204 and 304.
    if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || chunk === undefined || chunk === null) return;
    if (typeof chunk === 'string') responseTracker.observe(Buffer.from(chunk,
      typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) responseTracker.observe(Buffer.from(chunk));
  });
  const wrappedEmit: typeof req.emit = function(event, ...args) {
    if (!finished) safe(() => {
      if (event === 'data') { requestSeen = true; requestTracker?.observe(args[0]); }
      if (event === 'end') { requestSeen = true; requestEnded = true; }
    });
    return originalEmit.call(this, event, ...args);
  };
  const wrappedWrite = function(this: Response, ...args: any[]) {
    captureResponse(args[0], args[1]);
    return (originalWrite as Function).apply(this, args);
  } as typeof res.write;
  const wrappedEnd = function(this: Response, ...args: any[]) {
    captureResponse(typeof args[0] === 'function' ? undefined : args[0], args[1]);
    return (originalEnd as Function).apply(this, args);
  } as typeof res.end;
  const cleanup = () => {
    if (req.emit === wrappedEmit) req.emit = originalEmit;
    if (res.write === wrappedWrite) res.write = originalWrite;
    if (res.end === wrappedEnd) res.end = originalEnd;
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
    res.removeListener('error', onError);
    req.removeListener('aborted', onAborted);
  };
  const finish = (complete: boolean) => {
    if (finished) return;
    if (complete && !responseSeen) captureResponse();
    finished = true;
    safe(cleanup);
    const request = safe(() => requestTracker?.finish(requestEnded));
    const response = safe(() => responseTracker?.finish(complete));
    requestTracker = undefined;
    responseTracker = undefined;
    const statusCode = res.headersSent || complete ? res.statusCode : undefined;
    const identity = safe(() => gatewayAuditContext(req, requestId, route)) || context;
    const fields: Partial<RuntimeCallRecord> = {
      ...identity, ...failure, cacheHit,
      statusCode,
      outcome: !complete ? (failure.outcome === 'error' || failure.outcome === 'timeout' ? 'incomplete' : 'cancelled')
        : failure.outcome || (statusCode && statusCode >= 400 ? 'error' : cacheHit ? 'cache_hit' : 'success'),
      errorCategory: !complete ? failure.errorCategory || 'cancelled'
        : failure.errorCategory || (statusCode && statusCode >= 400 ? 'http_status' : undefined),
      failureStage: !complete ? 'response' : failure.failureStage,
      request: requestSeen ? request : undefined, response: responseSeen ? response : undefined,
      responseHeaders: safe(() => redactAuditHeaders(res.getHeaders())),
    };
    safe(() => { if (call) void call.finish(fields).catch(() => { health.finalizeFailures++; }); });
  };
  const onFinish = () => finish(true);
  const onClose = () => { if (!res.writableFinished) finish(false); };
  const onError = () => finish(false);
  const onAborted = () => finish(false);
  const handle: GatewayRequestAudit = {
    run<T>(operation: () => T): T {
      const current = { ...context, ...gatewayAuditContext(req, requestId, route),
        traceId: call?.record.traceId || context.traceId,
        rootInvocationId: call?.record.rootInvocationId || context.rootInvocationId,
        parentInvocationId: call?.record.invocationId || context.parentInvocationId };
      return withRuntimeCallContext(current, operation);
    },
    authenticated() {
      safe(() => {
        if (finished || !call) return;
        const identity = gatewayAuditContext(req, requestId, route);
        Object.assign(call.record, identity);
        void call.progress(identity).catch(() => { health.finalizeFailures++; });
      });
    },
    failed(error) {
      safe(() => {
        if (finished) return;
        const value = error as { getStatus?: () => number; code?: string; name?: string };
        const status = typeof value?.getStatus === 'function' ? value.getStatus() : 500;
        const identity = gatewayAuditContext(req, requestId, route);
        const cancelled = req.aborted || /abort|cancel/i.test(String(value?.code || value?.name || ''));
        failure = {
          authState: identity.identitySource === 'authenticated' ? 'authenticated'
            : status === 401 || status === 403 ? 'authentication_failed' : identity.authState,
          outcome: cancelled ? 'cancelled' : status === 504 ? 'timeout' : 'error',
          errorCategory: cancelled ? 'cancelled' : status === 401 ? 'authentication'
            : status === 403 ? 'authorization' : status === 429 ? 'rate_limit'
              : status === 504 ? 'timeout' : status === 404 ? 'routing' : 'upstream',
          errorCode: cancelled ? 'GATEWAY_CANCELLED' : 'GATEWAY_HTTP_' + status,
          failureStage: status === 401 || status === 403 || status === 429 ? 'admission' : 'response',
        };
        if (call) Object.assign(call.record, identity, failure);
      });
    },
    cacheHit() { cacheHit = true; },
  };
  audits.set(req, handle);
  safe(() => {
    req.emit = wrappedEmit;
    res.write = wrappedWrite;
    res.end = wrappedEnd;
    res.once('finish', onFinish);
    res.once('close', onClose);
    res.once('error', onError);
    req.once('aborted', onAborted);
  });
  if (req.aborted || res.destroyed) finish(false);
  return handle;
}
