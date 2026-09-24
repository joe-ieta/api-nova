import { Injectable } from '@nestjs/common';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';

export const MANAGED_PROCESS_LIFECYCLE_PREFIX = 'call-observability:managed-process:';
export const MANAGED_PROCESS_LIFECYCLE_SCOPE = 'managed_server_process_lifecycle';

export type ManagedProcessLifecycleEvent = 'started' | 'stopped' | 'unexpected_exit' | 'lost';
export type ManagedProcessLifecycleWriteStatus = 'applied' | 'duplicate' | 'stale';

export interface ManagedProcessLifecycleIdentity {
  runtimeAssetId: string;
  serverId: string;
  generation: string;
  pid: number;
  startedAt: string;
}

export interface ManagedProcessLifecycleTerminalDetails {
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
}

export interface ManagedProcessLifecycleView {
  evidenceScope: typeof MANAGED_PROCESS_LIFECYCLE_SCOPE;
  businessProcessLivenessEvaluated: false;
  runtimeAssetId: string;
  serverId: string;
  generation: string;
  pid: number;
  observedEvent: ManagedProcessLifecycleEvent;
  startedAt: string;
  observedAt: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  stateVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENTS: ManagedProcessLifecycleEvent[] = ['started', 'stopped', 'unexpected_exit', 'lost'];

function trustedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validIdentity(identity: ManagedProcessLifecycleIdentity): boolean {
  return trustedText(identity.runtimeAssetId, 160) && trustedText(identity.serverId, 160) &&
    UUID.test(identity.generation) && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    canonicalTimestamp(identity.startedAt);
}

function stateId(runtimeAssetId: string): string {
  return `${MANAGED_PROCESS_LIFECYCLE_PREFIX}${runtimeAssetId}`;
}

export function managedProcessLifecycleView(
  row: RuntimePipelineStateEntity | null | undefined,
  runtimeAssetId: string,
): ManagedProcessLifecycleView | null {
  const value = row?.value;
  if (!value || value.evidenceScope !== MANAGED_PROCESS_LIFECYCLE_SCOPE ||
    value.businessProcessLivenessEvaluated !== false || value.runtimeAssetId !== runtimeAssetId ||
    !trustedText(value.runtimeAssetId, 160) || !trustedText(value.serverId, 160) ||
    !UUID.test(value.generation) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    !EVENTS.includes(value.observedEvent) || !canonicalTimestamp(value.startedAt) ||
    !canonicalTimestamp(value.observedAt) || Date.parse(value.observedAt) < Date.parse(value.startedAt) ||
    !canonicalTimestamp(row.updatedAt) || row.updatedAt !== value.observedAt ||
    !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1 || value.stateVersion > 2147483647 ||
    !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
    !(value.signal === null || trustedText(value.signal, 80)) ||
    !(value.error === null || trustedText(value.error, 500))) return null;
  if (value.observedEvent === 'started' &&
    (value.exitCode !== null || value.signal !== null || value.error !== null)) return null;
  return value as ManagedProcessLifecycleView;
}

@Injectable()
export class ManagedProcessLifecycleEvidenceService {
  constructor(private readonly store: CallObservabilityStore) {}

  recordStarted(identity: ManagedProcessLifecycleIdentity): Promise<{ status: ManagedProcessLifecycleWriteStatus }> {
    if (!validIdentity(identity)) return Promise.reject(new Error('INVALID_MANAGED_PROCESS_IDENTITY'));
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const id = stateId(identity.runtimeAssetId);
      const row = await repository.findOne({ where: { id } });
      const previous = managedProcessLifecycleView(row, identity.runtimeAssetId);
      if (previous?.generation === identity.generation) return { status: 'duplicate' as const };
      if (previous && Date.parse(previous.startedAt) >= Date.parse(identity.startedAt)) {
        return { status: 'stale' as const };
      }
      const stateVersion = previous ? previous.stateVersion + 1 : 1;
      if (stateVersion > 2147483647) throw new Error('MANAGED_PROCESS_STATE_VERSION_EXHAUSTED');
      const value: ManagedProcessLifecycleView = {
        evidenceScope: MANAGED_PROCESS_LIFECYCLE_SCOPE,
        businessProcessLivenessEvaluated: false,
        ...identity,
        observedEvent: 'started',
        observedAt: tx.now,
        exitCode: null,
        signal: null,
        error: null,
        stateVersion,
      };
      await repository.save(repository.create({ id, value, updatedAt: tx.now }));
      await this.store.projectionEvent(tx, 'server.state_changed', identity.runtimeAssetId, stateVersion, {
        state: value.observedEvent, previousState: previous?.observedEvent ?? null,
        evidenceScope: MANAGED_PROCESS_LIFECYCLE_SCOPE, generation: value.generation,
      }, { runtimeAssetId: identity.runtimeAssetId, serverType: 'mcp' });
      return { status: 'applied' as const };
    });
  }

  recordTerminal(
    identity: ManagedProcessLifecycleIdentity,
    event: Exclude<ManagedProcessLifecycleEvent, 'started'>,
    details: ManagedProcessLifecycleTerminalDetails = {},
  ): Promise<{ status: ManagedProcessLifecycleWriteStatus }> {
    if (!validIdentity(identity) || !EVENTS.includes(event)) {
      return Promise.reject(new Error('INVALID_MANAGED_PROCESS_TERMINAL_EVENT'));
    }
    if (details.exitCode !== undefined && details.exitCode !== null && !Number.isSafeInteger(details.exitCode)) {
      return Promise.reject(new Error('INVALID_MANAGED_PROCESS_EXIT_CODE'));
    }
    if (details.signal !== undefined && details.signal !== null && !trustedText(details.signal, 80)) {
      return Promise.reject(new Error('INVALID_MANAGED_PROCESS_SIGNAL'));
    }
    if (details.error !== undefined && details.error !== null && !trustedText(details.error, 500)) {
      return Promise.reject(new Error('INVALID_MANAGED_PROCESS_ERROR'));
    }
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const id = stateId(identity.runtimeAssetId);
      const row = await repository.findOne({ where: { id } });
      const previous = managedProcessLifecycleView(row, identity.runtimeAssetId);
      if (!previous || previous.generation !== identity.generation || previous.serverId !== identity.serverId ||
        previous.pid !== identity.pid || previous.startedAt !== identity.startedAt) return { status: 'stale' as const };
      if (previous.observedEvent !== 'started') return { status: 'duplicate' as const };
      const stateVersion = previous.stateVersion + 1;
      if (stateVersion > 2147483647) throw new Error('MANAGED_PROCESS_STATE_VERSION_EXHAUSTED');
      const value: ManagedProcessLifecycleView = {
        ...previous,
        observedEvent: event,
        observedAt: tx.now,
        exitCode: details.exitCode ?? null,
        signal: details.signal ?? null,
        error: details.error ?? null,
        stateVersion,
      };
      await repository.save(repository.create({ id, value, updatedAt: tx.now }));
      await this.store.projectionEvent(tx, 'server.state_changed', identity.runtimeAssetId, stateVersion, {
        state: value.observedEvent, previousState: previous?.observedEvent ?? null,
        evidenceScope: MANAGED_PROCESS_LIFECYCLE_SCOPE, generation: value.generation,
      }, { runtimeAssetId: identity.runtimeAssetId, serverType: 'mcp' });
      return { status: 'applied' as const };
    });
  }
}