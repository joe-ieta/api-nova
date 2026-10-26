import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  ManagedLifecycleAction,
  ManagedLifecycleDecisionV1,
  ManagedLifecycleSnapshotIdentity,
  managedLifecycleDecisionValid,
  managedLifecycleDigest,
  managedLifecycleSnapshotDigest,
  parseManagedLifecycleDecision,
} from './managed-mcp-lifecycle.contract';
import { resolveManagedMcpConfigValue } from './managed-mcp-trusted-config';

export const MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY = 'managedMcp.lifecycleApproval';

export interface ManagedLifecycleApprovalRequest {
  readonly action: ManagedLifecycleAction;
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly snapshot: ManagedLifecycleSnapshotIdentity | null;
}

export type ManagedLifecycleApprovalProvider = (request: ManagedLifecycleApprovalRequest) => Promise<ManagedLifecycleDecisionV1 | null>;

export interface ManagedLifecycleApprovalPolicyV1 {
  readonly version: 1;
  readonly mode: 'auto';
  readonly policyId: string;
  readonly allowedActions: readonly ManagedLifecycleAction[];
  readonly allowedServerIds: readonly string[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTIONS: readonly ManagedLifecycleAction[] = ['start', 'stop'];

function readonlyData(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 8 || ++budget.nodes > 1024) throw new Error();
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new Error();
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error();
    return value.map(item => readonlyData(item, depth + 1, budget));
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) throw new Error();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error();
    result[key] = readonlyData(descriptor.value, depth + 1, budget);
  }
  return result;
}

export function parseManagedLifecycleApprovalPolicy(value: unknown): ManagedLifecycleApprovalPolicyV1 | null {
  try {
    const policy = readonlyData(value) as Record<string, unknown> | null;
    if (!policy || Array.isArray(policy)) return null;
    if (Object.keys(policy).sort().join('|') !== ['version', 'mode', 'policyId', 'allowedActions', 'allowedServerIds'].sort().join('|')) return null;
    if (policy.version !== 1 || policy.mode !== 'auto' || !IDENTIFIER.test(String(policy.policyId))) return null;
    if (!Array.isArray(policy.allowedActions) || !policy.allowedActions.length || policy.allowedActions.length > ACTIONS.length ||
      policy.allowedActions.some(action => !ACTIONS.includes(action as ManagedLifecycleAction)) ||
      new Set(policy.allowedActions).size !== policy.allowedActions.length) return null;
    if (!Array.isArray(policy.allowedServerIds) || !policy.allowedServerIds.length || policy.allowedServerIds.length > 256 ||
      policy.allowedServerIds.some(id => !IDENTIFIER.test(String(id))) || new Set(policy.allowedServerIds).size !== policy.allowedServerIds.length) return null;
    return Object.freeze({ version: 1, mode: 'auto', policyId: String(policy.policyId),
      allowedActions: Object.freeze(policy.allowedActions.map(action => action as ManagedLifecycleAction)),
      allowedServerIds: Object.freeze(policy.allowedServerIds.map(id => String(id))) });
  } catch { return null; }
}

function policyDigest(runtimeAssetId: string, policy: ManagedLifecycleApprovalPolicyV1): string {
  return managedLifecycleDigest({ runtimeAssetId, mode: policy.mode, policyId: policy.policyId,
    allowedActions: policy.allowedActions, allowedServerIds: policy.allowedServerIds });
}

export function createConfigManagedLifecycleApprovalProvider(config: ConfigService, options: { now?: () => Date } = {}): ManagedLifecycleApprovalProvider {
  const now = options.now ?? (() => new Date());
  return async request => {
    try {
      if (!request || !IDENTIFIER.test(request.serverId) || !IDENTIFIER.test(request.runtimeAssetId) || !ACTIONS.includes(request.action) ||
        !Number.isSafeInteger(request.generation) || request.generation < 1) return null;
      const sources = readonlyData(resolveManagedMcpConfigValue(config, MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, 'lifecycleApproval')) as Record<string, unknown> | null;
      if (!sources || Array.isArray(sources) || !Object.prototype.hasOwnProperty.call(sources, request.runtimeAssetId)) return null;
      const policy = parseManagedLifecycleApprovalPolicy(sources[request.runtimeAssetId]);
      if (!policy || !policy.allowedActions.includes(request.action) || !policy.allowedServerIds.includes(request.serverId)) return null;
      const snapshotDigest = request.snapshot ? managedLifecycleSnapshotDigest(request.snapshot) : null;
      if (!snapshotDigest) return null;
      const decision = Object.freeze({ version: 1 as const, decisionId: randomUUID(), action: request.action, approvalMode: 'auto' as const,
        approvedBy: `auto:${policy.policyId}`, policyId: policy.policyId, policyDigest: policyDigest(request.runtimeAssetId, policy),
        approvedAt: now().toISOString(), generation: request.generation, snapshotDigest });
      return managedLifecycleDecisionValid(decision, { action: request.action, generation: request.generation, snapshotDigest })
        ? parseManagedLifecycleDecision(decision) : null;
    } catch { return null; }
  };
}
