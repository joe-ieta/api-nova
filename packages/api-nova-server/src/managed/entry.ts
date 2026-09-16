import { MANAGED_HANDOFF_LIMITS, ManagedFailureCode, ManagedMcpHandoffV1, ManagedRuntimeRevisions, parseManagedParentMessage } from './handoff';
/** Dedicated managed child. All diagnostics are fixed IPC codes, never raw
 * third-party parser/transport logging that could include spec or secrets. */
export function runManagedEntry(): void {
  if (!process.send || !process.connected) { process.stderr.write('MANAGED_IPC_REQUIRED\n'); process.exitCode = 1; return; }
  for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const) console[name] = () => undefined;
  let received = false, ending = false, launchId = '';
  let runtime: { close(): Promise<void>; revisions: ManagedRuntimeRevisions } | undefined;
  let activation: Promise<void> | undefined;
  const finish = (code?: ManagedFailureCode) => {
    if (ending) return;
    ending = true; clearTimeout(timer);
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
      if (received) return finish('INVALID_MANAGED_HANDOFF');
      received = true; launchId = parsed.launchId;
      process.send!({ type: 'handoffAccepted', launchId }, error => {
        if (error) return finish('MANAGED_CHANNEL_FAILED');
        if (ending) return;
        activation = (async () => {
          try {
            // Lazy load only after validated IPC. No CLI/default document entry.
            const { activateManagedRuntime } = require('./runtime') as { activateManagedRuntime(payload: ManagedMcpHandoffV1): Promise<{ close(): Promise<void>; revisions: ManagedRuntimeRevisions }> };
            runtime = await activateManagedRuntime(parsed.payload);
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
