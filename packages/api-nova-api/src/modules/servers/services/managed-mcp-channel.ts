import { spawn, ChildProcess } from 'node:child_process';
import { MANAGED_HANDOFF_LIMITS, ManagedChannelError, ManagedFailureCode, ManagedMcpHandoffV1, ManagedRuntimeRevisions,
  captureManagedHandoff, parseManagedParentMessage, parseManagedChildMessage } from 'api-nova-server';

const SYSTEM_ENV = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ']);
export function buildManagedEnvironment(approvedNames: readonly string[], values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  try {
    if (!Array.isArray(approvedNames) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
    const approved = new Set<string>();
    for (const name of approvedNames) {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || /^(NODE_|LD_|DYLD_)/i.test(name) || SYSTEM_ENV.has(name.toUpperCase()) || approved.has(name.toUpperCase())) throw new Error();
      approved.add(name.toUpperCase());
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (SYSTEM_ENV.has(name.toUpperCase()) && value !== undefined) {
        // Windows environment names are case-insensitive: emit one canonical key.
        env[process.platform === 'win32' ? name.toUpperCase() : name] = value;
      }
    }
    const seen = new Set<string>();
    for (const name of Reflect.ownKeys(values)) {
      if (typeof name !== 'string' || !approvedNames.includes(name) || !approved.has(name.toUpperCase()) || seen.has(name.toUpperCase())) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(values, name)!;
      if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.includes('\0') || descriptor.value.length > 32768) throw new Error();
      seen.add(name.toUpperCase()); env[name] = descriptor.value;
    }
    if (seen.size !== approved.size) throw new Error();
    return env;
  } catch { throw new ManagedChannelError('MANAGED_ENVIRONMENT_REJECTED'); }
}
export interface ManagedChannelInput {
  launchId: string; serverId: string; payload: ManagedMcpHandoffV1;
  approvedEnvironmentNames: readonly string[]; environmentValues: Readonly<Record<string, string>>;
}
export interface ManagedChannelResult { code: ManagedFailureCode | 'STOPPED'; }
export interface ManagedChannelAuthorizationInput {
  readonly decision: 'allow' | 'deny' | 'revoke';
  readonly permitId: string;
  readonly sequence: number;
}
export interface ManagedChannelAuthorizationResult { readonly status: 'applied' | 'duplicate'; }
export interface ManagedChannelHandle {
  readonly launchId: string; readonly pid: number; readonly state: 'handoffAccepted' | 'runtimeReady';
  readonly ready: Promise<ManagedRuntimeRevisions>;
  readonly closed: Promise<ManagedChannelResult>;
  close(): Promise<void>;
  authorize?(input: ManagedChannelAuthorizationInput): Promise<ManagedChannelAuthorizationResult>;
}
/** Bounded wait for the child's applied/duplicate acknowledgement. A missing,
 * malformed or unsolicited ack fails closed by terminating the child. */
export const MANAGED_AUTHORIZATION_ACK_MS = 5000;
const MANAGED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
/** Internal opt-in channel only. Never called by legacy lifecycle or persisted in ProcessInfo. */
export async function startManagedMcpChannel(input: ManagedChannelInput): Promise<ManagedChannelHandle> {
  const payload = captureManagedHandoff(input.payload);
  if (input.launchId !== payload.launchId || input.serverId !== payload.managedServerId) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  const outbound = parseManagedParentMessage({ type: 'handoff', version: 1, launchId: payload.launchId, payload });
  const environment = buildManagedEnvironment(input.approvedEnvironmentNames, input.environmentValues);
  let entry: string;
  try { entry = require.resolve('api-nova-server/dist/managed/entry.js'); }
  catch { throw new ManagedChannelError('MANAGED_ENTRY_UNAVAILABLE'); }
  // No caller script path/argv/execArgv and no shell. NODE_* cannot enter env.
  let child: ChildProcess;
  try { child = spawn(process.execPath, [entry], { env: environment, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }); }
  catch { throw new ManagedChannelError('MANAGED_CHANNEL_FAILED'); }
  child.stdout?.resume(); child.stderr?.resume(); child.stdin?.end();
  let readyState = false;
  let accepted = false, settled = false, stopping = false, failure: ManagedFailureCode | undefined;
  let stopPromise: Promise<void> | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let resolveReady!: (value: ManagedRuntimeRevisions) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<ManagedRuntimeRevisions>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined); // callers may observe only closed after an ACK failure
  let resolveClosed!: (value: ManagedChannelResult) => void;
  const closed = new Promise<ManagedChannelResult>(resolve => { resolveClosed = resolve; });
  let resolveStarted!: (value: ManagedChannelHandle) => void, rejectStarted!: (reason: Error) => void;
  const started = new Promise<ManagedChannelHandle>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  interface PendingAuthorization { permitId: string; decision: ManagedChannelAuthorizationInput['decision'];
    resolve: (value: ManagedChannelAuthorizationResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }
  const pendingAuthorizations = new Map<number, PendingAuthorization>();
  const sentAuthorizations = new Map<number, { permitId: string; decision: ManagedChannelAuthorizationInput['decision'];
    promise: Promise<ManagedChannelAuthorizationResult> }>();
  let highestSentSequence = 0;
  const rejectAuthorizations = (error: Error) => {
    for (const item of pendingAuthorizations.values()) { clearTimeout(item.timer); item.reject(error); }
    pendingAuthorizations.clear();
  };
  const finish = () => {
    if (settled) return;
    settled = true; clearTimeout(handshake); if (forceTimer) clearTimeout(forceTimer);
    rejectAuthorizations(new ManagedChannelError(failure || 'MANAGED_CHANNEL_FAILED'));
    sentAuthorizations.clear();
    child.removeListener('message', onMessage); child.removeListener('error', onError); child.removeListener('close', onClose);
    child.removeListener('exit', onClose); child.removeListener('disconnect', onDisconnect);
    child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
    if (!readyState) rejectReady(new ManagedChannelError(failure || 'MANAGED_CHILD_EXITED'));
    if (!accepted) rejectStarted(new ManagedChannelError(failure || 'MANAGED_CHILD_EXITED'));
    resolveClosed(Object.freeze({ code: failure || (stopping ? 'STOPPED' : 'MANAGED_CHILD_EXITED') }));
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = closed.then(() => undefined);
    if (settled) return stopPromise;
    clearTimeout(handshake);
    if (child.connected) {
      try { child.send({ type: 'stop', launchId: payload.launchId }, () => undefined); } catch { /* exit is observed below */ }
    }
    forceTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, MANAGED_HANDOFF_LIMITS.shutdownMs);
    return stopPromise;
  };
  const fail = (code: ManagedFailureCode) => { if (!failure) failure = code; void stop(); };
  const onError = () => { fail('MANAGED_CHANNEL_FAILED'); if (!child.pid) finish(); };
  const onClose = () => finish();
  const onDisconnect = () => { if (!stopping && !settled) fail('MANAGED_CHANNEL_FAILED'); };
  const onMessage = (inputMessage: unknown) => {
    if (settled) return;
    try {
      const message = parseManagedChildMessage(inputMessage, payload.launchId);
      if (message.type === 'failed') { fail(message.code); return; }
      if (message.type === 'runtimeReady') {
        const r = message.nonSecretRevisions;
        if (!accepted || readyState || stopping || r.candidateRevision !== payload.candidateRevision || r.verificationRunId !== payload.verificationRunId ||
          payload.inboundAuthMode !== 'private_api_key' || r.authMode !== 'api_key' || r.behaviorFingerprint !== payload.behaviorFingerprint || r.registryRevision !== payload.registrySource.expectedRevision || r.registryContentDigest !== payload.registrySource.expectedContentDigest) { fail('INVALID_MANAGED_HANDOFF'); return; }
        readyState = true; clearTimeout(handshake); resolveReady(r); return;
      }
      if (message.type === 'authorizationAck') {
        const item = pendingAuthorizations.get(message.sequence);
        const sent = sentAuthorizations.get(message.sequence);
        if (!item || !sent || sent.permitId !== message.permitId || sent.decision !== message.decision ||
          item.permitId !== message.permitId || item.decision !== message.decision) {
          fail('INVALID_MANAGED_HANDOFF'); return;
        }
        pendingAuthorizations.delete(message.sequence);
        sentAuthorizations.delete(message.sequence);
        clearTimeout(item.timer);
        item.resolve({ status: message.status });
        return;
      }
      if (accepted || stopping || !child.pid) { fail('INVALID_MANAGED_HANDOFF'); return; }
      accepted = true;
      // This is only transport acceptance; a bounded timer remains until exit.
      resolveStarted(baseHandle());
    } catch { fail('INVALID_MANAGED_HANDOFF'); }
  };
  const baseHandle = (): ManagedChannelHandle => {
    const handle = { launchId: payload.launchId, pid: child.pid as number,
      get state() { return readyState ? 'runtimeReady' as const : 'handoffAccepted' as const; }, ready, closed, close: stop };
    // Authorization remains an explicit, non-enumerable capability so the
    // established transport handle shape is unchanged for existing callers.
    Object.defineProperty(handle, 'authorize', { value: requestAuthorization, enumerable: false, writable: false, configurable: false });
    return Object.freeze(handle) as ManagedChannelHandle;
  };
  const requestAuthorization = (request: ManagedChannelAuthorizationInput): Promise<ManagedChannelAuthorizationResult> => {
    if (settled || stopping || !accepted) return Promise.reject(new ManagedChannelError('MANAGED_CHANNEL_FAILED'));
    if (!request || typeof request !== 'object' || !['allow', 'deny', 'revoke'].includes(request.decision) ||
      typeof request.permitId !== 'string' || !MANAGED_IDENTIFIER.test(request.permitId) ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 || request.sequence > 2147483647) {
      return Promise.reject(new ManagedChannelError('INVALID_MANAGED_HANDOFF'));
    }
    const existing = sentAuthorizations.get(request.sequence);
    if (existing) {
      if (existing.permitId !== request.permitId || existing.decision !== request.decision) return Promise.reject(new ManagedChannelError('MANAGED_AUTHORIZATION_UNVERIFIED'));
      return existing.promise;
    }
    if (request.sequence <= highestSentSequence) return Promise.reject(new ManagedChannelError('MANAGED_AUTHORIZATION_UNVERIFIED'));
    const promise = new Promise<ManagedChannelAuthorizationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAuthorizations.delete(request.sequence);
        sentAuthorizations.delete(request.sequence);
        fail('MANAGED_AUTHORIZATION_UNVERIFIED');
        reject(new ManagedChannelError('MANAGED_AUTHORIZATION_UNVERIFIED'));
      }, MANAGED_AUTHORIZATION_ACK_MS);
      pendingAuthorizations.set(request.sequence, { permitId: request.permitId, decision: request.decision, resolve, reject, timer });
      try {
        child.send({ type: 'authorization', version: 1, launchId: payload.launchId, sequence: request.sequence,
          permitId: request.permitId, decision: request.decision }, error => { if (error) fail('MANAGED_CHANNEL_FAILED'); });
      } catch { fail('MANAGED_CHANNEL_FAILED'); }
    });
    sentAuthorizations.set(request.sequence, { permitId: request.permitId, decision: request.decision, promise });
    highestSentSequence = Math.max(highestSentSequence, request.sequence);
    return promise;
  };
  const handshake = setTimeout(() => fail('MANAGED_HANDSHAKE_TIMEOUT'), MANAGED_HANDOFF_LIMITS.handshakeMs);
  child.on('message', onMessage); child.on('error', onError); child.on('close', onClose); child.on('exit', onClose); child.on('disconnect', onDisconnect);
  try {
    child.send(outbound, error => { if (error) fail('MANAGED_CHANNEL_FAILED'); });
  } catch { fail('MANAGED_CHANNEL_FAILED'); }
  return started;
}