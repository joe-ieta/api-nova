import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import type { Dir } from 'fs';
import { resolve } from 'path';
import {
  RuntimeInvocationEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityCollector, CollectorLimits, isCallSourceFile } from './call-observability.collector';
import { CallObservabilityCallersProjector } from './call-observability-callers.projector';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityStorageError } from './call-observability-storage';

export const COLLECTOR_WORKER_ID = 'call-observability:collector-worker';
interface ScanCycle {
  startedAt: string;
  visitedFiles: number;
  partialBytes: number;
  backlogFiles: number;
  quarantinedRecords: number;
  errors: Record<string, number>;
}
export interface WorkerReport {
  state: 'running' | 'waiting_for_source' | 'degraded';
  scanComplete: boolean;
  processedRecords: number;
  quarantinedRecords: number;
  bytesRead: number;
  reconciledInvocations: number;
  snapshotSeq: string;
  scan: ScanCycle;
}

/** One management instance, no remote reads, no business-call retries or source deletion. */
@Injectable()
export class CallObservabilityWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private directory?: Dir;
  private pendingFile?: string;
  private cycle?: ScanCycle;
  private active?: Promise<WorkerReport>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private lastWarning = 0;

  constructor(
    private readonly collector: CallObservabilityCollector,
    private readonly callers: CallObservabilityCallersProjector,
    private readonly store: CallObservabilityStore,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Root-module activation is an integration/deployment decision, not a side effect of import.
    if (this.config.get('API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED') !== 'true') return;
    const tick = async () => {
      try { await this.runOnce(); }
      catch {
        if (Date.now() - this.lastWarning >= 15000) {
          this.lastWarning = Date.now();
          process.stderr.write('[OBSERVABILITY_COLLECTOR_DEGRADED] Source checkpoints retained for retry.\n');
        }
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, 1000);
          this.timer.unref();
        }
      }
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  runOnce(options: CollectorLimits & { maxEntries?: number } = {}): Promise<WorkerReport> {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('COLLECTOR_STOPPED'));
    if (this.active) return Promise.reject(new ObservabilityStorageError('STORAGE_BUSY'));
    this.active = this.run(options).finally(() => { this.active = undefined; });
    return this.active;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active?.catch(() => undefined);
    await this.directory?.close();
    this.directory = undefined;
    this.pendingFile = undefined;
  }

  private async run(options: CollectorLimits & { maxEntries?: number }): Promise<WorkerReport> {
    const maxEntries = options.maxEntries ?? 32;
    const maxReadBytes = options.maxReadBytes ?? 4 * 1024 * 1024;
    const maxRecords = options.maxRecords ?? 128;
    for (const [value, maximum] of [[maxEntries, 256], [maxReadBytes, 8 * 1024 * 1024], [maxRecords, 1000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new ObservabilityStorageError('INVALID_COLLECTOR_LIMIT');
      }
    }
    await this.collector.initialize();
    if (!this.cycle) this.cycle = {
      startedAt: new Date().toISOString(), visitedFiles: 0, partialBytes: 0, backlogFiles: 0, quarantinedRecords: 0, errors: {},
    };
    const report: WorkerReport = { state: 'running', scanComplete: false,
      processedRecords: 0, quarantinedRecords: 0, bytesRead: 0, reconciledInvocations: 0,
      snapshotSeq: await this.store.watermark(), scan: this.cycle };
    try {
      if (!this.directory) {
        try {
          const root = await fs.lstat(this.collector.sourceDirectory);
          if (!root.isDirectory() || root.isSymbolicLink() ||
            resolve(await fs.realpath(this.collector.sourceDirectory)) !== this.collector.sourceDirectory) {
            throw new ObservabilityStorageError('UNSAFE_SOURCE_DIRECTORY');
          }
          this.directory = await fs.opendir(this.collector.sourceDirectory, { bufferSize: 32 });
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
          report.state = 'waiting_for_source';
          this.cycle = undefined;
          return await this.persist(report);
        }
      }
      let entries = 0;
      while (entries < maxEntries && report.bytesRead < maxReadBytes &&
        report.processedRecords < maxRecords) {
        entries++;
        if (!this.pendingFile) {
          const entry = await this.directory.read();
          if (!entry) {
            await this.directory.close();
            this.directory = undefined;
            report.scanComplete = true;
            break;
          }
          if (!isCallSourceFile(entry.name)) continue;
          this.pendingFile = entry.name;
        }
        try {
          const result = await this.collector.collectFile(this.pendingFile, {
            maxReadBytes: maxReadBytes - report.bytesRead,
            maxRecords: Math.min(16, maxRecords - report.processedRecords),
            maxLineBytes: options.maxLineBytes,
          }, this.callers.project);
          report.bytesRead += result.bytesRead;
          report.processedRecords += result.processedRecords;
          report.quarantinedRecords += result.quarantinedRecords;
          report.scan.quarantinedRecords += result.quarantinedRecords;
          if (result.hasMore && result.partialBytes > 0) break;
          report.scan.visitedFiles++;
          report.scan.partialBytes += result.partialBytes;
          report.scan.backlogFiles += Number(result.hasMore);
          this.pendingFile = undefined;
        } catch (error: any) {
          const code = error instanceof ObservabilityStorageError ? error.code :
            error?.code === 'ENOENT' ? 'SOURCE_FILE_MISSING' : '';
          if (!['SOURCE_FILE_MISSING', 'SOURCE_FILE_TRUNCATED', 'SOURCE_BOUNDARY_CHANGED',
            'SOURCE_FILE_CHANGED', 'UNSAFE_SOURCE_FILE', 'UNSUPPORTED_SOURCE_IDENTITY'].includes(code)) {
            throw error; // Retain pendingFile; retry it before discovering later files.
          }
          report.scan.errors[code] = (report.scan.errors[code] || 0) + 1;
          this.pendingFile = undefined;
        }
      }
      if (report.scanComplete) {
        if (!report.scan.partialBytes && !report.scan.backlogFiles && !report.scan.quarantinedRecords &&
          Object.keys(report.scan.errors).length === 0) {
          report.reconciledInvocations = await this.recover(report.scan.startedAt);
        }
        this.cycle = undefined;
      }
      if (report.scan.quarantinedRecords || Object.keys(report.scan.errors).length > 0) report.state = 'degraded';
      return await this.persist(report);
    } catch (error) {
      report.state = 'degraded';
      const code = error instanceof ObservabilityStorageError ? error.code : 'COLLECTION_FAILED';
      report.scan.errors[code] = (report.scan.errors[code] || 0) + 1;
      await this.persist(report).catch(() => undefined);
      throw error;
    }
  }

  private async recover(scanStartedAt: string): Promise<number> {
    // Conservative independent observation: never infer while known file backlog/partial evidence exists.
    const observedBefore = new Date(Date.parse(scanStartedAt) - 45000).toISOString();
    const candidates = await this.store.transaction(tx => tx.manager.getRepository(RuntimeInvocationEntity)
      .createQueryBuilder('invocation').where('invocation.phase <> :phase', { phase: 'finished' })
      .andWhere('invocation.ingestedAt <= :cutoff', { cutoff: observedBefore })
      .orderBy('invocation.ingestedAt', 'ASC').addOrderBy('invocation.invocationId', 'ASC')
      .take(128).getMany());
    const dataset = await this.collector.initialize();
    let recovered = 0;
    for (const row of candidates) {
      const result = await this.store.reconcile(row.invocationId, row.recordVersion, {
        reason: 'progress_timeout', observedBefore,
        suppressEvent: Date.parse(row.startedAt) < Date.parse(dataset.eventLiveSince),
      }, this.callers.project);
      recovered += Number(result.status === 'updated');
    }
    return recovered;
  }

  private async persist(report: WorkerReport): Promise<WorkerReport> {
    report.snapshotSeq = await this.store.watermark();
    await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await repository.findOneBy({ id: COLLECTOR_WORKER_ID });
      await repository.save(repository.create({ id: COLLECTOR_WORKER_ID, updatedAt: tx.now,
        value: { ...report, lastAttemptAt: tx.now,
          lastSuccessfulScanAt: report.scanComplete && report.state === 'running' ? tx.now :
            previous?.value?.lastSuccessfulScanAt || null,
          backlogScope: report.scanComplete ? 'completed_directory_scan' : 'partial_directory_scan' },
      }));
    });
    return report;
  }
}
