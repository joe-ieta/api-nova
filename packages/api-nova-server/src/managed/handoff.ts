import { isAbsolute } from 'node:path';
/** Managed IPC v1: structural transport contract only, not runtime authorization. */
export const MANAGED_HANDOFF_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, bindings: 10000, handshakeMs: 30000, shutdownMs: 5000 });
export const MANAGED_FAILURE_CODES = Object.freeze(['INVALID_MANAGED_HANDOFF', 'MANAGED_IPC_REQUIRED', 'MANAGED_HANDSHAKE_TIMEOUT',
  'MANAGED_CHANNEL_FAILED', 'MANAGED_CHILD_EXITED', 'MANAGED_ENVIRONMENT_REJECTED', 'MANAGED_ENTRY_UNAVAILABLE', 'RUNTIME_ACTIVATION_NOT_IMPLEMENTED', 'MANAGED_RUNTIME_FAILED',
  'MANAGED_AUTHORIZATION_UNVERIFIED'] as const);
export type ManagedFailureCode = typeof MANAGED_FAILURE_CODES[number];
export interface ManagedMcpHandoffV1 {
  version: 1; launchId: string; managedServerId: string; runtimeAssetId: string;
  candidateRevision: string; verificationRunId: string; behaviorFingerprint: string;
  inboundAuthMode: 'private_jwt' | 'private_api_key' | 'anonymous';
  transport: { type: 'streamable' | 'sse'; host: string; port: number; endpoint: string };
  openApiData: unknown;
  trustedOperationBindings: readonly { method: string; path: string; endpointDefinitionId: string; sourceServiceAssetId: string }[];
  registrySource: { configId: string; path: string; format: 'json' | 'yaml'; environment: string; expectedRevision: string; expectedContentDigest: string };
}
export const MANAGED_AUTHORIZATION_DECISIONS = Object.freeze(['allow', 'deny', 'revoke'] as const);
export type ManagedAuthorizationDecision = typeof MANAGED_AUTHORIZATION_DECISIONS[number];
export type ManagedAuthorizationAckStatus = 'applied' | 'duplicate';
/** Bounded authorization event pushed parent -> child over the existing IPC
 * channel. `sequence` is a strictly increasing per-launch counter; a verbatim
 * duplicate is acknowledged without changing the child's authorization state. */
export interface ManagedAuthorizationEvent {
  readonly type: 'authorization'; readonly version: 1; readonly launchId: string;
  readonly sequence: number; readonly permitId: string; readonly decision: ManagedAuthorizationDecision;
}
export interface ManagedAuthorizationAck {
  readonly type: 'authorizationAck'; readonly launchId: string; readonly sequence: number;
  readonly permitId: string; readonly decision: ManagedAuthorizationDecision; readonly status: ManagedAuthorizationAckStatus;
}
export type ManagedParentMessage = { type: 'handoff'; version: 1; launchId: string; payload: ManagedMcpHandoffV1 } | { type: 'stop'; launchId: string } | ManagedAuthorizationEvent;
export interface ManagedRuntimeRevisions { candidateRevision: string; verificationRunId: string; behaviorFingerprint: string; registryRevision: string; registryContentDigest: string; authMode: 'api_key'; credentialMode: 'single-hop'; }
export type ManagedChildMessage = { type: 'runtimeReady'; launchId: string; nonSecretRevisions: ManagedRuntimeRevisions } | { type: 'handoffAccepted'; launchId: string } | { type: 'failed'; launchId: string; code: ManagedFailureCode } | ManagedAuthorizationAck;
export class ManagedChannelError extends Error {
  constructor(readonly code: ManagedFailureCode) { super(code); this.name = 'ManagedChannelError'; }
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, any> => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(v);
const sha256 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const authorizationSequence = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2147483647;
const authorizationDecision = (v: unknown): v is ManagedAuthorizationDecision => MANAGED_AUTHORIZATION_DECISIONS.includes(v as ManagedAuthorizationDecision);
function jsonData(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 64) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
    jsonData(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}
/** Clone without invoking getters/toJSON; both sides validate the same schema. */
export function captureManagedHandoff(input: unknown): ManagedMcpHandoffV1 {
  try {
    jsonData(input);
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded, 'utf8') > MANAGED_HANDOFF_LIMITS.bytes) throw new Error();
    const p = JSON.parse(encoded);
    if (!exact(p, ['version', 'launchId', 'managedServerId', 'runtimeAssetId', 'candidateRevision', 'verificationRunId', 'behaviorFingerprint', 'inboundAuthMode', 'transport', 'openApiData', 'trustedOperationBindings', 'registrySource']) || p.version !== 1) throw new Error();
    for (const name of ['launchId', 'managedServerId', 'runtimeAssetId', 'candidateRevision', 'verificationRunId']) if (!identifier(p[name])) throw new Error();
    if (!sha256(p.behaviorFingerprint) || !['private_jwt', 'private_api_key', 'anonymous'].includes(p.inboundAuthMode)) throw new Error();
    const t = p.transport, r = p.registrySource;
    if (!exact(t, ['type', 'host', 'port', 'endpoint']) || !['streamable', 'sse'].includes(t.type) || !text(t.host, 255) || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535 || !text(t.endpoint, 1024) || !t.endpoint.startsWith('/')) throw new Error();
    if (!exact(r, ['configId', 'path', 'format', 'environment', 'expectedRevision', 'expectedContentDigest']) || !identifier(r.configId) || !text(r.path, 4096) || !isAbsolute(r.path) || !['json', 'yaml'].includes(r.format) || !identifier(r.environment) || !identifier(r.expectedRevision) || !sha256(r.expectedContentDigest)) throw new Error();
    if (!object(p.openApiData) || !Array.isArray(p.trustedOperationBindings) || p.trustedOperationBindings.length > MANAGED_HANDOFF_LIMITS.bindings) throw new Error();
    const selectors = new Set<string>();
    for (const b of p.trustedOperationBindings) {
      if (!exact(b, ['method', 'path', 'endpointDefinitionId', 'sourceServiceAssetId']) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(b.method) || !text(b.path, 1024) || !b.path.startsWith('/') || !identifier(b.endpointDefinitionId) || !identifier(b.sourceServiceAssetId)) throw new Error();
      const selector = b.method + ' ' + b.path;
      if (selectors.has(selector)) throw new Error(); selectors.add(selector);
    }
    const freeze = (value: any): any => {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    };
    return freeze(p) as ManagedMcpHandoffV1;
  } catch { throw new ManagedChannelError('INVALID_MANAGED_HANDOFF'); }
}
export function parseManagedParentMessage(input: unknown): ManagedParentMessage {
  jsonData(input);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MANAGED_HANDOFF_LIMITS.bytes) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  if (exact(input, ['type', 'launchId']) && input.type === 'stop' && identifier(input.launchId)) return { type: 'stop', launchId: input.launchId };
  if (exact(input, ['type', 'version', 'launchId', 'sequence', 'permitId', 'decision']) && input.type === 'authorization' && input.version === 1) {
    if (!identifier(input.launchId) || !authorizationSequence(input.sequence) || !identifier(input.permitId) || !authorizationDecision(input.decision)) {
      throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
    }
    return Object.freeze({ type: 'authorization', version: 1, launchId: input.launchId,
      sequence: input.sequence, permitId: input.permitId, decision: input.decision }) as ManagedAuthorizationEvent;
  }
  if (!exact(input, ['type', 'version', 'launchId', 'payload']) || input.type !== 'handoff' || input.version !== 1) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  const payload = captureManagedHandoff(input.payload);
  if (input.launchId !== payload.launchId) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  return { type: 'handoff', version: 1, launchId: payload.launchId, payload };
}
export function parseManagedChildMessage(input: unknown, launchId: string): ManagedChildMessage {
  jsonData(input);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 4096) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  if (!object(input) || input.launchId !== launchId) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
  if (exact(input, ['type', 'launchId', 'sequence', 'permitId', 'decision', 'status']) && input.type === 'authorizationAck') {
    if (!authorizationSequence(input.sequence) || !identifier(input.permitId) || !authorizationDecision(input.decision) ||
      !['applied', 'duplicate'].includes(input.status)) throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
    return Object.freeze({ type: 'authorizationAck', launchId, sequence: input.sequence, permitId: input.permitId,
      decision: input.decision, status: input.status }) as ManagedAuthorizationAck;
  }
  if (exact(input, ['type', 'launchId', 'nonSecretRevisions']) && input.type === 'runtimeReady') {
    const r = input.nonSecretRevisions;
    if (!exact(r, ['candidateRevision', 'verificationRunId', 'behaviorFingerprint', 'registryRevision', 'registryContentDigest', 'authMode', 'credentialMode']) ||
      !identifier(r.candidateRevision) || !identifier(r.verificationRunId) || !identifier(r.registryRevision) ||
      !sha256(r.behaviorFingerprint) || !sha256(r.registryContentDigest) || r.authMode !== 'api_key' || r.credentialMode !== 'single-hop') throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
    return { type: 'runtimeReady', launchId, nonSecretRevisions: Object.freeze({ ...r }) as ManagedRuntimeRevisions };
  }
  if (exact(input, ['type', 'launchId']) && input.type === 'handoffAccepted') return { type: 'handoffAccepted', launchId };
  if (exact(input, ['type', 'launchId', 'code']) && input.type === 'failed' && MANAGED_FAILURE_CODES.includes(input.code)) return { type: 'failed', launchId, code: input.code };
  throw new ManagedChannelError('INVALID_MANAGED_HANDOFF');
}