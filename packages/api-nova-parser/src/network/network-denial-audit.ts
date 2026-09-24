import { networkFailureDisposition, NetworkFailureDisposition, NetworkResponseState } from './network-failure-contract';

export type NetworkFailureStage = 'admission' | 'target' | 'dns' | 'connect' | 'peer' | 'tls' | 'send' | 'redirect' | 'response' | 'revocation' | 'deadline' | 'cancel';
/** Host-owned opaque identifiers only. This type does not confer authority on inbound metadata. */
export interface NetworkDenialAuditContext {
  readonly operationId: string;
  readonly sourceServiceAssetId: string;
  readonly siteId?: string;
  readonly endpointDefinitionId?: string;
  readonly policyId: string;
  readonly revision: string;
  readonly revocationEpoch: string;
  readonly redirectHopIndex: number;
  readonly attemptIndex: number;
  readonly stage: NetworkFailureStage;
}
export interface NetworkDenialAuditRecord extends NetworkDenialAuditContext {
  readonly schemaVersion: 1;
  readonly eventName: 'upstream.network_failure';
  readonly reason: NetworkFailureDisposition['code'];
}
const required = ['operationId', 'sourceServiceAssetId', 'policyId', 'revision', 'revocationEpoch', 'redirectHopIndex', 'attemptIndex', 'stage'];
const allowed = [...required, 'siteId', 'endpointDefinitionId'];
const identifiers = ['operationId', 'sourceServiceAssetId', 'siteId', 'endpointDefinitionId', 'policyId', 'revision'];
const stages: readonly string[] = ['admission', 'target', 'dns', 'connect', 'peer', 'tls', 'send', 'redirect', 'response', 'revocation', 'deadline', 'cancel'];

/** Reject the whole audit input on ambiguity. Never spread a runtime call context or arbitrary error. */
export function createNetworkDenialAuditRecord(failure: unknown, input: unknown): Readonly<NetworkDenialAuditRecord> | undefined {
  try {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      copy[key] = descriptor.value;
    }
    if (required.some(key => !Object.prototype.hasOwnProperty.call(copy, key))) return undefined;
    for (const key of identifiers) {
      if (Object.prototype.hasOwnProperty.call(copy, key) && (typeof copy[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(copy[key] as string))) return undefined;
    }
    if (typeof copy.revocationEpoch !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(copy.revocationEpoch) ||
      !Number.isSafeInteger(copy.redirectHopIndex) || (copy.redirectHopIndex as number) < 0 || (copy.redirectHopIndex as number) > 5 ||
      !Number.isSafeInteger(copy.attemptIndex) || (copy.attemptIndex as number) < 1 || (copy.attemptIndex as number) > 2147483647 ||
      typeof copy.stage !== 'string' || !stages.includes(copy.stage)) return undefined;
    return Object.freeze(Object.assign(Object.create(null), copy, { schemaVersion: 1, eventName: 'upstream.network_failure',
      reason: networkFailureDisposition(failure).code })) as unknown as Readonly<NetworkDenialAuditRecord>;
  } catch { return undefined; }
}

/** Sink failures cannot alter the refusal; pending asynchronous persistence is never awaited. */
export function auditNetworkFailure(failure: unknown, context: unknown, sink: (record: Readonly<NetworkDenialAuditRecord>) => unknown,
  state: NetworkResponseState = 'not-started'): NetworkFailureDisposition {
  const disposition = networkFailureDisposition(failure, state);
  const record = createNetworkDenialAuditRecord(failure, context);
  if (record) {
    try { void Promise.resolve(sink(record)).catch(() => {}); } catch { /* Refusal survives instrumentation failure. */ }
  }
  return disposition;
}