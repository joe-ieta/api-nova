import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityGarbageService, PayloadGarbageReport } from './call-observability-garbage.service';
import { CallObservabilityStore } from './call-observability.store';
import { DAY_MS, ObservabilityStorageError, publicSequence } from './call-observability-storage';

export const RETENTION_WORKER_ID = 'call-observability:retention-worker';
export interface RetentionWorkerConfiguration {
  enabled: boolean;
  intervalMs: number;
  scanLimit: number;
  deleteLimit: number;
  graceMs: number;
}
export interface RetentionWorkerReport {
  state: 'disabled' | 'idle' | 'running' | 'waiting' | 'degraded' | 'stopped';
  workerConfigured: boolean;
  evidenceScope: 'payload_retention';
  intervalMs: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextRunAt: string | null;
  errorCode: string | null;
  lastReport: PayloadGarbageReport | null;
  lastReportAt: string | null;
  /** A failed batch may already have safely removed objects; no zero-deletion claim. */
  currentAttemptComplete: boolean;
  stateVersion: number;
  snapshotSeq: string;
}
const PREFIX = 'API_NOVA_OBSERVABILITY_RETENTION_';
export function retentionWorkerConfiguration(config: ConfigService): RetentionWorkerConfiguration {
  const enabled = config.get(PREFIX + 'ENABLED');
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new ObservabilityStorageError('INVALID_RETENTION_CONFIGURATION');
  }
  const positive = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = config.get(PREFIX + name);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw))) {
      throw new ObservabilityStorageError('INVALID_RETENTION_CONFIGURATION');
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new ObservabilityStorageError('INVALID_RETENTION_CONFIGURATION');
    }
    return value;
  };
  const scanLimit = positive('SCAN_LIMIT', 128, 1, 1000);
  const deleteLimit = positive('DELETE_LIMIT', 32, 1, 1000);
  if (deleteLimit > scanLimit) throw new ObservabilityStorageError('INVALID_RETENTION_CONFIGURATION');
  return { enabled: enabled === 'true', intervalMs: positive('INTERVAL_MS', 60000, 1000, DAY_MS),
    scanLimit, deleteLimit, graceMs: positive('GRACE_MS', DAY_MS, 60000, 7 * DAY_MS) };
}
export const RETENTION_ERROR_CODES = ['INVALID_RETENTION_CONFIGURATION', 'PAYLOAD_GC_LEASE_LOST',
  'UNSAFE_PAYLOAD_DIRECTORY', 'PAYLOAD_OWNER_MISMATCH', 'PAYLOAD_STORAGE_UNAVAILABLE', 'STORAGE_BUSY',
  'RETENTION_COLLECTION_FAILED'] as const;
const SAFE_ERRORS = new Set<string>(RETENTION_ERROR_CODES);

/** Default off. Only delegates fenced, bounded payload collection; never prunes event or invocation rows. */
@Injectable()
export class CallObservabilityRetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<RetentionWorkerReport>;
  private stopping = false;
  private bootstrapped = false;
  private scheduled = false;
  private lastWarning = 0;
  private observed = false;

  constructor(private readonly garbage: CallObservabilityGarbageService,
    private readonly store: CallObservabilityStore, private readonly config: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.bootstrapped || this.stopping) return;
    this.bootstrapped = true;
    let options: RetentionWorkerConfiguration;
    try { options = retentionWorkerConfiguration(this.config); }
    catch (error) { await this.failure(error, null).catch(() => this.warn()); return; }
    if (!options.enabled) return;
    this.scheduled = true;
    await this.persist({ state: options.enabled ? 'idle' : 'disabled', workerConfigured: options.enabled,
      intervalMs: options.intervalMs, nextRunAt: options.enabled ? this.nextRun(options.intervalMs) : null,
      errorCode: null, currentAttemptComplete: false }).catch(() => this.warn());
    if (options.enabled && !this.stopping) this.schedule(options.intervalMs);
  }

  runOnce(): Promise<RetentionWorkerReport> {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('RETENTION_WORKER_STOPPED'));
    if (this.active) return Promise.reject(new ObservabilityStorageError('STORAGE_BUSY'));
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.scheduled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
    // Persisted stopped is an observation, never proof that another process is alive.
    if (this.observed) await this.persist({ state: 'stopped', nextRunAt: null }).catch(() => undefined);
  }

  private schedule(intervalMs: number): void {
    if (this.stopping || !this.scheduled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try { await this.runOnce(); }
    catch { this.warn(); } finally {
      if (this.stopping || !this.scheduled) return;
      try {
        const options = retentionWorkerConfiguration(this.config);
        if (options.enabled) this.schedule(options.intervalMs);
        else this.scheduled = false;
      } catch { this.scheduled = false; }
    }
  }

  private async run(): Promise<RetentionWorkerReport> {
    let options: RetentionWorkerConfiguration;
    try {
      options = retentionWorkerConfiguration(this.config);
      if (!options.enabled) {
        if (this.observed) await this.persist({ state: 'disabled', workerConfigured: false, intervalMs: options.intervalMs,
          nextRunAt: null, errorCode: null, currentAttemptComplete: false }).catch(() => this.warn());
        throw new ObservabilityStorageError('RETENTION_DISABLED');
      }
      await this.persist({ state: 'running', workerConfigured: true, intervalMs: options.intervalMs,
        lastAttemptAt: new Date().toISOString(), nextRunAt: null, errorCode: null, currentAttemptComplete: false });
      const report = await this.garbage.collect({ scanLimit: options.scanLimit,
        deleteLimit: options.deleteLimit, graceMs: options.graceMs });
      const now = new Date().toISOString();
      return await this.persist({ state: report.status === 'busy' ? 'waiting' : 'idle',
        lastReport: report, lastReportAt: now, currentAttemptComplete: report.status === 'completed',
        ...(report.status === 'completed' ? { lastSuccessAt: now } : {}), errorCode: null,
        nextRunAt: this.scheduled && !this.stopping ? this.nextRun(options.intervalMs) : null });
    } catch (error) {
      if (error instanceof ObservabilityStorageError && error.code === 'RETENTION_DISABLED') throw error;
      await this.failure(error, options ?? null).catch(() => undefined);
      throw error;
    }
  }

  private warn(): void {
    if (Date.now() - this.lastWarning >= 15000) {
      this.lastWarning = Date.now();
      process.stderr.write('[OBSERVABILITY_RETENTION_DEGRADED] Payload cleanup deferred; inspect persisted worker evidence.\n');
    }
  }
  private nextRun(intervalMs: number): string { return new Date(Date.now() + intervalMs).toISOString(); }
  private failure(error: unknown, options: RetentionWorkerConfiguration | null): Promise<RetentionWorkerReport> {
    const code = error instanceof ObservabilityStorageError && SAFE_ERRORS.has(error.code)
      ? error.code : 'RETENTION_COLLECTION_FAILED';
    return this.persist({ state: 'degraded', workerConfigured: options?.enabled ?? false,
      intervalMs: options?.intervalMs ?? null, lastFailureAt: new Date().toISOString(), errorCode: code,
      currentAttemptComplete: false,
      nextRunAt: options && this.scheduled && !this.stopping ? this.nextRun(options.intervalMs) : null });
  }

  private persist(patch: Partial<RetentionWorkerReport>): Promise<RetentionWorkerReport> {
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await repository.findOneBy({ id: RETENTION_WORKER_ID });
      const version = previous?.value?.stateVersion ?? 0;
      if (!Number.isSafeInteger(version) || version < 0 || version >= 2147483647) {
        throw new ObservabilityStorageError('SUBJECT_VERSION_EXHAUSTED');
      }
      const value: RetentionWorkerReport = { state: 'disabled', workerConfigured: false,
        evidenceScope: 'payload_retention', intervalMs: null, lastAttemptAt: null, lastSuccessAt: null,
        lastFailureAt: null, nextRunAt: null, errorCode: null, lastReport: null, lastReportAt: null,
        currentAttemptComplete: false, ...previous?.value, ...patch,
        stateVersion: version + Number(!previous || previous.value.state !== patch.state),
        snapshotSeq: publicSequence(tx.currentSequence()) };
      await repository.save(repository.create({ id: RETENTION_WORKER_ID, value, updatedAt: tx.now }));
      this.observed = true;
      return value;
    });
  }
}
