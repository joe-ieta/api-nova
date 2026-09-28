import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { ManagedMcpHandoffV1, ManagedRuntimeRevisions } from 'api-nova-server';
import {
  MANAGED_MCP_LIFECYCLE_MAX_DECISIONS,
  MANAGED_MCP_LIFECYCLE_MAX_GENERATION,
  ManagedLifecycleAction,
  ManagedLifecycleDecisionV1,
  ManagedLifecyclePublicView,
  ManagedLifecycleRecordV1,
  ManagedLifecycleSnapshotIdentity,
  ManagedLifecycleSnapshotSource,
  ManagedLifecycleState,
  ManagedLifecycleTerminalReason,
  ManagedLifecycleTerminalV1,
  ManagedMcpLifecycleError,
  managedLifecycleDecisionValid,
  managedLifecyclePublicView,
  managedLifecycleSnapshot,
  managedLifecycleSnapshotDigest,
  parseManagedLifecycleRecord,
} from './managed-mcp-lifecycle.contract';
import { ManagedLifecycleApprovalProvider } from './managed-mcp-lifecycle-approval';
import { ManagedMcpLifecycleRead, ManagedMcpLifecycleStore } from './managed-mcp-lifecycle.store';
import { ManagedChildSecurityLeaseCoordinator } from './managed-child-security-lease-coordinator';

export interface ManagedLifecycleCapturedHandoff {
  readonly payload: ManagedMcpHandoffV1;
  readonly approvedEnvironmentNames: readonly string[];
  readonly environmentValues: Readonly<Record<string, string>>;
}
export type ManagedLifecycleCapture = (runtimeAssetId: string, serverId: string) => Promise<ManagedLifecycleCapturedHandoff>;

export interface ManagedLifecycleAuthorizationInput {
  readonly decision: 'allow' | 'deny' | 'revoke';
  readonly permitId: string;
  readonly sequence: number;
}
export interface ManagedLifecycleChannelHandle {
  readonly launchId: string;
  readonly pid: number;
  readonly state: 'handoffAccepted' | 'runtimeReady';
  readonly ready: Promise<ManagedRuntimeRevisions>;
  readonly closed: Promise<{ code: string }>;
  close(): Promise<void>;
  /** Optional real-time authorization transport. Absent means fail closed. */
  authorize?(input: ManagedLifecycleAuthorizationInput): Promise<{ status: 'applied' | 'duplicate' }>;
}
export interface ManagedLifecyclePermitInput {
  readonly tool: string;
  readonly sourceServiceAssetId: string;
  readonly endpointDefinitionId: string;
  readonly method: string;
  readonly path: string;
}
/** Host-side live permit authority for one launch generation. The capability/
 * proof material it consumes never leaves the host process and never enters
 * this interface: `authorize` performs the live check internally and returns a
 * bounded decision only. */
export interface ManagedLifecyclePermitAuthority {
  readonly permitId: string;
  authorize(request: ManagedLifecyclePermitInput): Promise<{ readonly decision: 'allow' | 'deny' }>;
  revoke?(): void;
}
export interface ManagedLifecyclePermitContext {
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly payload: ManagedMcpHandoffV1;
}
/** Trusted-only, default-off seam: when absent the child keeps the E3b
 * default-open authorization behavior with no per-execution permit traffic. */
export type ManagedLifecyclePermitProvider = (context: ManagedLifecyclePermitContext) =>
  Promise<ManagedLifecyclePermitAuthority | undefined> | ManagedLifecyclePermitAuthority | undefined;
export interface ManagedLifecycleChannelInput {
  readonly launchId: string;
  readonly serverId: string;
  readonly payload: ManagedMcpHandoffV1;
  readonly approvedEnvironmentNames: readonly string[];
  readonly environmentValues: Readonly<Record<string, string>>;
  readonly permitAuthority?: ManagedLifecyclePermitAuthority;
}
export type ManagedLifecycleChannel = (input: ManagedLifecycleChannelInput) => Promise<ManagedLifecycleChannelHandle>;

export interface ManagedMcpLifecycleCoordinatorDeps {
  readonly store: ManagedMcpLifecycleStore;
  readonly capture: ManagedLifecycleCapture;
  readonly approval: ManagedLifecycleApprovalProvider;
  readonly channel?: ManagedLifecycleChannel;
  readonly now?: () => Date;
  /** Bounded, non-secret projection of committed terminal transitions. */
  readonly onStateChange?: ManagedLifecycleStateChangeSink;
  /** Opt-in trusted-only lease barrier. Absent keeps the established
   * default-off running-update behavior (explicit checkRevision/stop). */
  readonly lease?: ManagedChildSecurityLeaseCoordinator;
  /** Opt-in trusted-only per-execution permit provider. Absent keeps the E3b
   * default-open child behavior and sends no permit-mode traffic. */
  readonly permit?: ManagedLifecyclePermitProvider;
}

export interface ManagedLifecycleStartInput {
  readonly serverId: string;
  readonly runtimeAssetId: string;
}
export interface ManagedLifecycleStartResult {
  readonly status: 'started';
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly launchId: string;
  readonly pid: number;
  readonly snapshot: ManagedLifecycleSnapshotIdentity;
  readonly decision: ManagedLifecycleDecisionV1;
}
export interface ManagedLifecycleStopResult {
  readonly status: 'stopped' | 'already-stopped';
  readonly generation: number;
}
export interface ManagedLifecycleEventInput {
  readonly generation: number;
  readonly type: 'closed' | 'failed';
  readonly code?: string;
}
export interface ManagedLifecycleEventResult {
  readonly status: 'applied' | 'stale' | 'rejected';
}
export interface ManagedLifecycleStateChange {
  readonly serverId: string;
  readonly runtimeAssetId: string;
  readonly generation: number;
  readonly state: 'failed' | 'abandoned' | 'stopped';
  readonly reason: ManagedLifecycleTerminalReason;
  readonly code: string | null;
}
export type ManagedLifecycleStateChangeSink = (change: ManagedLifecycleStateChange) => void;
export type ManagedLifecycleStatusResult =
  | { readonly status: 'absent'; readonly serverId: string; readonly current: false }
  | { readonly status: 'invalid'; readonly serverId: string; readonly current: false }
  | { readonly status: 'observed'; readonly view: ManagedLifecyclePublicView };

export interface ManagedLifecycleRevisionInput {
  readonly serverId: string;
  readonly runtimeAssetId: string;
}

/**
 * Deterministic outcome of an explicit running-version check. A changed
 * Registry/candidate identity is re-prepared as a new generation only after
 * the previous generation is verified stopped. Any failure to re-verify the
 * trusted security state terminates the owned child instead of leaving it
 * running a generation that can no longer be proven current.
 */
export type ManagedLifecycleRevisionResult =
  | { readonly status: 'absent'; readonly serverId: string }
  | { readonly status: 'not-current'; readonly serverId: string; readonly state: ManagedLifecycleState; readonly generation: number }
  | { readonly status: 'in-progress'; readonly serverId: string; readonly state: ManagedLifecycleState; readonly generation: number }
  | { readonly status: 'foreign-current'; readonly serverId: string; readonly generation: number }
  | { readonly status: 'unchanged'; readonly serverId: string; readonly generation: number; readonly snapshotDigest: string }
  | { readonly status: 'restarted'; readonly serverId: string; readonly previousGeneration: number; readonly generation: number;
      readonly snapshot: ManagedLifecycleSnapshotIdentity; readonly snapshotDigest: string }
  | { readonly status: 'terminated'; readonly serverId: string; readonly generation: number; readonly code: string };

export interface ManagedLifecycleRevokeOptions {
  readonly code?: string;
}
export type ManagedLifecycleRevokeResult =
  | { readonly status: 'absent'; readonly serverId: string; readonly generation: 0 }
  | { readonly status: 'already-stopped'; readonly serverId: string; readonly generation: number; readonly code: string | null }
  | { readonly status: 'revoked'; readonly serverId: string; readonly generation: number; readonly code: string };

export type ManagedLifecycleAuthorizationResult =
  | { readonly status: 'applied' | 'duplicate'; readonly serverId: string; readonly generation: number;
      readonly decision: 'allow' | 'deny' | 'revoke'; readonly permitId: string; readonly sequence: number }
  | { readonly status: 'revoked'; readonly serverId: string; readonly generation: number;
      readonly permitId: string; readonly sequence: number; readonly code: string }
  | { readonly status: 'rejected'; readonly serverId: string };

/** Result of the running-update pre-block barrier. `clear` means every child
 * whose lease referenced the source is verified stopped, so the caller may
 * apply the security-relevant mutation and re-prepare/restart afterwards. */
export type ManagedLifecycleSourceUpdateResult =
  | { readonly status: 'unenforced'; readonly sourceAssetId: string }
  | { readonly status: 'clear'; readonly sourceAssetId: string; readonly isolatedGenerations: readonly number[] }
  | { readonly status: 'failed'; readonly sourceAssetId: string; readonly code: string };

export const MANAGED_MCP_LIFECYCLE_REVOKED_CODE = 'MANAGED_SECURITY_REVOKED';
export const MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE = 'MANAGED_SECURITY_STATE_INVALIDATED';
export const MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE = 'MANAGED_SECURITY_SOURCE_UPDATED';
export const MANAGED_MCP_AUTHORIZATION_UNVERIFIED_CODE = 'MANAGED_SECURITY_AUTHORIZATION_UNVERIFIED';

interface OwnedHandle {
  readonly generation: number;
  readonly handle: ManagedLifecycleChannelHandle;
  readonly sourceAssetIds: readonly string[];
  readonly permitAuthority?: ManagedLifecyclePermitAuthority;
  authorization?: { readonly sequence: number; readonly permitId: string; readonly decision: 'allow' | 'deny' | 'revoke' };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FAILURE_CODE = /^[A-Z0-9_]{1,80}$/;

export class ManagedMcpLifecycleCoordinator implements OnModuleDestroy {
  private readonly logger = new Logger(ManagedMcpLifecycleCoordinator.name);
  private readonly handles = new Map<string, OwnedHandle>();
  private readonly serial = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly channel?: ManagedLifecycleChannel;

  constructor(private readonly deps: ManagedMcpLifecycleCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.channel = deps.channel;
  }

  async onModuleDestroy(): Promise<void> {
    const entries = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(entries.map(entry => entry.handle.close()));
    for (const entry of entries) this.revokePermit(entry.permitAuthority);
  }

  private revokePermit(authority?: ManagedLifecyclePermitAuthority): void {
    try { authority?.revoke?.(); } catch { /* best-effort: permit identity is per-launch */ }
  }

  ownedGeneration(serverId: string): number | null {
    return this.handles.get(serverId)?.generation ?? null;
  }

  private async read(serverId: string): Promise<ManagedMcpLifecycleRead> {
    try {
      return await this.deps.store.read(serverId);
    } catch {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_STORE_UNAVAILABLE');
    }
  }

  private async commit(serverId: string, expectedUpdatedAt: string | null, record: ManagedLifecycleRecordV1): Promise<string | null> {
    try {
      const result = await this.deps.store.compareAndSwap(serverId, expectedUpdatedAt, record);
      return result.status === 'applied' ? result.updatedAt : null;
    } catch {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_STORE_UNAVAILABLE');
    }
  }

  private record(
    base: ManagedLifecycleRecordV1 | null,
    patch: {
      serverId: string;
      runtimeAssetId: string;
      generation: number;
      state: ManagedLifecycleState;
      currentVerified: boolean;
      updatedAt: string;
      launchId?: string | null;
      pid?: number | null;
      snapshot?: ManagedLifecycleSnapshotIdentity | null;
      startDecision?: ManagedLifecycleDecisionV1 | null;
      stopDecision?: ManagedLifecycleDecisionV1 | null;
      terminal?: ManagedLifecycleTerminalV1 | null;
      appendDecision?: ManagedLifecycleDecisionV1;
    },
  ): ManagedLifecycleRecordV1 {
    const history = [...(base?.decisions ?? [])];
    if (patch.appendDecision) history.push(patch.appendDecision);
    const record = parseManagedLifecycleRecord({
      version: 1,
      serverId: patch.serverId,
      runtimeAssetId: patch.runtimeAssetId,
      generation: patch.generation,
      state: patch.state,
      launchId: patch.launchId !== undefined ? patch.launchId : (base?.launchId ?? null),
      pid: patch.pid !== undefined ? patch.pid : (base?.pid ?? null),
      snapshot: patch.snapshot !== undefined ? patch.snapshot : (base?.snapshot ?? null),
      startDecision: patch.startDecision !== undefined ? patch.startDecision : (base?.startDecision ?? null),
      stopDecision: patch.stopDecision !== undefined ? patch.stopDecision : (base?.stopDecision ?? null),
      terminal: patch.terminal !== undefined ? patch.terminal : (base?.terminal ?? null),
      currentVerified: patch.currentVerified,
      decisions: history.slice(-MANAGED_MCP_LIFECYCLE_MAX_DECISIONS),
      updatedAt: patch.updatedAt,
    });
    if (!record) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
    return record;
  }

  private terminal(reason: ManagedLifecycleTerminalReason, verifiedByParent: boolean, code: string | null): ManagedLifecycleTerminalV1 {
    return Object.freeze({ observedAt: this.now().toISOString(), reason, verifiedByParent,
      code: code && FAILURE_CODE.test(code) ? code : null });
  }

  private notify(change: ManagedLifecycleStateChange): void {
    const sink = this.deps.onStateChange;
    if (!sink) return;
    try {
      sink(Object.freeze({ ...change }));
    } catch {
      this.logger.warn(`Managed lifecycle state change sink failed for server ${change.serverId}`);
    }
  }

  private async approve(
    action: ManagedLifecycleAction,
    serverId: string,
    runtimeAssetId: string,
    generation: number,
    snapshot: ManagedLifecycleSnapshotIdentity | null,
  ): Promise<ManagedLifecycleDecisionV1> {
    let decision: ManagedLifecycleDecisionV1 | null = null;
    try {
      decision = await this.deps.approval({ action, serverId, runtimeAssetId, generation, snapshot });
    } catch {
      decision = null;
    }
    const snapshotDigest = snapshot ? managedLifecycleSnapshotDigest(snapshot) : null;
    if (!managedLifecycleDecisionValid(decision, { action, generation, snapshotDigest })) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_APPROVAL_REJECTED');
    }
    return decision;
  }

  private async failTransition(serverId: string, expectedUpdatedAt: string, base: ManagedLifecycleRecordV1, code: string): Promise<void> {
    const terminal = this.terminal('runtime_failed', true, code);
    const failed = this.record(base, { serverId, runtimeAssetId: base.runtimeAssetId, generation: base.generation,
      state: 'failed', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
    const token = await this.commit(serverId, expectedUpdatedAt, failed).catch(() => null);
    if (token) this.notify({ serverId, runtimeAssetId: base.runtimeAssetId, generation: base.generation,
      state: 'failed', reason: terminal.reason, code: terminal.code });
  }

  private observeClosed(serverId: string, generation: number, handle: ManagedLifecycleChannelHandle): void {
    const apply = (code: string) => {
      if (this.handles.get(serverId)?.generation !== generation) return;
      void this.event(serverId, { generation, type: 'closed', code }).catch(() => undefined);
    };
    void handle.closed.then(
      result => apply(result?.code),
      () => apply('MANAGED_LIFECYCLE_CHANNEL_FAILED'),
    );
  }

  private async freshCapture(runtimeAssetId: string, serverId: string): Promise<{
    readonly payload: ManagedMcpHandoffV1;
    readonly snapshot: ManagedLifecycleSnapshotIdentity;
    readonly captured: ManagedLifecycleCapturedHandoff;
  } | null> {
    let captured: ManagedLifecycleCapturedHandoff;
    try {
      captured = await this.deps.capture(runtimeAssetId, serverId);
    } catch {
      return null;
    }
    const payload = captured?.payload;
    if (!payload || !IDENTIFIER.test(String(payload.launchId ?? ''))) return null;
    const snapshot = managedLifecycleSnapshot({
      runtimeAssetId: String(payload.runtimeAssetId ?? ''), candidateRevision: String(payload.candidateRevision ?? ''),
      verificationRunId: String(payload.verificationRunId ?? ''), behaviorFingerprint: String(payload.behaviorFingerprint ?? ''),
      inboundAuthMode: String(payload.inboundAuthMode ?? ''), registrySource: payload.registrySource as ManagedLifecycleSnapshotSource['registrySource'] });
    if (!snapshot || snapshot.runtimeAssetId !== runtimeAssetId) return null;
    return { payload, snapshot, captured };
  }

  async start(input: ManagedLifecycleStartInput): Promise<ManagedLifecycleStartResult> {
    const { serverId, runtimeAssetId } = input ?? { serverId: '', runtimeAssetId: '' };
    if (!IDENTIFIER.test(serverId) || !IDENTIFIER.test(runtimeAssetId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const read = await this.read(serverId);
    if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
    if (read.status === 'valid' && read.record.runtimeAssetId !== runtimeAssetId) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    // A generation that is current or mid-start belongs to exactly one parent
    // process. A process that does not own it must not advance the record over
    // a possibly live child; recovery requires an explicit reconcile first.
    if (read.status === 'valid' && (read.record.state === 'starting' || read.record.state === 'current')) {
      if (read.record.state === 'current' && this.ownedGeneration(serverId) === read.record.generation) {
        throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_ALREADY_CURRENT');
      }
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    }
    const generation = (read.status === 'valid' ? read.record.generation : 0) + 1;
    if (generation > MANAGED_MCP_LIFECYCLE_MAX_GENERATION) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_GENERATION_EXHAUSTED');
    const superseded = this.handles.get(serverId);
    if (superseded) {
      this.handles.delete(serverId);
      await superseded.handle.close().catch(() => undefined);
      this.revokePermit(superseded.permitAuthority);
    }
    const fresh = await this.freshCapture(runtimeAssetId, serverId);
    if (!fresh) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED');
    const { payload, snapshot, captured } = fresh;
    // Trusted-only opt-in: a fresh host permit authority per launch generation.
    // Any provider failure rejects the start before a child is spawned; the
    // permit capability itself stays host-side and never reaches the channel.
    let permitAuthority: ManagedLifecyclePermitAuthority | undefined;
    if (this.deps.permit) {
      try { permitAuthority = await this.deps.permit({ serverId, runtimeAssetId, generation, payload }); }
      catch { throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED'); }
      if (!permitAuthority || !IDENTIFIER.test(String(permitAuthority.permitId ?? '')) || typeof permitAuthority.authorize !== 'function') {
        throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
      }
    }
    const decision = await this.approve('start', serverId, runtimeAssetId, generation, snapshot);
    const startedAt = this.now().toISOString();
    const starting = this.record(read.status === 'valid' ? read.record : null, {
      serverId, runtimeAssetId, generation, state: 'starting', currentVerified: false, updatedAt: startedAt,
      launchId: payload.launchId, pid: null, snapshot, startDecision: decision, stopDecision: null, terminal: null, appendDecision: decision,
    });
    const startingToken = await this.commit(serverId, read.status === 'valid' ? read.updatedAt : null, starting);
    if (!startingToken) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
    }
    if (!this.channel) {
      await this.failTransition(serverId, startingToken, starting, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    }
    let handle: ManagedLifecycleChannelHandle;
    try {
      handle = await this.channel({ launchId: payload.launchId, serverId, payload,
        approvedEnvironmentNames: captured.approvedEnvironmentNames ?? [], environmentValues: captured.environmentValues ?? {},
        permitAuthority });
    } catch {
      this.revokePermit(permitAuthority);
      await this.failTransition(serverId, startingToken, starting, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    }
    const sourceAssetIds = Object.freeze([...new Set(payload.trustedOperationBindings
      .map(binding => String(binding?.sourceServiceAssetId ?? ''))
      .filter(value => IDENTIFIER.test(value)))]);
    this.handles.set(serverId, { generation, handle, sourceAssetIds, permitAuthority });
    try {
      await handle.ready;
    } catch {
      this.handles.delete(serverId);
      await handle.close().catch(() => undefined);
      this.revokePermit(permitAuthority);
      await this.failTransition(serverId, startingToken, starting, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    }
    const current = this.record(starting, { serverId, runtimeAssetId, generation, state: 'current', currentVerified: true,
      updatedAt: this.now().toISOString(), pid: handle.pid });
    if (!await this.commit(serverId, startingToken, current)) {
      this.handles.delete(serverId);
      await handle.close().catch(() => undefined);
      this.revokePermit(permitAuthority);
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
    }
    if (this.deps.lease) {
      // The barrier is trusted-only and explicit: a lease is registered only
      // for the owned, verified current generation. Registration failure must
      // never leave an unprotected child running.
      try {
        this.deps.lease.register({ serverId, launchId: payload.launchId,
          contextToken: managedLifecycleSnapshotDigest(snapshot), sourceAssetIds }, {
          stop: () => this.terminateLease(serverId, generation),
          closed: handle.closed,
        });
      } catch {
        await this.forceTerminate(serverId, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE).catch(() => undefined);
        throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
      }
    }
    this.observeClosed(serverId, generation, handle);
    this.logger.log(`Managed lifecycle generation ${generation} is current for server ${serverId} (PID ${handle.pid})`);
    return { status: 'started', serverId, runtimeAssetId, generation, launchId: payload.launchId, pid: handle.pid, snapshot, decision };
  }

  async stop(serverId: string): Promise<ManagedLifecycleStopResult> {
    if (!IDENTIFIER.test(serverId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const read = await this.read(serverId);
    if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
    if (read.status === 'absent') return { status: 'already-stopped', generation: 0 };
    const record = read.record;
    if (record.state === 'stopped' || record.state === 'failed' || record.state === 'abandoned') {
      return { status: 'already-stopped', generation: record.generation };
    }
    // Only the owning process can stop a live current child. A foreign stop
    // would write a terminal state it cannot back with an actual child exit.
    if (record.state === 'current' && this.ownedGeneration(serverId) !== record.generation) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    }
    const snapshotDigest = record.snapshot ? managedLifecycleSnapshotDigest(record.snapshot) : null;
    if (record.state === 'stopping') {
      if (!managedLifecycleDecisionValid(record.stopDecision, { action: 'stop', generation: record.generation, snapshotDigest })) {
        throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_APPROVAL_REJECTED');
      }
      return this.finalizeStop(serverId, read.updatedAt, record);
    }
    const decision = await this.approve('stop', serverId, record.runtimeAssetId, record.generation, record.snapshot);
    const stopping = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: 'stopping', currentVerified: false, updatedAt: this.now().toISOString(), stopDecision: decision,
      terminal: null, appendDecision: decision });
    const stoppingToken = await this.commit(serverId, read.updatedAt, stopping);
    if (!stoppingToken) {
      const retry = await this.read(serverId);
      if (retry.status === 'valid' && (retry.record.state === 'stopped' || retry.record.state === 'failed' || retry.record.state === 'abandoned')) {
        return { status: 'already-stopped', generation: retry.record.generation };
      }
      if (retry.status === 'valid' && retry.record.state === 'stopping') {
        const retryDigest = retry.record.snapshot ? managedLifecycleSnapshotDigest(retry.record.snapshot) : null;
        if (!managedLifecycleDecisionValid(retry.record.stopDecision, { action: 'stop', generation: retry.record.generation, snapshotDigest: retryDigest })) {
          throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_APPROVAL_REJECTED');
        }
        return this.finalizeStop(serverId, retry.updatedAt, retry.record);
      }
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
    }
    return this.finalizeStop(serverId, stoppingToken, stopping);
  }

  private async finalizeStop(serverId: string, expectedUpdatedAt: string, record: ManagedLifecycleRecordV1): Promise<ManagedLifecycleStopResult> {
    const entry = this.handles.get(serverId);
    let verified = false;
    if (entry && entry.generation === record.generation) {
      this.handles.delete(serverId);
      try {
        await entry.handle.close();
        await entry.handle.closed;
        verified = true;
      } catch { verified = false; }
      this.revokePermit(entry.permitAuthority);
    }
    const terminal = this.terminal('stopped', verified, 'STOPPED');
    const stopped = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: 'stopped', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
    const stoppedToken = await this.commit(serverId, expectedUpdatedAt, stopped);
    if (!stoppedToken) {
      const retry = await this.read(serverId);
      if (retry.status === 'valid' && (retry.record.state === 'stopped' || retry.record.state === 'failed' || retry.record.state === 'abandoned')) {
        return { status: 'already-stopped', generation: retry.record.generation };
      }
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
    }
    this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: 'stopped', reason: terminal.reason, code: terminal.code });
    return { status: 'stopped', generation: record.generation };
  }

  async event(serverId: string, input: ManagedLifecycleEventInput): Promise<ManagedLifecycleEventResult> {
    if (!IDENTIFIER.test(serverId) || !input || !Number.isSafeInteger(input.generation) || !['closed', 'failed'].includes(input.type)) {
      return { status: 'rejected' };
    }
    const read = await this.read(serverId);
    if (read.status === 'invalid') return { status: 'rejected' };
    if (read.status === 'absent' || read.record.generation !== input.generation) return { status: 'stale' };
    const record = read.record;
    if (record.state !== 'current' && record.state !== 'starting' && record.state !== 'stopping') return { status: 'stale' };
    // Child lifecycle events are only valid from the parent that owns the live
    // handle; a foreign process must not terminate another instance's child.
    if (this.ownedGeneration(serverId) !== record.generation) return { status: 'rejected' };
    const stopping = record.state === 'stopping';
    const terminal = this.terminal(stopping ? 'stopped' : 'runtime_failed', true, input.code ?? null);
    const next = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: stopping ? 'stopped' : 'failed', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
    if (!await this.commit(serverId, read.updatedAt, next)) return { status: 'stale' };
    const entry = this.handles.get(serverId);
    if (entry && entry.generation === record.generation) {
      this.handles.delete(serverId);
      await entry.handle.close().catch(() => undefined);
      this.revokePermit(entry.permitAuthority);
    }
    this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: stopping ? 'stopped' : 'failed', reason: terminal.reason, code: terminal.code });
    return { status: 'applied' };
  }

  async reconcile(serverId: string): Promise<ManagedLifecycleStatusResult> {
    if (!IDENTIFIER.test(serverId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const read = await this.read(serverId);
    if (read.status === 'absent') return { status: 'absent', serverId, current: false };
    if (read.status === 'invalid') return { status: 'invalid', serverId, current: false };
    const record = read.record;
    if (record.state === 'current') {
      if (this.ownedGeneration(serverId) === record.generation && record.currentVerified) {
        return { status: 'observed', view: managedLifecyclePublicView(record, true) };
      }
      const terminal = this.terminal('unverified_discovered_child', false, null);
      const abandoned = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'abandoned', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
      const token = await this.commit(serverId, read.updatedAt, abandoned);
      if (!token) return this.status(serverId);
      this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'abandoned', reason: terminal.reason, code: terminal.code });
      return { status: 'observed', view: managedLifecyclePublicView(abandoned, false) };
    }
    if (record.state === 'starting') {
      const terminal = this.terminal('parent_transition_interrupted', false, null);
      const abandoned = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'abandoned', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
      const token = await this.commit(serverId, read.updatedAt, abandoned);
      if (!token) return this.status(serverId);
      this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'abandoned', reason: terminal.reason, code: terminal.code });
      return { status: 'observed', view: managedLifecyclePublicView(abandoned, false) };
    }
    if (record.state === 'stopping') {
      const terminal = this.terminal('stop_reconciled_without_parent', false, null);
      const stopped = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'stopped', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
      const token = await this.commit(serverId, read.updatedAt, stopped);
      if (!token) return this.status(serverId);
      this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
        state: 'stopped', reason: terminal.reason, code: terminal.code });
      return { status: 'observed', view: managedLifecyclePublicView(stopped, false) };
    }
    return { status: 'observed', view: managedLifecyclePublicView(record, false) };
  }

  /** Serializes the explicit check/revoke signals per server so repeated or
   * concurrent signals cannot interleave and double-apply a transition. */
  private serialize<T>(serverId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(serverId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const guard = result.then(() => undefined, () => undefined);
    this.serial.set(serverId, guard);
    void guard.then(() => { if (this.serial.get(serverId) === guard) this.serial.delete(serverId); });
    return result;
  }

  /** Fail-closed termination of an owned live generation with a distinct
   * security terminal. Does not consult the approval policy: when the policy
   * or the trusted snapshot itself is what got revoked, termination must not be
   * blocked by it. The child is closed before the terminal is committed. */
  private async forceTerminate(serverId: string, code: string): Promise<{ generation: number; code: string }> {
    const read = await this.read(serverId);
    if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
    if (read.status === 'absent') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const record = read.record;
    if (record.state !== 'starting' && record.state !== 'current' && record.state !== 'stopping') {
      return { generation: record.generation, code: record.terminal?.code ?? code };
    }
    if (this.ownedGeneration(serverId) !== record.generation) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    }
    const entry = this.handles.get(serverId);
    this.handles.delete(serverId);
    let verified = false;
    if (entry && entry.generation === record.generation) {
      try {
        await entry.handle.close();
        await entry.handle.closed;
        verified = true;
      } catch { verified = false; }
      this.revokePermit(entry.permitAuthority);
    }
    return this.commitSecurityTerminal(serverId, read.updatedAt, record, verified, code);
  }

  /** Persist a `security_revoked` terminal exactly once after the owned child
   * has been closed. A concurrent terminal writer wins the CAS and its code is
   * reported without ever reviving the lease. */
  private async commitSecurityTerminal(serverId: string, expectedUpdatedAt: string, record: ManagedLifecycleRecordV1,
    verified: boolean, code: string): Promise<{ generation: number; code: string }> {
    const terminalCode = FAILURE_CODE.test(code) ? code : MANAGED_MCP_LIFECYCLE_REVOKED_CODE;
    const terminal = this.terminal('security_revoked', verified, terminalCode);
    const revoked = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: 'stopped', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
    const token = await this.commit(serverId, expectedUpdatedAt, revoked);
    if (!token) {
      const retry = await this.read(serverId);
      if (retry.status === 'valid' && (retry.record.state === 'stopped' || retry.record.state === 'failed' || retry.record.state === 'abandoned')) {
        return { generation: retry.record.generation, code: retry.record.terminal?.code ?? terminalCode };
      }
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
    }
    this.notify({ serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: 'stopped', reason: terminal.reason, code: terminal.code });
    return { generation: record.generation, code: terminal.code ?? terminalCode };
  }

  /** Lease-barrier stop: the E3a coordinator calls this synchronously blocks
   * the lease and awaits the child's verified termination before an update may
   * touch the referenced source asset. */
  private async terminateLease(serverId: string, generation: number): Promise<void> {
    const entry = this.handles.get(serverId);
    if (!entry || entry.generation !== generation) return;
    await this.forceTerminate(serverId, MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE);
  }

  /** Explicit running-version/security check. A current trusted child is
   * compared against a fresh trusted preparation of the same runtime asset:
   * unchanged identity is a no-op, changed identity stops the old generation
   * and re-prepares a new one, and any capture failure terminates the child so
   * it cannot keep executing a generation that is no longer verifiable. */
  async checkRevision(input: ManagedLifecycleRevisionInput): Promise<ManagedLifecycleRevisionResult> {
    const { serverId, runtimeAssetId } = input ?? { serverId: '', runtimeAssetId: '' };
    if (!IDENTIFIER.test(serverId) || !IDENTIFIER.test(runtimeAssetId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    return this.serialize(serverId, async () => {
      const read = await this.read(serverId);
      if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
      if (read.status === 'absent') return { status: 'absent', serverId };
      const record = read.record;
      if (record.runtimeAssetId !== runtimeAssetId) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
      if (record.state === 'starting' || record.state === 'stopping') {
        return { status: 'in-progress', serverId, state: record.state, generation: record.generation };
      }
      if (record.state !== 'current') return { status: 'not-current', serverId, state: record.state, generation: record.generation };
      if (this.ownedGeneration(serverId) !== record.generation) return { status: 'foreign-current', serverId, generation: record.generation };
      const fresh = await this.freshCapture(runtimeAssetId, serverId);
      if (!fresh) {
        const terminated = await this.forceTerminate(serverId, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE).catch(() => null);
        if (!terminated) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED');
        return { status: 'terminated', serverId, generation: terminated.generation, code: terminated.code };
      }
      const digest = managedLifecycleSnapshotDigest(fresh.snapshot);
      if (record.snapshot && managedLifecycleSnapshotDigest(record.snapshot) === digest) {
        return { status: 'unchanged', serverId, generation: record.generation, snapshotDigest: digest };
      }
      let previous: number;
      try {
        previous = (await this.stop(serverId)).generation;
      } catch (error) {
        if (error instanceof ManagedMcpLifecycleError && error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT') throw error;
        const terminated = await this.forceTerminate(serverId, MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE).catch(() => null);
        if (terminated) return { status: 'terminated', serverId, generation: terminated.generation, code: terminated.code };
        throw error;
      }
      try {
        const started = await this.start({ serverId, runtimeAssetId });
        return { status: 'restarted', serverId, previousGeneration: previous, generation: started.generation,
          snapshot: started.snapshot, snapshotDigest: managedLifecycleSnapshotDigest(started.snapshot) };
      } catch (error) {
        const code = error instanceof ManagedMcpLifecycleError ? error.code : MANAGED_MCP_LIFECYCLE_REVOKED_CODE;
        const after = await this.read(serverId).catch(() => null);
        const generation = after?.status === 'valid' ? after.record.generation : previous;
        return { status: 'terminated', serverId, generation, code };
      }
    });
  }

  /** Explicit security revocation of the running generation. Termination is
   * verified, persisted with a `security_revoked` terminal and never restarts
   * by itself; any later start still has to re-prepare and pass approval. */
  async revoke(serverId: string, options: ManagedLifecycleRevokeOptions = {}): Promise<ManagedLifecycleRevokeResult> {
    if (!IDENTIFIER.test(serverId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const requested = typeof options?.code === 'string' && FAILURE_CODE.test(options.code) ? options.code : MANAGED_MCP_LIFECYCLE_REVOKED_CODE;
    return this.serialize(serverId, async () => {
      const read = await this.read(serverId);
      if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
      if (read.status === 'absent') return { status: 'absent', serverId, generation: 0 };
      const record = read.record;
      if (record.state !== 'starting' && record.state !== 'current' && record.state !== 'stopping') {
        return { status: 'already-stopped', serverId, generation: record.generation, code: record.terminal?.code ?? null };
      }
      if (this.ownedGeneration(serverId) !== record.generation) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_FOREIGN_CURRENT');
      const terminated = await this.forceTerminate(serverId, requested);
      return { status: 'revoked', serverId, generation: terminated.generation, code: terminated.code };
    });
  }

  /** Real-time authorization over the existing child IPC channel. Decisions
   * are pushed and acknowledged within the channel's bounded wait; a missing
   * or malformed acknowledgement terminates the child fail closed. Repeated
   * verbatim delivery is idempotent, conflicting reuse of a sequence is
   * rejected without touching the child. */
  async authorize(serverId: string, input: ManagedLifecycleAuthorizationInput): Promise<ManagedLifecycleAuthorizationResult> {
    const decision = input?.decision, permitId = input?.permitId, sequence = input?.sequence;
    if (!IDENTIFIER.test(serverId) || !['allow', 'deny', 'revoke'].includes(decision) || !IDENTIFIER.test(String(permitId)) ||
      !Number.isSafeInteger(sequence) || sequence < 1 || sequence > MANAGED_MCP_LIFECYCLE_MAX_GENERATION) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    }
    return this.serialize(serverId, async () => {
      const read = await this.read(serverId);
      if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
      if (read.status === 'absent') return { status: 'rejected', serverId };
      const record = read.record;
      if (record.state !== 'current' || this.ownedGeneration(serverId) !== record.generation) return { status: 'rejected', serverId };
      const entry = this.handles.get(serverId)!;
      if (typeof entry.handle.authorize !== 'function') return { status: 'rejected', serverId };
      const previous = entry.authorization;
      if (previous && previous.sequence === sequence) {
        if (previous.permitId === permitId && previous.decision === decision) {
          return { status: 'duplicate', serverId, generation: record.generation, decision, permitId, sequence };
        }
        return { status: 'rejected', serverId };
      }
      if (previous && sequence <= previous.sequence) return { status: 'rejected', serverId };
      let ack: { status: 'applied' | 'duplicate' };
      try {
        ack = await entry.handle.authorize({ decision, permitId, sequence });
      } catch {
        await this.forceTerminate(serverId, MANAGED_MCP_AUTHORIZATION_UNVERIFIED_CODE).catch(() => undefined);
        return { status: 'rejected', serverId };
      }
      if (ack?.status !== 'applied' && ack?.status !== 'duplicate') {
        await this.forceTerminate(serverId, MANAGED_MCP_AUTHORIZATION_UNVERIFIED_CODE).catch(() => undefined);
        return { status: 'rejected', serverId };
      }
      entry.authorization = Object.freeze({ sequence, permitId, decision });
      if (decision === 'revoke') {
        const terminated = await this.forceTerminate(serverId, MANAGED_MCP_LIFECYCLE_REVOKED_CODE);
        return { status: 'revoked', serverId, generation: terminated.generation, permitId, sequence, code: terminated.code };
      }
      return { status: ack.status, serverId, generation: record.generation, decision, permitId, sequence };
    });
  }

  /** Running-update pre-block barrier for an explicit security-relevant source
   * update (credential/registry revision). While the trusted lease is enabled
   * this synchronously blocks every affected lease, stops the owned children
   * and waits for verified closure, so the caller may only apply the mutation
   * after the barrier returns `clear`. Without the opt-in lease it reports
   * `unenforced`; the established explicit `checkRevision` route (stop /
   * re-prepare / restart) remains the supported default-off path. */
  async isolateSourceForUpdate(sourceAssetId: string): Promise<ManagedLifecycleSourceUpdateResult> {
    if (!IDENTIFIER.test(sourceAssetId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const lease = this.deps.lease;
    if (!lease) return { status: 'unenforced', sourceAssetId };
    const isolatedGenerations = Object.freeze([...this.handles.values()]
      .filter(entry => entry.sourceAssetIds.includes(sourceAssetId))
      .map(entry => entry.generation)
      .sort((a, b) => a - b));
    try {
      await lease.isolateSource(sourceAssetId);
    } catch {
      return { status: 'failed', sourceAssetId, code: 'MANAGED_ISOLATION_FAILED' };
    }
    return { status: 'clear', sourceAssetId, isolatedGenerations };
  }

  async status(serverId: string): Promise<ManagedLifecycleStatusResult> {
    const result = await readManagedMcpLifecycleStatus(this.deps.store, serverId);
    if (result.status !== 'observed') return result;
    const current = result.view.state === 'current' && result.view.currentVerified &&
      this.ownedGeneration(serverId) === result.view.generation;
    return { status: 'observed', view: Object.freeze({ ...result.view, current }) };
  }
}

/** Read-only cross-process projection of the shared coordination record.
 * Never mutates the store and never touches a child; any process holding the
 * shared store may observe state, generation, Registry identity, approvals,
 * and the last static failure code of the owning process. */
export async function readManagedMcpLifecycleStatus(
  store: ManagedMcpLifecycleStore,
  serverId: string,
): Promise<ManagedLifecycleStatusResult> {
  if (!IDENTIFIER.test(serverId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
  let read: ManagedMcpLifecycleRead;
  try {
    read = await store.read(serverId);
  } catch {
    throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_STORE_UNAVAILABLE');
  }
  if (read.status === 'absent') return { status: 'absent', serverId, current: false };
  if (read.status === 'invalid') return { status: 'invalid', serverId, current: false };
  return { status: 'observed', view: managedLifecyclePublicView(read.record, false) };
}
