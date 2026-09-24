/** Pure internal contract. Runtime adapters must create failures from trusted decisions, never request fields. */
export type NetworkFailureKind = 'denied' | 'unavailable' | 'timeout' | 'cancelled';
export interface NetworkFailure { readonly kind: NetworkFailureKind }
const failures = new WeakMap<object, NetworkFailureKind>();
const kinds: readonly NetworkFailureKind[] = ['denied', 'unavailable', 'timeout', 'cancelled'];

export function createNetworkFailure(kind: NetworkFailureKind): NetworkFailure {
  const trustedKind = kinds.includes(kind) ? kind : 'unavailable';
  const failure = Object.freeze({ kind: trustedKind });
  failures.set(failure, trustedKind);
  return failure;
}

/** No property access, instanceof, coercion or serialization of an unknown error. */
export function classifyNetworkFailure(failure: unknown): NetworkFailureKind {
  return failure !== null && typeof failure === 'object' ? failures.get(failure) ?? 'unavailable' : 'unavailable';
}

export type NetworkResponseState = 'not-started' | 'started' | 'closed';
export interface NetworkFailureDisposition {
  readonly kind: NetworkFailureKind;
  readonly code: 'upstream_network_policy_denied' | 'upstream_network_policy_unavailable' | 'ETIMEDOUT' | 'ABORT_ERR';
  readonly gateway: Readonly<{ action: 'respond'; statusCode: 502 | 503 | 504 }> | Readonly<{ action: 'destroy' | 'none' }>;
  readonly tool: Readonly<{ action: 'error' | 'cancelled' }>;
}

/** A decision only: no writes, HTTP exceptions, audit context or transport side effects. */
export function networkFailureDisposition(failure: unknown, state: NetworkResponseState = 'not-started'): NetworkFailureDisposition {
  const kind = classifyNetworkFailure(failure);
  const code = kind === 'denied' ? 'upstream_network_policy_denied' : kind === 'timeout' ? 'ETIMEDOUT'
    : kind === 'cancelled' ? 'ABORT_ERR' : 'upstream_network_policy_unavailable';
  const gateway: NetworkFailureDisposition['gateway'] = state === 'closed' ? { action: 'none' }
    : state !== 'not-started' || kind === 'cancelled' ? { action: 'destroy' }
      : { action: 'respond', statusCode: kind === 'denied' ? 502 : kind === 'timeout' ? 504 : 503 };
  return Object.freeze({ kind, code, gateway: Object.freeze(gateway),
    tool: Object.freeze({ action: kind === 'cancelled' ? 'cancelled' as const : 'error' as const }) });
}