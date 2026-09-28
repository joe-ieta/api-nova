import { randomUUID } from 'node:crypto';
import { MANAGED_HANDOFF_LIMITS, ManagedFailureCode, ManagedMcpHandoffV1, ManagedRuntimeRevisions, parseManagedParentMessage } from './handoff';
import { ManagedAuthorizationGate, ManagedExecutionPermitBinding, ManagedExecutionPermitGate, MANAGED_EXECUTION_PERMIT_WAIT_MS } from './authorization';
/** Dedicated managed child. All diagnostics are fixed IPC codes, never raw
 * third-party parser/transport logging that could include spec or secrets. */
export function runManagedEntry(): void {
  if (!process.send || !process.connected) { process.stderr.write('MANAGED_IPC_REQUIRED\n'); process.exitCode = 1; return; }
  for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const) console[name] = () => undefined;
  let received = false, ending = false, launchId = '';
  let runtime: { close(): Promise<void>; revisions: ManagedRuntimeRevisions } | undefined;
  let activation: Promise<void> | undefined;
  const authorization = new ManagedAuthorizationGate();
  interface PendingPermit { resolve: (decision: 'allow' | 'deny') => void; timer: NodeJS.Timeout; }
  const pendingPermits = new Map<string, PendingPermit>();
  const settlePendingPermits = (decision: 'allow' | 'deny') => {
    for (const pending of pendingPermits.values()) { clearTimeout(pending.timer); pending.resolve(decision); }
    pendingPermits.clear();
  };
  /** Parent round trip for one execution. Every failure mode is a denial; the
   * request only ever carries non-secret selector metadata and the eventual
   * decision is bound to the exact child-generated request identity. */
  const requestExecutionPermit = (binding: ManagedExecutionPermitBinding): Promise<'allow' | 'deny'> => new Promise(resolve => {
    if (ending || !process.connected) return resolve('deny');
    const requestId = `permit-${randomUUID()}`;
    const timer = setTimeout(() => { pendingPermits.delete(requestId); resolve('deny'); }, MANAGED_EXECUTION_PERMIT_WAIT_MS);
    pendingPermits.set(requestId, { resolve, timer });
    try {
      process.send!({ type: 'permitRequest', version: 1, launchId, requestId, tool: binding.tool, method: binding.method,
        path: binding.path, sourceServiceAssetId: binding.sourceServiceAssetId, endpointDefinitionId: binding.endpointDefinitionId },
      error => { if (error) { clearTimeout(timer); pendingPermits.delete(requestId); resolve('deny'); } });
    } catch { clearTimeout(timer); pendingPermits.delete(requestId); resolve('deny'); }
  });
  const executionPermit = new ManagedExecutionPermitGate(requestExecutionPermit);
  const finish = (code?: ManagedFailureCode) => {
    if (ending) return;
    ending = true; clearTimeout(timer);
    settlePendingPermits('deny');
    const deadline = setTimeout(() => process.exit(code ? 1 : 0), MANAGED_HANDOFF_LIMITS.shutdownMs);
    process.removeListener('message', message); process.removeListener('disconnect', disconnected);
    void (async () => {
      await activation?.catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      if (code && process.connected) await new Promise<void>(resolve => {
        try { process.send!({ type: 'failed', launchId, code }, () => resolve()); } catch { resolve(); }
      });
      clearTimeout(deadline);
      if (process.connected) process.disconnect();
      process.exit(code ? 1 : 0);
    })();
  };
  const disconnected = () => finish();
  const message = (input: unknown) => {
    try {
      const parsed = parseManagedParentMessage(input);
      if (parsed.type === 'stop') { if (!received || parsed.launchId !== launchId) return finish('INVALID_MANAGED_HANDOFF'); return finish(); }
      if (parsed.type === 'authorization') {
        if (!received || parsed.launchId !== launchId) return finish('INVALID_MANAGED_HANDOFF');
        // Malformed or conflicting events are already rejected by the wire
        // parser/gate; anything unverified terminates the launch fail closed.
        let ack;
        try { ack = authorization.apply(parsed); }
        catch { return finish('INVALID_MANAGED_HANDOFF'); }
        if (parsed.decision === 'revoke') { executionPermit.revoke(); settlePendingPermits('deny'); }
        process.send!(ack, error => { if (error) finish('MANAGED_CHANNEL_FAILED'); });
        return;
      }
      if (parsed.type === 'permitMode') {
        if (!received || parsed.launchId !== launchId) return finish('INVALID_MANAGED_HANDOFF');
        let ack;
        try { ack = executionPermit.applyMode(parsed); }
        catch { return finish('INVALID_MANAGED_HANDOFF'); }
        process.send!(ack, error => { if (error) finish('MANAGED_CHANNEL_FAILED'); });
        return;
      }
      if (parsed.type === 'permitDecision') {
        // A decision for another launch/permit identity or an unsolicited
        // request is never authoritative: terminate fail closed.
        if (!received || parsed.launchId !== launchId || parsed.permitId !== executionPermit.permitId) return finish('INVALID_MANAGED_HANDOFF');
        const pending = pendingPermits.get(parsed.requestId);
        if (!pending) return finish('INVALID_MANAGED_HANDOFF');
        pendingPermits.delete(parsed.requestId); clearTimeout(pending.timer);
        pending.resolve(parsed.decision);
        return;
      }
      if (received) return finish('INVALID_MANAGED_HANDOFF');
      received = true; launchId = parsed.launchId;
      process.send!({ type: 'handoffAccepted', launchId }, error => {
        if (error) return finish('MANAGED_CHANNEL_FAILED');
        if (ending) return;
        activation = (async () => {
          try {
            // Lazy load only after validated IPC. No CLI/default document entry.
            const { activateManagedRuntime } = require('./runtime') as { activateManagedRuntime(payload: ManagedMcpHandoffV1, gate?: { assertAllowed(toolName: string): void }, permits?: { assertAllowed(binding: ManagedExecutionPermitBinding): Promise<void> }): Promise<{ close(): Promise<void>; revisions: ManagedRuntimeRevisions }> };
            runtime = await activateManagedRuntime(parsed.payload, authorization, executionPermit);
            if (ending) return;
            process.send!({ type: 'runtimeReady', launchId, nonSecretRevisions: runtime.revisions }, error => {
              if (error) finish('MANAGED_CHANNEL_FAILED'); else clearTimeout(timer);
            });
          } catch { setImmediate(() => finish('MANAGED_RUNTIME_FAILED')); }
        })();
      });
    } catch { finish('INVALID_MANAGED_HANDOFF'); }
  };
  const timer = setTimeout(() => finish('MANAGED_HANDSHAKE_TIMEOUT'), MANAGED_HANDOFF_LIMITS.handshakeMs);
  process.on('message', message); process.on('disconnect', disconnected);
  process.on('uncaughtException', () => finish('MANAGED_RUNTIME_FAILED'));
  process.on('unhandledRejection', () => finish('MANAGED_RUNTIME_FAILED'));
}
if (require.main === module) runManagedEntry();
