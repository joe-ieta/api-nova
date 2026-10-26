import { ManagedAuthorizationAck, ManagedAuthorizationEvent, ManagedPermitModeAck, ManagedPermitModeEvent } from './handoff';

export const MANAGED_AUTHORIZATION_DENIED_CODE = 'MANAGED_AUTHORIZATION_DENIED';
export const MANAGED_AUTHORIZATION_REPLAYED_CODE = 'MANAGED_AUTHORIZATION_REPLAYED';
export const MANAGED_EXECUTION_PERMIT_DENIED_CODE = 'MANAGED_TOOL_EXECUTION_DENIED';
/** Bounded child-side wait for the parent's live per-execution decision. The
 * parent side answers within a shorter bound; a missing decision is a denial. */
export const MANAGED_EXECUTION_PERMIT_WAIT_MS = 10000;

export class ManagedAuthorizationGateError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ManagedAuthorizationGateError'; }
}

/** Child-side authorization state machine. A launch stays in the default-open
 * compatibility state until the parent opts it into enforcement with the first
 * authorization event; from then on every tool execution requires the current
 * decision to be `allow`. Verbatim duplicates are acknowledged idempotently
 * without changing state; conflicting/stale replays fail closed. */
export class ManagedAuthorizationGate {
  private last: ManagedAuthorizationEvent | null = null;
  private mode: 'unset' | 'allow' | 'deny' | 'revoked' = 'unset';

  get enforcing(): boolean { return this.mode !== 'unset'; }
  get decision(): 'unset' | 'allow' | 'deny' | 'revoked' { return this.mode; }

  apply(event: ManagedAuthorizationEvent): ManagedAuthorizationAck {
    if (this.last && event.sequence === this.last.sequence) {
      if (event.permitId === this.last.permitId && event.decision === this.last.decision) {
        return Object.freeze({ type: 'authorizationAck', launchId: event.launchId, sequence: event.sequence,
          permitId: event.permitId, decision: event.decision, status: 'duplicate' });
      }
      throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    }
    if (this.last && event.sequence < this.last.sequence) throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    if (this.mode === 'revoked') throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    this.last = Object.freeze({ ...event });
    this.mode = event.decision === 'revoke' ? 'revoked' : event.decision;
    return Object.freeze({ type: 'authorizationAck', launchId: event.launchId, sequence: event.sequence,
      permitId: event.permitId, decision: event.decision, status: 'applied' });
  }

  assertAllowed(_toolName: string): void {
    if (this.mode === 'unset' || this.mode === 'allow') return;
    throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_DENIED_CODE);
  }
}

export class ManagedExecutionPermitError extends Error {
  constructor(readonly code: string = MANAGED_EXECUTION_PERMIT_DENIED_CODE) { super(code); this.name = 'ManagedExecutionPermitError'; }
}

/** Non-secret selector metadata for exactly one tool execution. Never carries
 * proof, capability or credential material. */
export interface ManagedExecutionPermitBinding {
  readonly tool: string; readonly method: string; readonly path: string;
  readonly sourceServiceAssetId: string; readonly endpointDefinitionId: string;
}
/** Transport injected by the child entry; resolves with the parent's bounded
 * live decision for this exact execution. */
export type ManagedExecutionPermitRequester = (binding: ManagedExecutionPermitBinding) => Promise<'allow' | 'deny'>;

/** Child-side per-execution permit state machine. A launch stays default-open
 * until the parent opts it into live permits with `permitMode`; from then on
 * every execution must obtain a fresh bounded decision before any handler or
 * upstream work. Revocation is terminal for the launch. The gate only ever
 * receives non-secret selector metadata; proof/capability material never enters
 * this object, is never stored and is never serialized. */
export class ManagedExecutionPermitGate {
  private mode: 'unset' | 'enforcing' | 'revoked' = 'unset';
  private last: ManagedPermitModeEvent | null = null;

  constructor(private readonly request?: ManagedExecutionPermitRequester) {}

  get enforcing(): boolean { return this.mode === 'enforcing'; }
  get decision(): 'unset' | 'enforcing' | 'revoked' { return this.mode; }
  get permitId(): string { return this.last?.permitId ?? ''; }

  applyMode(event: ManagedPermitModeEvent): ManagedPermitModeAck {
    if (this.last && event.sequence === this.last.sequence) {
      if (event.permitId === this.last.permitId) {
        return Object.freeze({ type: 'permitModeAck', launchId: event.launchId, sequence: event.sequence,
          permitId: event.permitId, status: 'duplicate' });
      }
      throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    }
    if (this.last && event.sequence < this.last.sequence) throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    if (this.mode === 'revoked') throw new ManagedAuthorizationGateError(MANAGED_AUTHORIZATION_REPLAYED_CODE);
    this.last = Object.freeze({ ...event });
    this.mode = 'enforcing';
    return Object.freeze({ type: 'permitModeAck', launchId: event.launchId, sequence: event.sequence,
      permitId: event.permitId, status: 'applied' });
  }

  revoke(): void { this.mode = 'revoked'; }

  async assertAllowed(binding: ManagedExecutionPermitBinding): Promise<void> {
    if (this.mode === 'unset') return;
    if (this.mode !== 'enforcing' || !this.request) throw new ManagedExecutionPermitError();
    let decision: 'allow' | 'deny' = 'deny';
    try { decision = await this.request(Object.freeze({ ...binding })); } catch { decision = 'deny'; }
    if (decision !== 'allow' || this.mode !== 'enforcing') throw new ManagedExecutionPermitError();
  }
}
