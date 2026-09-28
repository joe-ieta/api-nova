import { ManagedAuthorizationAck, ManagedAuthorizationEvent } from './handoff';

export const MANAGED_AUTHORIZATION_DENIED_CODE = 'MANAGED_AUTHORIZATION_DENIED';
export const MANAGED_AUTHORIZATION_REPLAYED_CODE = 'MANAGED_AUTHORIZATION_REPLAYED';

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
