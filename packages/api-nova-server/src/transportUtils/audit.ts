import { randomUUID } from 'node:crypto';
import { auditDigest, beginRuntimeCall, captureAuditBody, getRuntimeCallContext,
  withRuntimeCallContext } from 'api-nova-parser';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Applied to every transport, including programmatic and legacy tool registration. */
export function instrumentMcpTransport(transport: Transport): void {
  const receive = transport.onmessage;
  const send = transport.send.bind(transport);
  const close = transport.onclose;
  const pending = new Map<string | number, ReturnType<typeof beginRuntimeCall>>();
  const localSessionId = randomUUID();
  transport.onmessage = (message, extra) => {
    if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) {
      receive?.(message, extra);
      return;
    }
    const context = getRuntimeCallContext() || { transport: 'mcp' as const, requestId: randomUUID(),
      identitySource: 'anonymous' as const, sessionIdHash: auditDigest(localSessionId) };
    const call = beginRuntimeCall({ ...context, toolName: String(message.params?.name || ''),
      sessionIdHash: context.sessionIdHash || auditDigest(transport.sessionId || localSessionId) }, 'tool');
    call.record.request = captureAuditBody(message.params);
    if (pending.has(message.id) || pending.size >= 128) {
      void call.finish({ outcome: 'error', errorCode: 'concurrent_call_limit' });
      void send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Concurrent call limit exceeded' } });
      return;
    }
    pending.set(message.id, call);
    withRuntimeCallContext({ ...context, toolName: call.record.toolName,
      parentInvocationId: call.record.invocationId }, () => receive?.(message, extra));
  };
  transport.send = async (message, options) => {
    if ('id' in message && !('method' in message)) {
      const call = pending.get(message.id as string | number);
      if (call) {
        pending.delete(message.id as string | number);
        await call.finish({ response: captureAuditBody(message), outcome:
          'error' in message || ('result' in message && message.result?.isError) ? 'error' : 'success' });
      }
    }
    return send(message, options);
  };
  transport.onclose = () => {
    for (const call of pending.values()) void call.finish({ outcome: 'cancelled', errorCode: 'session_closed' });
    pending.clear();
    close?.();
  };
}
