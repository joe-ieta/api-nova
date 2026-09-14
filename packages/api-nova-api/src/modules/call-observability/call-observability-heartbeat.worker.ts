import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityStorageError, publicSequence } from './call-observability-storage';

export const MANAGEMENT_HEARTBEAT_ID = 'call-observability:management-heartbeat';
export function managementHeartbeatConfiguration(config: ConfigService) {
  const enabled = config.get('API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED');
  const raw = config.get('API_NOVA_OBSERVABILITY_HEARTBEAT_INTERVAL_MS');
  const intervalMs = raw === undefined ? 15000 : Number(raw);
  if ((enabled !== undefined && enabled !== 'true' && enabled !== 'false') ||
    (raw !== undefined && (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)))) ||
    !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
    throw new ObservabilityStorageError('INVALID_HEARTBEAT_CONFIGURATION');
  }
  return { enabled: enabled === 'true', intervalMs, staleAfterMs: intervalMs * 3 };
}

/** Evidence of one lease-holding management process and its successful store roundtrip, never a business-server probe. */
@Injectable()
export class CallObservabilityHeartbeatWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly instanceId = randomUUID();
  private active?: Promise<{ status: 'reported' | 'busy'; stateVersion?: number }>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private bootstrapped = false;
  private observed = false;
  private lastWarning = 0;
  constructor(private readonly store: CallObservabilityStore, private readonly config: ConfigService) {}

  onApplicationBootstrap(): void {
    if (this.bootstrapped || this.stopping) return;
    this.bootstrapped = true;
    try { if (managementHeartbeatConfiguration(this.config).enabled) this.schedule(0); }
    catch { this.warn(); }
  }
  runOnce(): Promise<{ status: 'reported' | 'busy'; stateVersion?: number }> {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('HEARTBEAT_STOPPED'));
    if (this.active) return Promise.reject(new ObservabilityStorageError('STORAGE_BUSY'));
    this.active = this.report().finally(() => { this.active = undefined; });
    return this.active;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
    if (!this.observed) return;
    await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const row = await repository.findOneBy({ id: MANAGEMENT_HEARTBEAT_ID });
      if (!row || row.value.processInstanceId !== this.instanceId || row.value.state === 'stopped') return;
      const stateVersion = this.nextVersion(row.value.stateVersion);
      const value: Record<string, any> = { ...row.value, state: 'stopped', stateVersion, leaseUntil: tx.now, stoppedAt: tx.now };
      await this.store.projectionEvent(tx, 'pipeline.state_changed', MANAGEMENT_HEARTBEAT_ID, stateVersion,
        this.eventDetails(value), {});
      value.snapshotSeq = publicSequence(tx.currentSequence());
      await repository.save({ id: MANAGEMENT_HEARTBEAT_ID, value, updatedAt: tx.now });
    }).catch(() => this.warn());
  }
  private async report() {
    const options = managementHeartbeatConfiguration(this.config);
    if (!options.enabled) throw new ObservabilityStorageError('HEARTBEAT_DISABLED');
    const result = await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const row = await repository.findOneBy({ id: MANAGEMENT_HEARTBEAT_ID });
      if (row && (typeof row.value?.processInstanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.value.processInstanceId) || !Number.isFinite(Date.parse(row.value.leaseUntil)))) {
        throw new ObservabilityStorageError('INVALID_HEARTBEAT_STATE');
      }
      if (row && row.value.processInstanceId !== this.instanceId && Date.parse(row.value.leaseUntil) > Date.parse(tx.now)) {
        return { status: 'busy' as const };
      }
      const stateVersion = this.nextVersion(row?.value?.stateVersion ?? 0);
      const value = { state: 'reporting', evidenceScope: 'management_process_store_roundtrip',
        processInstanceId: this.instanceId, stateVersion, lastHeartbeatAt: tx.now, stoppedAt: null,
        intervalMs: options.intervalMs, staleAfterMs: options.staleAfterMs,
        leaseUntil: new Date(Date.parse(tx.now) + options.staleAfterMs).toISOString(), snapshotSeq: '0' };
      await this.store.projectionEvent(tx, 'pipeline.state_changed', MANAGEMENT_HEARTBEAT_ID, stateVersion,
        this.eventDetails(value), {});
      value.snapshotSeq = publicSequence(tx.currentSequence());
      await repository.save({ id: MANAGEMENT_HEARTBEAT_ID, value, updatedAt: tx.now });
      return { status: 'reported' as const, stateVersion };
    });
    if (result.status === 'reported') this.observed = true;
    return result;
  }
  private eventDetails(value: any) {
    return { state: value.state, evidenceScope: 'management_process_store_roundtrip',
      processInstanceId: value.processInstanceId, stateVersion: value.stateVersion,
      lastHeartbeatAt: value.lastHeartbeatAt, stoppedAt: value.stoppedAt,
      serverHealth: 'unknown', businessServerLivenessEvaluated: false, coverage: 'single_lease_holder' };
  }
  private nextVersion(previous: number): number {
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= 2147483647) {
      throw new ObservabilityStorageError('SUBJECT_VERSION_EXHAUSTED');
    }
    return previous + 1;
  }
  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    try { await this.runOnce(); } catch { this.warn(); }
    if (this.stopping) return;
    try {
      const options = managementHeartbeatConfiguration(this.config);
      if (options.enabled) this.schedule(options.intervalMs);
    } catch { this.warn(); }
  }
  private warn(): void {
    if (Date.now() - this.lastWarning >= 15000) {
      this.lastWarning = Date.now();
      process.stderr.write('[OBSERVABILITY_HEARTBEAT_DEGRADED] Management heartbeat unavailable; last persisted evidence may become stale.\n');
    }
  }
}
