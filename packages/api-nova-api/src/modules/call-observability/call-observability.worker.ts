import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import type { Dir } from 'fs';
import { resolve } from 'path';
import { performance } from 'perf_hooks';
import {
  RuntimeInvocationEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityCollector, CollectorLimits, isCallSourceFile } from './call-observability.collector';
import { CallObservabilityCallersProjector } from './call-observability-callers.projector';
import { CallObservabilityStore } from './call-observability.store';
import { ObservabilityStorageError, publicSequence } from './call-observability-storage';

import { CallObservabilitySourceLifecycle, SOURCE_EXIT_PREFIX } from './call-observability-source-lifecycle.service';

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
  recomputedBuckets: number;
  recomputeFailures: number;
  snapshotSeq: string;
  scan: ScanCycle;
}

/** One management instance, no remote reads, no business-call retries or source deletion. */
@Injectable()
export class CallObservabilityWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private directory?: Dir;
  private pendingFile?: string;
  private pendingMayRepeat = false;
  private readonly continuations: string[] = [];
  private discoveryComplete = false;
  private preferContinuation = false;
  private cycle?: ScanCycle;
  private active?: Promise<WorkerReport>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private lastWarning = 0;
  private nextBacklogRecomputeAt = 0;
  private scanProcessedRecords = 0;
  private completedBacklogProgress = false;
  private turnHasPartialLine = false;
  private turnHasUnproductiveBacklog = false;

  constructor(
    private readonly collector: CallObservabilityCollector,
    private readonly callers: CallObservabilityCallersProjector,
    private readonly store: CallObservabilityStore,
    private readonly config: ConfigService,
    @Optional() private readonly sourceLifecycle?: CallObservabilitySourceLifecycle,
  ) {}

  onApplicationBootstrap(): void {
    // Root-module activation is an integration/deployment decision, not a side effect of import.
    if (this.config.get('API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED') !== 'true') return;
    const tick = async () => {
      // Drain finite batches while making progress; yield between them for HTTP and
      // other workers. Empty/failed passes retain the existing one-second backoff.
      let nextDelayMs = 1000;
      try {
        const report = await this.runOnce();
        const canDrain = report.state === 'running' && !report.scan.partialBytes &&
          !report.quarantinedRecords && !report.scan.quarantinedRecords &&
          Object.keys(report.scan.errors || {}).length === 0 &&
          !this.turnHasPartialLine && !this.turnHasUnproductiveBacklog;
        // Reaching directory EOF is not source idleness when this finite scan
        // already advanced records and observed more. Resume discovery next turn.
        if (canDrain && (report.processedRecords > 0 || this.completedBacklogProgress ||
          !report.scanComplete)) nextDelayMs = 0;
      }
      catch {
        if (Date.now() - this.lastWarning >= 15000) {
          this.lastWarning = Date.now();
          process.stderr.write('[OBSERVABILITY_COLLECTOR_DEGRADED] Source checkpoints retained for retry.\n');
        }
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, nextDelayMs);
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
    this.continuations.length = 0;
    this.scanProcessedRecords = 0;
    this.completedBacklogProgress = false;
    this.turnHasPartialLine = false;
    this.turnHasUnproductiveBacklog = false;
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
    this.completedBacklogProgress = false;
    this.turnHasPartialLine = false;
    this.turnHasUnproductiveBacklog = false;
    await this.collector.initialize();
    if (!this.cycle) this.scanProcessedRecords = 0;
    if (!this.cycle) this.cycle = {
      startedAt: new Date().toISOString(), visitedFiles: 0, partialBytes: 0, backlogFiles: 0, quarantinedRecords: 0, errors: {},
    };
    const report: WorkerReport = { state: 'running', scanComplete: false,
      processedRecords: 0, quarantinedRecords: 0, bytesRead: 0, reconciledInvocations: 0,
      recomputedBuckets: 0, recomputeFailures: 0,
      snapshotSeq: await this.store.watermark(), scan: this.cycle };
    try {
      if (!this.directory && !this.discoveryComplete) {
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
          await this.recompute(report);
          if (report.recomputeFailures) report.state = 'degraded';
          return await this.persist(report);
        }
      }
      let entries = 0;
      while (entries < maxEntries && report.bytesRead < maxReadBytes &&
        report.processedRecords < maxRecords) {
        entries++;
        if (!this.pendingFile) {
          if (this.continuations.length && (this.preferContinuation || this.discoveryComplete)) {
            this.pendingFile = this.continuations.shift();
            this.pendingMayRepeat = false;
            this.preferContinuation = false;
          } else if (!this.discoveryComplete) {
            const entry = await this.directory!.read();
            if (!entry) {
              await this.directory!.close();
              this.directory = undefined;
              this.discoveryComplete = true;
              if (this.continuations.length) continue;
              report.scanComplete = true;
              break;
            }
            if (!isCallSourceFile(entry.name)) continue;
            this.pendingFile = entry.name;
            this.pendingMayRepeat = true;
            this.preferContinuation = true;
          } else {
            report.scanComplete = true;
            break;
          }
        }
        try {
          const result = await this.collector.collectFile(this.pendingFile, {
            maxReadBytes: maxReadBytes - report.bytesRead,
            // Read one file quantum; durable ingest batches remain independently bounded.
            maxRecords: Math.min(64, maxRecords - report.processedRecords),
            batchFacts: true,
            maxLineBytes: options.maxLineBytes,
          }, this.callers.project);
          report.bytesRead += result.bytesRead;
          report.processedRecords += result.processedRecords;
          this.scanProcessedRecords += result.processedRecords;
          this.turnHasPartialLine ||= result.partialBytes > 0;
          this.turnHasUnproductiveBacklog ||= result.hasMore && result.processedRecords === 0 && result.partialBytes === 0;
          report.quarantinedRecords += result.quarantinedRecords;
          report.scan.quarantinedRecords += result.quarantinedRecords;
          if (result.hasMore && result.partialBytes > 0) break;
          report.scan.visitedFiles++;
          report.scan.partialBytes += result.partialBytes;
          report.scan.backlogFiles += Number(result.hasMore);
          // A discovered file gets at most one extra quantum per scan. Alternating
          // with discovery prevents a hot source from hiding later directory entries;
          // the fixed queue also bounds filenames retained while scanning huge dirs.
          if (result.hasMore && this.pendingMayRepeat && this.continuations.length < 32) {
            this.continuations.push(this.pendingFile);
          }
          this.pendingFile = undefined;
        } catch (error: any) {
          const code = error instanceof ObservabilityStorageError ? error.code :
            error?.code === 'ENOENT' ? 'SOURCE_FILE_MISSING' : '';
          if (!['SOURCE_FILE_MISSING', 'SOURCE_FILE_TRUNCATED', 'SOURCE_BOUNDARY_CHANGED',
            'SOURCE_FILE_CHANGED', 'UNSAFE_SOURCE_FILE', 'UNSUPPORTED_SOURCE_IDENTITY',
            'SOURCE_SEALED_FILE_CHANGED', 'SOURCE_EXIT_PROOF_CONFLICT'].includes(code)) {
            throw error; // Retain pendingFile; retry it before discovering later files.
          }
          report.scan.errors[code] = (report.scan.errors[code] || 0) + 1;
          this.pendingFile = undefined;
        }
      }
      if (report.scanComplete) {
        this.completedBacklogProgress = this.scanProcessedRecords > 0 && report.scan.backlogFiles > 0;
        this.scanProcessedRecords = 0;
        if (!report.scan.partialBytes && !report.scan.backlogFiles && !report.scan.quarantinedRecords &&
          Object.keys(report.scan.errors).length === 0) {
          report.reconciledInvocations = await this.recover(report.scan.startedAt);

        }
        this.cycle = undefined;
        this.discoveryComplete = false;
      }
      // Known committed facts can advance even while more source files/records arrive.
      // Reconciliation above remains gated on a clean complete source scan.
      await this.recompute(report);
      if (report.recomputeFailures || report.scan.quarantinedRecords || Object.keys(report.scan.errors).length > 0) report.state = 'degraded';
      return await this.persist(report);
    } catch (error) {
      report.state = 'degraded';
      const code = error instanceof ObservabilityStorageError ? error.code : 'COLLECTION_FAILED';
      report.scan.errors[code] = (report.scan.errors[code] || 0) + 1;
      await this.persist(report).catch(() => undefined);
      throw error;
    }
  }

  private async recompute(report: WorkerReport): Promise<void> {
    const idle = report.state === 'waiting_for_source' || (report.scanComplete &&
      !report.scan.partialBytes && !report.scan.backlogFiles && !report.scan.quarantinedRecords &&
      Object.keys(report.scan.errors).length === 0);
    const startedAt = this.recomputeClock();
    if (!idle && startedAt < this.nextBacklogRecomputeAt) return;
    try {
      // Each bucket reads its observation window. Count-bounding eight buckets on
      // every ingest turn repeatedly scans a growing window and crowds out facts.
      // The store rotates metric/caller tables and IDs with a one-bucket budget.
      const result = await this.store.recomputePendingBuckets(idle ? 8 : 1);
      report.recomputedBuckets = result.recomputed;
      report.recomputeFailures = result.failed;
    } finally {
      const finishedAt = this.recomputeClock();
      // Back off according to elapsed cost, with a finite cooldown for derived facts.
      // A running bucket is not aborted; the cap is not a hard CPU-share guarantee.
      this.nextBacklogRecomputeAt = finishedAt + Math.min(10000,
        Math.max(1000, (finishedAt - startedAt) * 9));
    }
  }

  private recomputeClock(): number { return performance.now(); }

  private async recover(scanStartedAt: string): Promise<number> {
    // Conservative independent observation: never infer while known file backlog/partial evidence exists.
    const observedBefore = new Date(Date.parse(scanStartedAt) - 45000).toISOString();
    const snapshot = await this.store.transaction(async tx => {
      const query = tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('invocation')
        .where('invocation.phase <> :phase', { phase: 'finished' });
      if (this.sourceLifecycle) {
        query.leftJoin(RuntimePipelineStateEntity, 'closed',
          'closed.id = :prefix || invocation.sourceInstanceId', { prefix: SOURCE_EXIT_PREFIX })
          .andWhere('(invocation.ingestedAt <= :cutoff OR closed.id IS NOT NULL)', { cutoff: observedBefore });
      } else query.andWhere('invocation.ingestedAt <= :cutoff', { cutoff: observedBefore });
      return { observedBefore: tx.now, candidates: await query.orderBy('invocation.ingestedAt', 'ASC')
        .addOrderBy('invocation.invocationId', 'ASC').take(128).getMany() };
    });
    const dataset = await this.collector.initialize();
    let recovered = 0;
    for (const row of snapshot.candidates) {
      const sourceExitProofId = await this.sourceLifecycle?.persistedProofId(row.sourceInstanceId);
      const result = await this.store.reconcile(row.invocationId, row.recordVersion, {
        reason: sourceExitProofId ? 'process_exit' : 'progress_timeout', sourceExitProofId,
        observedBefore: sourceExitProofId ? snapshot.observedBefore : observedBefore,
        suppressEvent: Date.parse(row.startedAt) < Date.parse(dataset.eventLiveSince),
      }, this.callers.project);
      recovered += Number(result.status === 'updated');
    }
    return recovered;
  }

  private async persist(report: WorkerReport): Promise<WorkerReport> {
    await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await repository.findOneBy({ id: COLLECTOR_WORKER_ID });
      const changed = previous?.value?.state !== report.state;
      const stateVersion = Number(previous?.value?.stateVersion || 0) + Number(changed);
      if (!Number.isSafeInteger(stateVersion) || stateVersion > 2147483647) {
        throw new ObservabilityStorageError('SUBJECT_VERSION_EXHAUSTED');
      }
      if (changed) await this.store.projectionEvent(tx, 'pipeline.state_changed', COLLECTOR_WORKER_ID,
        stateVersion, { state: report.state, previousState: previous?.value?.state || null,
          evidenceScope: 'collector', serverHealth: 'unknown', coverage: 'unknown',
          recomputeFailures: report.recomputeFailures }, {});
      report.snapshotSeq = publicSequence(tx.currentSequence());
      await repository.save(repository.create({ id: COLLECTOR_WORKER_ID, updatedAt: tx.now,
        value: { ...report, stateVersion, lastAttemptAt: tx.now,
          lastSuccessfulScanAt: report.scanComplete && report.state === 'running' ? tx.now :
            previous?.value?.lastSuccessfulScanAt || null,
          backlogScope: report.scanComplete ? 'completed_directory_scan' : 'partial_directory_scan' },
      }));
    });
    return report;
  }
}
