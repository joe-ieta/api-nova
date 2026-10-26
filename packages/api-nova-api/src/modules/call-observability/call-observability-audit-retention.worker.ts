import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import {
  AUDIT_RETENTION_MIN_DAYS,
  CallObservabilityAuditRetentionService,
  OBSERVABILITY_AUDIT_RETENTION_STATE_ID,
  type AuditRetentionCollectionReport,
} from './call-observability-audit-retention.service';
import { CallObservabilityStore } from './call-observability.store';
import { DAY_MS, ObservabilityStorageError, publicSequence } from './call-observability-storage';

export const AUDIT_RETENTION_WORKER_ID = OBSERVABILITY_AUDIT_RETENTION_STATE_ID;

export interface AuditRetentionWorkerConfiguration {
  enabled: boolean;
  intervalMs: number;
  scanLimit: number;
  deleteLimit: number;
  retentionDays: number;
  retentionMs: number;
}

export interface AuditRetentionWorkerReport {
  state: 'disabled' | 'idle' | 'running' | 'waiting' | 'degraded' | 'stopped';
  workerConfigured: boolean;
  evidenceScope: 'management_audit_retention';
  intervalMs: number | null;
  retentionDays: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextRunAt: string | null;
  errorCode: string | null;
  lastReport: AuditRetentionCollectionReport | null;
  lastReportAt: string | null;
  currentAttemptComplete: boolean;
  stateVersion: number;
  snapshotSeq: string;
}

const PREFIX = 'API_NOVA_OBSERVABILITY_AUDIT_RETENTION_';

export function auditRetentionWorkerConfiguration(config: ConfigService): AuditRetentionWorkerConfiguration {
  const enabled = config.get(PREFIX + 'ENABLED');
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
  }
  const positive = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = config.get(PREFIX + name);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw))) {
      throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
    }
    return value;
  };
  const scanLimit = positive('SCAN_LIMIT', 128, 1, 1000);
  const deleteLimit = positive('DELETE_LIMIT', 32, 1, 1000);
  if (deleteLimit > scanLimit) {
    throw new ObservabilityStorageError('INVALID_AUDIT_RETENTION_CONFIGURATION');
  }
  const retentionDays = positive('RETENTION_DAYS', AUDIT_RETENTION_MIN_DAYS, AUDIT_RETENTION_MIN_DAYS, 3650);
  return {
    enabled: enabled === 'true',
    intervalMs: positive('INTERVAL_MS', 60000, 1000, DAY_MS),
    scanLimit,
    deleteLimit,
    retentionDays,
    retentionMs: retentionDays * DAY_MS,
  };
}

const AUDIT_RETENTION_ERROR_CODES = [
  'INVALID_AUDIT_RETENTION_CONFIGURATION',
  'AUDIT_RETENTION_BELOW_MINIMUM',
  'AUDIT_RETENTION_DISABLED',
  'AUDIT_RETENTION_WORKER_STOPPED',
  'STORAGE_BUSY',
  'AUDIT_RETENTION_COLLECTION_FAILED',
] as const;
const SAFE_ERRORS = new Set<string>(AUDIT_RETENTION_ERROR_CODES);

/** Default off. Only removes explicitly attributed management audit rows; never product audit. */
@Injectable()
export class CallObservabilityAuditRetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<AuditRetentionWorkerReport>;
  private stopping = false;
  private bootstrapped = false;
  private scheduled = false;
  private lastWarning = 0;
  private observed = false;

  constructor(
    private readonly auditRetention: CallObservabilityAuditRetentionService,
    private readonly store: CallObservabilityStore,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.bootstrapped || this.stopping) return;
    this.bootstrapped = true;
    let options: AuditRetentionWorkerConfiguration;
    try {
      options = auditRetentionWorkerConfiguration(this.config);
    } catch (error) {
      await this.failure(error, null).catch(() => this.warn());
      return;
    }
    if (!options.enabled) return;
    this.scheduled = true;
    await this.persist({
      state: 'idle',
      workerConfigured: true,
      intervalMs: options.intervalMs,
      retentionDays: options.retentionDays,
      nextRunAt: this.nextRun(options.intervalMs),
      errorCode: null,
      currentAttemptComplete: false,
    }).catch(() => this.warn());
    if (!this.stopping) this.schedule(options.intervalMs);
  }

  runOnce(): Promise<AuditRetentionWorkerReport> {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('AUDIT_RETENTION_WORKER_STOPPED'));
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
    try {
      await this.runOnce();
    } catch {
      this.warn();
    } finally {
      if (this.stopping || !this.scheduled) return;
      try {
        const options = auditRetentionWorkerConfiguration(this.config);
        if (options.enabled) this.schedule(options.intervalMs);
        else this.scheduled = false;
      } catch {
        this.scheduled = false;
      }
    }
  }

  private async run(): Promise<AuditRetentionWorkerReport> {
    let options: AuditRetentionWorkerConfiguration;
    try {
      options = auditRetentionWorkerConfiguration(this.config);
      if (!options.enabled) {
        if (this.observed) {
          await this.persist({
            state: 'disabled',
            workerConfigured: false,
            intervalMs: options.intervalMs,
            nextRunAt: null,
            errorCode: null,
            currentAttemptComplete: false,
          }).catch(() => this.warn());
        }
        throw new ObservabilityStorageError('AUDIT_RETENTION_DISABLED');
      }
      await this.persist({
        state: 'running',
        workerConfigured: true,
        intervalMs: options.intervalMs,
        retentionDays: options.retentionDays,
        lastAttemptAt: new Date().toISOString(),
        nextRunAt: null,
        errorCode: null,
        currentAttemptComplete: false,
      });
      const report = await this.auditRetention.collect({
        scanLimit: options.scanLimit,
        deleteLimit: options.deleteLimit,
        retentionMs: options.retentionMs,
      });
      const now = new Date().toISOString();
      return await this.persist({
        state: report.status === 'waiting' ? 'waiting' : 'idle',
        lastReport: report,
        lastReportAt: now,
        currentAttemptComplete: report.status === 'completed',
        ...(report.status === 'completed' ? { lastSuccessAt: now } : {}),
        errorCode: null,
        nextRunAt: this.scheduled && !this.stopping ? this.nextRun(options.intervalMs) : null,
      });
    } catch (error) {
      if (error instanceof ObservabilityStorageError && error.code === 'AUDIT_RETENTION_DISABLED') throw error;
      await this.failure(error, options ?? null).catch(() => undefined);
      throw error;
    }
  }

  private warn(): void {
    if (Date.now() - this.lastWarning >= 15000) {
      this.lastWarning = Date.now();
      process.stderr.write('[OBSERVABILITY_AUDIT_RETENTION_DEGRADED] Audit cleanup deferred; inspect persisted worker evidence.\n');
    }
  }

  private nextRun(intervalMs: number): string {
    return new Date(Date.now() + intervalMs).toISOString();
  }

  private failure(error: unknown, options: AuditRetentionWorkerConfiguration | null): Promise<AuditRetentionWorkerReport> {
    const code = error instanceof ObservabilityStorageError && SAFE_ERRORS.has(error.code)
      ? error.code : 'AUDIT_RETENTION_COLLECTION_FAILED';
    return this.persist({
      state: 'degraded',
      workerConfigured: options?.enabled ?? false,
      intervalMs: options?.intervalMs ?? null,
      retentionDays: options?.retentionDays ?? null,
      lastFailureAt: new Date().toISOString(),
      errorCode: code,
      currentAttemptComplete: false,
      nextRunAt: options && this.scheduled && !this.stopping ? this.nextRun(options.intervalMs) : null,
    });
  }

  private persist(patch: Partial<AuditRetentionWorkerReport>): Promise<AuditRetentionWorkerReport> {
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await repository.findOneBy({ id: AUDIT_RETENTION_WORKER_ID });
      const version = previous?.value?.stateVersion ?? 0;
      if (!Number.isSafeInteger(version) || version < 0 || version >= 2147483647) {
        throw new ObservabilityStorageError('SUBJECT_VERSION_EXHAUSTED');
      }
      const value: AuditRetentionWorkerReport = {
        state: 'disabled',
        workerConfigured: false,
        evidenceScope: 'management_audit_retention',
        intervalMs: null,
        retentionDays: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        nextRunAt: null,
        errorCode: null,
        lastReport: null,
        lastReportAt: null,
        currentAttemptComplete: false,
        ...previous?.value,
        ...patch,
        stateVersion: version + Number(!previous || previous.value.state !== patch.state),
        snapshotSeq: publicSequence(tx.currentSequence()),
      };
      await repository.save(repository.create({ id: AUDIT_RETENTION_WORKER_ID, value, updatedAt: tx.now }));
      this.observed = true;
      return value;
    });
  }
}
