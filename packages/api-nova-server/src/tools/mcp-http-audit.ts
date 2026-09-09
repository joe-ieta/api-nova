import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  beginRuntimeCall, createAuditBodyTracker, redactAuditHeaders, redactAuditUrl,
  RuntimeCallContext, RuntimeCallRecord,
} from 'api-nova-parser';

type Tracker = ReturnType<typeof createAuditBodyTracker>;
const health = { instrumentationFailures: 0, finalizeFailures: 0 };
export function getMcpHttpAuditHealth() { return { ...health }; }
function safely<T>(operation: () => T): T | undefined {
  try { return operation(); } catch { health.instrumentationFailures++; return undefined; }
}

/** Observes existing request data events; never drains an unauthenticated request. */
export function beginMcpHttpAudit(
  req: IncomingMessage, res: ServerResponse, requestId: string,
  protocolTransport: 'sse' | 'streamable', serverId?: string,
) {
  const presented = req.headers['x-request-id'];
  const client = Array.isArray(presented) ? presented[0] : presented;
  const peerIp = req.socket.remoteAddress;
  const context: RuntimeCallContext = {
    transport: 'mcp', requestId, protocolTransport, serverId,
    identitySource: 'anonymous', authState: 'unknown',
    clientRequestId: typeof client === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(client) ? client : undefined,
    peerIp, clientIp: peerIp, ipSource: peerIp ? 'peer' : 'unknown', proxyTrusted: false,
    byteMeasurement: 'observed_body', measurementStage: 'mcp_http',
  };
  const start = { ...context, method: req.method, url: redactAuditUrl('http://localhost' + (req.url || '/')),
    requestHeaders: redactAuditHeaders(req.headers) };
  const call = beginRuntimeCall(start, 'admission');
  let requestTracker = safely(() => createAuditBodyTracker(String(req.headers['content-type'] || '')));
  let responseTracker: Tracker | undefined;
  let requestSeen = false, requestEnded = false, responseSeen = false, done = false;
  let responseIsSse = false, partialResponse = false;
  let failure: Partial<RuntimeCallRecord> = {};
  let explicitHeaders: Record<string, unknown> = {};
  const emit = req.emit, write = res.write, end = res.end, writeHead = res.writeHead;
  const headers = () => ({ ...res.getHeaders(), ...explicitHeaders });
  const capture = (chunk?: unknown, encoding?: unknown) => safely(() => {
    if (done) return;
    responseSeen = true;
    if (!responseTracker) {
      const type = Object.entries(headers()).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
      const contentType = String(type || '');
      responseIsSse = contentType.toLowerCase().includes('text/event-stream');
      // Raw SSE framing can contain session endpoints. Logical Tool payloads are captured separately.
      responseTracker = responseIsSse ? createAuditBodyTracker(contentType, 0) : createAuditBodyTracker(contentType);
    }
    if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || chunk === undefined || chunk === null) return;
    if (typeof chunk === 'string') responseTracker.observe(Buffer.from(chunk,
      typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) responseTracker.observe(Buffer.from(chunk));
  });
  const wrappedEmit: typeof req.emit = function(this: IncomingMessage, event: string | symbol, ...args: any[]) {
    if (!done) safely(() => {
      if (event === 'data') { requestSeen = true; requestTracker?.observe(args[0]); }
      if (event === 'end') { requestSeen = true; requestEnded = true; }
    });
    return emit.call(this, event, ...args);
  };
  const wrappedHead = function(this: ServerResponse, ...args: any[]) {
    safely(() => {
      const supplied = typeof args[1] === 'string' ? args[2] : args[1];
      if (Array.isArray(supplied)) {
        for (let i = 0; i + 1 < supplied.length; i += 2) explicitHeaders[String(supplied[i]).toLowerCase()] = supplied[i + 1];
      } else if (supplied && typeof supplied === 'object') {
        for (const [key, value] of Object.entries(supplied)) explicitHeaders[key.toLowerCase()] = value;
      }
    });
    return (writeHead as Function).apply(this, args);
  } as typeof res.writeHead;
  const wrappedWrite = function(this: ServerResponse, ...args: any[]) {
    capture(args[0], args[1]);
    return (write as Function).apply(this, args);
  } as typeof res.write;
  const wrappedEnd = function(this: ServerResponse, ...args: any[]) {
    capture(typeof args[0] === 'function' ? undefined : args[0], args[1]);
    return (end as Function).apply(this, args);
  } as typeof res.end;
  const cleanup = () => {
    if (req.emit === wrappedEmit) req.emit = emit;
    if (res.write === wrappedWrite) res.write = write;
    if (res.end === wrappedEnd) res.end = end;
    if (res.writeHead === wrappedHead) res.writeHead = writeHead;
    req.removeListener('aborted', onAbort);
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
    res.removeListener('error', onError);
  };
  const finish = (complete: boolean) => {
    if (done) return;
    if (complete && !responseSeen) capture();
    done = true;
    safely(cleanup);
    const request = safely(() => requestTracker?.finish(requestEnded));
    let response = safely(() => responseTracker?.finish(complete && !partialResponse));
    requestTracker = undefined; responseTracker = undefined;
    if (responseIsSse && response) response = {
      ...response, state: complete && !partialResponse ? 'omitted' : 'incomplete',
      reason: 'sse_framing_not_captured', data: undefined, capturedBytes: 0,
    };
    let protocolErrorCode: number | undefined;
    if (complete && response?.data && response.contentType.toLowerCase().includes('json')) safely(() => {
      const message = JSON.parse(response.data!);
      if (message?.jsonrpc === '2.0' && Number.isInteger(message.error?.code)) protocolErrorCode = message.error.code;
    });
    const statusCode = res.headersSent || complete ? res.statusCode : undefined;
    const fields: Partial<RuntimeCallRecord> = {
      ...failure, statusCode, protocolErrorCode,
      outcome: failure.outcome || (!complete ? 'cancelled' : protocolErrorCode !== undefined || (statusCode && statusCode >= 400) ? 'error' : 'success'),
      errorCategory: failure.errorCategory || (!complete ? 'cancelled' : protocolErrorCode !== undefined ? 'protocol' : statusCode && statusCode >= 400 ? 'http_status' : undefined),
      request: requestSeen ? request : undefined, response: responseSeen ? response : undefined,
      responseHeaders: safely(() => redactAuditHeaders(headers())),
    };
    safely(() => { void call.finish(fields).catch(() => { health.finalizeFailures++; }); });
  };
  const onFinish = () => finish(true);
  const onClose = () => { if (!res.writableFinished) finish(false); };
  const onError = () => finish(false);
  const onAbort = () => finish(false);
  req.emit = wrappedEmit; res.write = wrappedWrite; res.end = wrappedEnd; res.writeHead = wrappedHead;
  req.once('aborted', onAbort); res.once('finish', onFinish); res.once('close', onClose); res.once('error', onError);
  return {
    record: call.record,
    authenticated(identity: RuntimeCallContext) {
      if (done) return;
      Object.assign(call.record, identity, {
        parentInvocationId: call.record.parentInvocationId,
        authState: identity.identitySource === 'authenticated' ? 'authenticated' : 'anonymous',
      });
      safely(() => { void call.progress().catch(() => { health.finalizeFailures++; }); });
    },
    failed(status: number, category: string, code: string) {
      if (done) return;
      partialResponse = res.headersSent;
      failure = {
        outcome: partialResponse ? 'incomplete' : 'error', errorCategory: category, errorCode: code,
        failureStage: partialResponse ? 'response' : 'admission',
        authState: call.record.authState === 'authenticated' ? 'authenticated'
          : category === 'authentication' ? 'authentication_failed' : call.record.authState,
      };
    },
    cancel(code: string) {
      if (done) return;
      partialResponse = true;
      failure = { outcome: 'cancelled', errorCategory: 'cancelled', errorCode: code, failureStage: 'response' };
    },
  };
}
