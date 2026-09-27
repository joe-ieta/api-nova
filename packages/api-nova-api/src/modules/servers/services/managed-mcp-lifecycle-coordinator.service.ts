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

export interface ManagedLifecycleCapturedHandoff {
  readonly payload: ManagedMcpHandoffV1;
  readonly approvedEnvironmentNames: readonly string[];
  readonly environmentValues: Readonly<Record<string, string>>;
}
export type ManagedLifecycleCapture = (runtimeAssetId: string, serverId: string) => Promise<ManagedLifecycleCapturedHandoff>;

export interface ManagedLifecycleChannelHandle {
  readonly launchId: string;
  readonly pid: number;
  readonly state: 'handoffAccepted' | 'runtimeReady';
  readonly ready: Promise<ManagedRuntimeRevisions>;
  readonly closed: Promise<{ code: string }>;
  close(): Promise<void>;
}
export interface ManagedLifecycleChannelInput {
  readonly launchId: string;
  readonly serverId: string;
  readonly payload: ManagedMcpHandoffV1;
  readonly approvedEnvironmentNames: readonly string[];
  readonly environmentValues: Readonly<Record<string, string>>;
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

interface OwnedHandle {
  readonly generation: number;
  readonly handle: ManagedLifecycleChannelHandle;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FAILURE_CODE = /^[A-Z0-9_]{1,80}$/;

export class ManagedMcpLifecycleCoordinator implements OnModuleDestroy {
  private readonly logger = new Logger(ManagedMcpLifecycleCoordinator.name);
  private readonly handles = new Map<string, OwnedHandle>();
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

  async start(input: ManagedLifecycleStartInput): Promise<ManagedLifecycleStartResult> {
    const { serverId, runtimeAssetId } = input ?? { serverId: '', runtimeAssetId: '' };
    if (!IDENTIFIER.test(serverId) || !IDENTIFIER.test(runtimeAssetId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const read = await this.read(serverId);
    if (read.status === 'invalid') throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_INVALID_RECORD');
    if (read.status === 'valid' && read.record.runtimeAssetId !== runtimeAssetId) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    if (read.status === 'valid' && read.record.state === 'current' && this.ownedGeneration(serverId) === read.record.generation) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_ALREADY_CURRENT');
    }
    const generation = (read.status === 'valid' ? read.record.generation : 0) + 1;
    if (generation > MANAGED_MCP_LIFECYCLE_MAX_GENERATION) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_GENERATION_EXHAUSTED');
    const superseded = this.handles.get(serverId);
    if (superseded) {
      this.handles.delete(serverId);
      await superseded.handle.close().catch(() => undefined);
    }
    let captured: ManagedLifecycleCapturedHandoff;
    try {
      captured = await this.deps.capture(runtimeAssetId, serverId);
    } catch {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED');
    }
    const payload = captured?.payload;
    if (!payload || !IDENTIFIER.test(String(payload.launchId ?? ''))) {
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED');
    }
    const snapshot = managedLifecycleSnapshot({
      runtimeAssetId: String(payload.runtimeAssetId ?? ''), candidateRevision: String(payload.candidateRevision ?? ''),
      verificationRunId: String(payload.verificationRunId ?? ''), behaviorFingerprint: String(payload.behaviorFingerprint ?? ''),
      inboundAuthMode: String(payload.inboundAuthMode ?? ''), registrySource: payload.registrySource as ManagedLifecycleSnapshotSource['registrySource'] });
    if (!snapshot || snapshot.runtimeAssetId !== runtimeAssetId) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CAPTURE_FAILED');
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
        approvedEnvironmentNames: captured.approvedEnvironmentNames ?? [], environmentValues: captured.environmentValues ?? {} });
    } catch {
      await this.failTransition(serverId, startingToken, starting, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    }
    this.handles.set(serverId, { generation, handle });
    try {
      await handle.ready;
    } catch {
      this.handles.delete(serverId);
      await handle.close().catch(() => undefined);
      await this.failTransition(serverId, startingToken, starting, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CHANNEL_FAILED');
    }
    const current = this.record(starting, { serverId, runtimeAssetId, generation, state: 'current', currentVerified: true,
      updatedAt: this.now().toISOString(), pid: handle.pid });
    if (!await this.commit(serverId, startingToken, current)) {
      this.handles.delete(serverId);
      await handle.close().catch(() => undefined);
      throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_CONFLICT');
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
    const stopping = record.state === 'stopping';
    const terminal = this.terminal(stopping ? 'stopped' : 'runtime_failed', true, input.code ?? null);
    const next = this.record(record, { serverId, runtimeAssetId: record.runtimeAssetId, generation: record.generation,
      state: stopping ? 'stopped' : 'failed', currentVerified: false, updatedAt: this.now().toISOString(), terminal });
    if (!await this.commit(serverId, read.updatedAt, next)) return { status: 'stale' };
    const entry = this.handles.get(serverId);
    if (entry && entry.generation === record.generation) {
      this.handles.delete(serverId);
      await entry.handle.close().catch(() => undefined);
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

  async status(serverId: string): Promise<ManagedLifecycleStatusResult> {
    if (!IDENTIFIER.test(serverId)) throw new ManagedMcpLifecycleError('MANAGED_LIFECYCLE_REJECTED');
    const read = await this.read(serverId);
    if (read.status === 'absent') return { status: 'absent', serverId, current: false };
    if (read.status === 'invalid') return { status: 'invalid', serverId, current: false };
    const current = read.record.state === 'current' && read.record.currentVerified && this.ownedGeneration(serverId) === read.record.generation;
    return { status: 'observed', view: managedLifecyclePublicView(read.record, current) };
  }
}
