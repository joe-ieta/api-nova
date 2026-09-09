import { randomUUID } from 'node:crypto';
import {
  auditDigest, beginRuntimeCall, captureAuditBody, getRuntimeCallContext, withRuntimeCallContext,
  RuntimeCallContext, RuntimeCallRecord,
} from 'api-nova-parser';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

type Call = ReturnType<typeof beginRuntimeCall>;
type Pending = { protocol?: Call; tool?: Call; done: boolean };
const instrumented = new WeakSet<Transport>();
const health = { instrumentationFailures: 0, finalizeFailures: 0 };
export function getMcpTransportAuditHealth() { return { ...health }; }
function safely<T>(operation: () => T): T | undefined {
  try { return operation(); } catch { health.instrumentationFailures++; return undefined; }
}
function finish(entry: Pending, fields: Partial<RuntimeCallRecord>,
  protocolResponse?: RuntimeCallRecord['response'], toolResponse?: RuntimeCallRecord['response']) {
  if (entry.done) return;
  entry.done = true;
  for (const [call, response] of [[entry.tool, toolResponse], [entry.protocol, protocolResponse]] as const) {
    safely(() => {
      if (call) void call.finish({ ...fields, response }).catch(() => { health.finalizeFailures++; });
    });
  }
}

/** HTTP supplies the protocol parent; STDIO/programmatic requests create their own. */
export function instrumentMcpTransport(transport: Transport): void {
  if (instrumented.has(transport)) return;
  instrumented.add(transport);
  const receive = transport.onmessage;
  const send = transport.send.bind(transport);
  const close = transport.onclose;
  const pending = new Map<string | number, Pending>();
  const inFlight = new Set<Pending>();
  const localSessionId = randomUUID();
  transport.onmessage = (message, extra) => {
    if (!('method' in message)) { receive?.(message, extra); return; }
    const inherited = getRuntimeCallContext();
    const context: RuntimeCallContext = {
      ...inherited, transport: 'mcp', requestId: inherited?.requestId || randomUUID(),
      identitySource: inherited?.identitySource || 'anonymous',
      protocolTransport: inherited?.protocolTransport || 'stdio',
      sessionIdHash: inherited?.sessionIdHash || auditDigest(transport.sessionId || localSessionId),
      byteMeasurement: 'serialized_payload', measurementStage: 'logical_payload',
    };
    const entry: Pending = { done: false };
    const hasHttpParent = inherited?.spanKind === 'mcp_protocol' && !!inherited.parentInvocationId;
    if (!hasHttpParent) {
      const start = { ...context, method: message.method, request: safely(() => captureAuditBody(message)) };
      entry.protocol = safely(() => beginRuntimeCall(start, 'admission'));
    }
    const parentContext: RuntimeCallContext = {
      ...context, traceId: entry.protocol?.record.traceId || context.traceId,
      rootInvocationId: entry.protocol?.record.rootInvocationId || context.rootInvocationId,
      parentInvocationId: entry.protocol?.record.invocationId || context.parentInvocationId,
    };
    if (message.method === 'tools/call' && 'id' in message) {
      entry.tool = safely(() => beginRuntimeCall({
        ...parentContext, toolName: String(message.params?.name || ''),
      }, 'tool'));
      if (entry.tool) entry.tool.record.request = safely(() => captureAuditBody(message.params));
    }
    if (!entry.protocol && !entry.tool) { receive?.(message, extra); return; }
    if ('id' in message && (pending.has(message.id) || pending.size >= 128)) {
      inFlight.add(entry);
      const rejection = { jsonrpc: '2.0' as const, id: message.id,
        error: { code: -32000, message: 'Concurrent call limit exceeded' } };
      void Promise.resolve().then(() => send(rejection)).then(
        () => finish(entry, { outcome: 'error', errorCategory: 'protocol', errorCode: 'MCP_CONCURRENT_CALL_LIMIT',
          protocolErrorCode: -32000 }, safely(() => captureAuditBody(rejection)), safely(() => captureAuditBody(rejection.error))),
        () => finish(entry, { outcome: 'error', errorCategory: 'connection', errorCode: 'MCP_SEND_FAILED', failureStage: 'protocol_send' }),
      ).finally(() => inFlight.delete(entry));
      return;
    }
    if ('id' in message) pending.set(message.id, entry);
    inFlight.add(entry);
    const childContext: RuntimeCallContext = {
      ...parentContext, parentInvocationId: entry.tool?.record.invocationId || parentContext.parentInvocationId,
      toolName: entry.tool?.record.toolName,
    };
    try {
      withRuntimeCallContext(childContext, () => receive?.(message, extra));
      // A notification has no response ACK; dispatch is not evidence of business success.
      if (!('id' in message)) { finish(entry, { outcome: 'unknown' }); inFlight.delete(entry); }
    } catch (error) {
      if ('id' in message && pending.get(message.id) === entry) pending.delete(message.id);
      inFlight.delete(entry);
      finish(entry, { outcome: 'error', errorCategory: 'other', errorCode: 'MCP_DISPATCH_FAILED', failureStage: 'dispatch' });
      throw error;
    }
  };
  transport.send = async (message, options) => {
    const id = 'id' in message && !('method' in message) ? message.id : undefined;
    const entry = id !== undefined && id !== null ? pending.get(id) : undefined;
    if (!entry) return send(message, options);
    const protocolResponse = safely(() => captureAuditBody(message));
    const toolResponse = safely(() => captureAuditBody('result' in message ? message.result : 'error' in message ? message.error : undefined));
    try {
      const result = await send(message, options);
      const toolIsError = 'result' in message && message.result?.isError === true;
      finish(entry, { outcome: 'error' in message || toolIsError ? 'error' : 'success',
        toolIsError: entry.tool ? toolIsError : undefined,
        protocolErrorCode: 'error' in message ? message.error.code : undefined,
        errorCategory: 'error' in message ? 'protocol' : toolIsError ? 'tool' : undefined,
      }, protocolResponse, toolResponse);
      return result;
    } catch (error) {
      const incomplete = (body: RuntimeCallRecord['response']) => body
        ? { ...body, state: 'incomplete' as const, reason: 'protocol_send_failed', data: undefined, capturedBytes: 0 } : undefined;
      finish(entry, { outcome: 'error', errorCategory: 'connection', errorCode: 'MCP_SEND_FAILED',
        failureStage: 'protocol_send' }, incomplete(protocolResponse), incomplete(toolResponse));
      throw error;
    } finally {
      if (pending.get(id as string | number) === entry) pending.delete(id as string | number);
      inFlight.delete(entry);
    }
  };
  transport.onclose = () => {
    for (const entry of inFlight) finish(entry, {
      outcome: 'cancelled', errorCategory: 'cancelled', errorCode: 'MCP_SESSION_CLOSED', failureStage: 'protocol_send',
    });
    inFlight.clear();
    pending.clear();
    close?.();
  };
}
