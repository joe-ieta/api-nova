import { createHash } from 'node:crypto';

export const MANAGED_MCP_LIFECYCLE_PREFIX = 'managed-mcp-lifecycle:';
export const MANAGED_MCP_LIFECYCLE_VERSION = 1;
export const MANAGED_MCP_LIFECYCLE_MAX_GENERATION = 2147483647;
export const MANAGED_MCP_LIFECYCLE_MAX_DECISIONS = 32;

export const MANAGED_MCP_LIFECYCLE_FAILURE_CODES = Object.freeze([
  'MANAGED_LIFECYCLE_REJECTED',
  'MANAGED_LIFECYCLE_APPROVAL_REJECTED',
  'MANAGED_LIFECYCLE_CONFLICT',
  'MANAGED_LIFECYCLE_ALREADY_CURRENT',
  'MANAGED_LIFECYCLE_STORE_UNAVAILABLE',
  'MANAGED_LIFECYCLE_INVALID_RECORD',
  'MANAGED_LIFECYCLE_CAPTURE_FAILED',
  'MANAGED_LIFECYCLE_CHANNEL_FAILED',
  'MANAGED_LIFECYCLE_GENERATION_EXHAUSTED',
] as const);
export type ManagedMcpLifecycleFailureCode = typeof MANAGED_MCP_LIFECYCLE_FAILURE_CODES[number];

export class ManagedMcpLifecycleError extends Error {
  readonly code: ManagedMcpLifecycleFailureCode;
  constructor(code: ManagedMcpLifecycleFailureCode) {
    super(code);
    this.name = 'ManagedMcpLifecycleError';
    this.code = code;
  }
}

export type ManagedLifecycleAction = 'start' | 'stop';
export type ManagedLifecycleState = 'starting' | 'current' | 'stopping' | 'stopped' | 'failed' | 'abandoned';
export type ManagedLifecycleTerminalReason =
  | 'stopped'
  | 'start_failed'
  | 'runtime_failed'
  | 'parent_transition_interrupted'
  | 'unverified_discovered_child'
  | 'stop_reconciled_without_parent';

export interface ManagedLifecycleSnapshotIdentity {
  readonly runtimeAssetId: string;
  readonly candidateRevision: string;
  readonly verificationRunId: string;
  readonly behaviorFingerprint: string;
  readonly registryRevision: string;
  readonly registryContentDigest: string;
  readonly inboundAuthMode: 'private_api_key' | 'private_jwt' | 'anonymous';
}

export interface ManagedLifecycleDecisionV1 {
  readonly version: 1;
  readonly decisionId: string;
  readonly action: ManagedLifecycleAction;
  readonly approvalMode: 'auto';
  readonly approvedBy: string;
  readonly policyId: string;
  readonly policyDigest: string;
  readonly approvedAt: string;
  readonly generation: number;
  readonly snapshotDigest: string | null;
}

export interface ManagedLifecycleTerminalV1 {
  readonly observedAt: string;
  readonly reason: ManagedLifecycleTerminalReason;
  readonly verifiedByParent: boolean;
  readonly code: string | null;
}

export interface ManagedLifecycleRecordV1 {
  readonly version: 1;
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly state: ManagedLifecycleState;
  readonly launchId: string | null;
  readonly pid: number | null;
  readonly snapshot: ManagedLifecycleSnapshotIdentity | null;
  readonly startDecision: ManagedLifecycleDecisionV1 | null;
  readonly stopDecision: ManagedLifecycleDecisionV1 | null;
  readonly terminal: ManagedLifecycleTerminalV1 | null;
  readonly currentVerified: boolean;
  readonly decisions: readonly ManagedLifecycleDecisionV1[];
  readonly updatedAt: string;
}

export interface ManagedLifecycleSnapshotSource {
  runtimeAssetId: string;
  candidateRevision: string;
  verificationRunId: string;
  behaviorFingerprint: string;
  inboundAuthMode: string;
  registrySource: { expectedRevision: string; expectedContentDigest: string };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_REASONS: readonly ManagedLifecycleTerminalReason[] = ['stopped', 'start_failed', 'runtime_failed',
  'parent_transition_interrupted', 'unverified_discovered_child', 'stop_reconciled_without_parent'];
const STATES: readonly ManagedLifecycleState[] = ['starting', 'current', 'stopping', 'stopped', 'failed', 'abandoned'];
const ACTIONS: readonly ManagedLifecycleAction[] = ['start', 'stop'];

export function trustedLifecycleText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

export function canonicalLifecycleTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function canonicalManagedLifecycleJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) result[key] = walk((item as Record<string, unknown>)[key]);
      return result;
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

export function managedLifecycleDigest(value: unknown): string {
  return createHash('sha256').update(canonicalManagedLifecycleJson(value), 'utf8').digest('hex');
}

export function managedLifecycleSnapshot(source: ManagedLifecycleSnapshotSource): ManagedLifecycleSnapshotIdentity | null {
  if (!source || typeof source !== 'object') return null;
  if (!IDENTIFIER.test(source.runtimeAssetId) || !IDENTIFIER.test(source.candidateRevision) || !IDENTIFIER.test(source.verificationRunId) ||
    !SHA256.test(source.behaviorFingerprint) || !['private_api_key', 'private_jwt', 'anonymous'].includes(source.inboundAuthMode)) return null;
  const registry = source.registrySource;
  if (!registry || typeof registry !== 'object' || !IDENTIFIER.test(registry.expectedRevision) || !SHA256.test(registry.expectedContentDigest)) return null;
  return Object.freeze({ runtimeAssetId: source.runtimeAssetId, candidateRevision: source.candidateRevision,
    verificationRunId: source.verificationRunId, behaviorFingerprint: source.behaviorFingerprint,
    registryRevision: registry.expectedRevision, registryContentDigest: registry.expectedContentDigest,
    inboundAuthMode: source.inboundAuthMode as ManagedLifecycleSnapshotIdentity['inboundAuthMode'] });
}

export function managedLifecycleSnapshotDigest(snapshot: ManagedLifecycleSnapshotIdentity): string {
  return managedLifecycleDigest(snapshot);
}

function parseDecision(value: unknown): ManagedLifecycleDecisionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>).sort().join('|');
  if (keys !== ['action', 'approvalMode', 'approvedAt', 'approvedBy', 'decisionId', 'generation', 'policyDigest', 'policyId', 'snapshotDigest', 'version'].sort().join('|')) return null;
  const decision = value as Record<string, unknown>;
  if (decision.version !== MANAGED_MCP_LIFECYCLE_VERSION || !ACTIONS.includes(decision.action as ManagedLifecycleAction) || decision.approvalMode !== 'auto') return null;
  if (!UUID.test(String(decision.decisionId)) || !trustedLifecycleText(decision.approvedBy, 200) || !IDENTIFIER.test(String(decision.policyId)) ||
    !SHA256.test(String(decision.policyDigest)) || !canonicalLifecycleTimestamp(decision.approvedAt)) return null;
  if (!Number.isSafeInteger(decision.generation) || (decision.generation as number) < 1 || (decision.generation as number) > MANAGED_MCP_LIFECYCLE_MAX_GENERATION) return null;
  if (!(decision.snapshotDigest === null || SHA256.test(String(decision.snapshotDigest)))) return null;
  return Object.freeze({ version: 1, decisionId: String(decision.decisionId), action: decision.action as ManagedLifecycleAction,
    approvalMode: 'auto', approvedBy: String(decision.approvedBy), policyId: String(decision.policyId), policyDigest: String(decision.policyDigest),
    approvedAt: String(decision.approvedAt), generation: decision.generation as number,
    snapshotDigest: decision.snapshotDigest === null ? null : String(decision.snapshotDigest) });
}

export function managedLifecycleDecisionValid(
  decision: ManagedLifecycleDecisionV1 | null | undefined,
  expected: { action: ManagedLifecycleAction; generation: number; snapshotDigest: string | null },
): decision is ManagedLifecycleDecisionV1 {
  if (!decision) return false;
  const parsed = parseDecision(decision);
  if (!parsed) return false;
  if (parsed.action !== expected.action || parsed.generation !== expected.generation) return false;
  return parsed.snapshotDigest === expected.snapshotDigest;
}

export function parseManagedLifecycleDecision(value: unknown): ManagedLifecycleDecisionV1 | null {
  return parseDecision(value);
}

function parseSnapshot(value: unknown): ManagedLifecycleSnapshotIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>).sort().join('|');
  if (keys !== ['behaviorFingerprint', 'candidateRevision', 'inboundAuthMode', 'registryContentDigest', 'registryRevision', 'runtimeAssetId', 'verificationRunId'].sort().join('|')) return null;
  const snapshot = value as Record<string, unknown>;
  if (!IDENTIFIER.test(String(snapshot.runtimeAssetId)) || !IDENTIFIER.test(String(snapshot.candidateRevision)) || !IDENTIFIER.test(String(snapshot.verificationRunId)) ||
    !SHA256.test(String(snapshot.behaviorFingerprint)) || !IDENTIFIER.test(String(snapshot.registryRevision)) || !SHA256.test(String(snapshot.registryContentDigest)) ||
    !['private_api_key', 'private_jwt', 'anonymous'].includes(String(snapshot.inboundAuthMode))) return null;
  return Object.freeze({ runtimeAssetId: String(snapshot.runtimeAssetId), candidateRevision: String(snapshot.candidateRevision),
    verificationRunId: String(snapshot.verificationRunId), behaviorFingerprint: String(snapshot.behaviorFingerprint),
    registryRevision: String(snapshot.registryRevision), registryContentDigest: String(snapshot.registryContentDigest),
    inboundAuthMode: String(snapshot.inboundAuthMode) as ManagedLifecycleSnapshotIdentity['inboundAuthMode'] });
}

function parseTerminal(value: unknown): ManagedLifecycleTerminalV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>).sort().join('|');
  if (keys !== ['observedAt', 'reason', 'verifiedByParent', 'code'].sort().join('|')) return null;
  const terminal = value as Record<string, unknown>;
  if (!canonicalLifecycleTimestamp(terminal.observedAt) || !TERMINAL_REASONS.includes(terminal.reason as ManagedLifecycleTerminalReason) ||
    typeof terminal.verifiedByParent !== 'boolean') return null;
  if (!(terminal.code === null || typeof terminal.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(terminal.code))) return null;
  return Object.freeze({ observedAt: String(terminal.observedAt), reason: terminal.reason as ManagedLifecycleTerminalReason,
    verifiedByParent: terminal.verifiedByParent, code: terminal.code === null ? null : String(terminal.code) });
}

export function parseManagedLifecycleRecord(value: unknown): ManagedLifecycleRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const expectedKeys = ['version', 'serverId', 'runtimeAssetId', 'generation', 'state', 'launchId', 'pid', 'snapshot',
    'startDecision', 'stopDecision', 'terminal', 'currentVerified', 'decisions', 'updatedAt'].sort().join('|');
  if (Object.keys(value as Record<string, unknown>).sort().join('|') !== expectedKeys) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== MANAGED_MCP_LIFECYCLE_VERSION || !IDENTIFIER.test(String(record.serverId)) || !IDENTIFIER.test(String(record.runtimeAssetId))) return null;
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || (record.generation as number) > MANAGED_MCP_LIFECYCLE_MAX_GENERATION) return null;
  if (!STATES.includes(record.state as ManagedLifecycleState) || !canonicalLifecycleTimestamp(record.updatedAt)) return null;
  if (!(record.launchId === null || (typeof record.launchId === 'string' && IDENTIFIER.test(record.launchId)))) return null;
  if (!(record.pid === null || Number.isSafeInteger(record.pid) && (record.pid as number) > 0)) return null;
  const snapshot = record.snapshot === null ? null : parseSnapshot(record.snapshot);
  if (record.snapshot !== null && !snapshot) return null;
  const startDecision = record.startDecision === null ? null : parseDecision(record.startDecision);
  if (record.startDecision !== null && !startDecision) return null;
  const stopDecision = record.stopDecision === null ? null : parseDecision(record.stopDecision);
  if (record.stopDecision !== null && !stopDecision) return null;
  const terminal = record.terminal === null ? null : parseTerminal(record.terminal);
  if (record.terminal !== null && !terminal) return null;
  if (typeof record.currentVerified !== 'boolean' || !Array.isArray(record.decisions) || record.decisions.length > MANAGED_MCP_LIFECYCLE_MAX_DECISIONS) return null;
  const decisions: ManagedLifecycleDecisionV1[] = [];
  for (const item of record.decisions) {
    const decision = parseDecision(item);
    if (!decision) return null;
    decisions.push(decision);
  }
  const state = record.state as ManagedLifecycleState;
  const digest = snapshot ? managedLifecycleSnapshotDigest(snapshot) : null;
  if (state === 'starting' || state === 'current' || state === 'stopping') {
    if (!snapshot || !startDecision || terminal) return null;
  }
  if (state === 'starting' || state === 'current') {
    if (!managedLifecycleDecisionValid(startDecision, { action: 'start', generation: record.generation as number, snapshotDigest: digest })) return null;
  }
  if (state === 'stopping' && !stopDecision) return null;
  if ((state === 'stopped' || state === 'failed' || state === 'abandoned') && !terminal) return null;
  if (record.currentVerified !== (state === 'current')) return null;
  if (startDecision && !managedLifecycleDecisionValid(startDecision, { action: 'start', generation: record.generation as number,
    snapshotDigest: snapshot ? managedLifecycleSnapshotDigest(snapshot) : null })) return null;
  if (stopDecision && !managedLifecycleDecisionValid(stopDecision, { action: 'stop', generation: record.generation as number,
    snapshotDigest: snapshot ? managedLifecycleSnapshotDigest(snapshot) : null })) return null;
  const history = new Set(decisions.map(decision => decision.decisionId));
  if (startDecision && !history.has(startDecision.decisionId)) return null;
  if (stopDecision && !history.has(stopDecision.decisionId)) return null;
  return Object.freeze({ version: 1, serverId: String(record.serverId), runtimeAssetId: String(record.runtimeAssetId),
    generation: record.generation as number, state, launchId: record.launchId === null ? null : String(record.launchId),
    pid: record.pid === null ? null : record.pid as number, snapshot, startDecision, stopDecision, terminal,
    currentVerified: record.currentVerified, decisions: Object.freeze(decisions), updatedAt: String(record.updatedAt) });
}

export interface ManagedLifecyclePublicView {
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly state: ManagedLifecycleState;
  readonly launchId: string | null;
  readonly pid: number | null;
  readonly current: boolean;
  readonly snapshotDigest: string | null;
  readonly startDecision: ManagedLifecycleDecisionV1 | null;
  readonly stopDecision: ManagedLifecycleDecisionV1 | null;
  readonly terminal: ManagedLifecycleTerminalV1 | null;
  readonly updatedAt: string;
}

export function managedLifecyclePublicView(record: ManagedLifecycleRecordV1, current: boolean): ManagedLifecyclePublicView {
  return Object.freeze({ serverId: record.serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
    state: record.state, launchId: record.launchId, pid: record.pid, current,
    snapshotDigest: record.snapshot ? managedLifecycleSnapshotDigest(record.snapshot) : null,
    startDecision: record.startDecision, stopDecision: record.stopDecision, terminal: record.terminal, updatedAt: record.updatedAt });
}
