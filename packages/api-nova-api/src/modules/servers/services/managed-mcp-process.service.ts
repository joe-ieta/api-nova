import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { ProcessInfoEntity } from '../entities/process-info.entity';
import { ProcessConfig, ProcessErrorType, ProcessInfo, ProcessStatus } from '../interfaces/process.interface';
import { ManagedMcpHandoffPreparationService } from './managed-mcp-handoff-preparation.service';
import { ManagedChannelHandle, ManagedChannelResult } from './managed-mcp-channel';
import { MANAGED_LIFECYCLE_REJECTED, MANAGED_START_CANCELLED, TRUSTED_MCP_MODE } from './managed-mcp-mode';
import {
  ManagedProcessLifecycleEvidenceService, ManagedProcessLifecycleIdentity,
} from '../../call-observability/managed-process-lifecycle-evidence.service';

interface Launch {
  info: ProcessInfo;
  abort: AbortController;
  task: Promise<ProcessInfo>;
  handle?: ManagedChannelHandle;
  closed?: ManagedChannelResult;
  terminal?: Promise<void>;
  requestedStop: boolean;
  published: boolean;
  finished?: boolean;
  identity?: ManagedProcessLifecycleIdentity;
  detachSignal?: () => void;
}

/** Owns only trusted IPC children. No envelope, env, argv or ChildProcess is
 * exposed through ProcessInfo. Serial completion fences each launch's events. */
@Injectable()
export class ManagedMcpProcessService implements OnModuleDestroy {
  private readonly launches = new Map<string, Launch>();
  private readonly restarts = new Map<string, AbortController>();
  private readonly restartCompletions = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly preparation: ManagedMcpHandoffPreparationService,
    private readonly events: EventEmitter2,
    @InjectRepository(ProcessInfoEntity) private readonly repository: Repository<ProcessInfoEntity>,
    @Optional() private readonly evidence?: ManagedProcessLifecycleEvidenceService,
  ) {}

  owns(id: string): boolean { return this.launches.has(id); }
  get(id: string): ProcessInfo | undefined {
    const info = this.launches.get(id)?.info;
    // Return detached data so API consumers cannot change the recovery descriptor.
    return info ? structuredClone(info) : undefined;
  }
  all(): ProcessInfo[] { return [...this.launches.keys()].map(id => this.get(id)!); }

  preflight(runtimeAssetId: string, id: string): Promise<void> {
    return this.preparation.preflightLifecycle(runtimeAssetId, id);
  }

  start(id: string, runtimeAssetId: string, restartCount = 0, signal?: AbortSignal, automatic = false): Promise<ProcessInfo> {
    const previous = this.launches.get(id);
    if (this.shuttingDown || this.restarts.has(id) ||
      (previous && !previous.finished)) return Promise.reject(new Error(MANAGED_LIFECYCLE_REJECTED));
    const config: ProcessConfig = {
      id, name: id, scriptPath: '', args: [],
      managedLaunch: { mode: TRUSTED_MCP_MODE, runtimeAssetId },
    };
    const launch: Launch = {
      info: { id, name: id, pid: 0, startTime: new Date(), updatedAt: new Date(),
        status: ProcessStatus.STARTING, restartCount, config },
      abort: new AbortController(), requestedStop: false, published: false, task: undefined!,
    };
    const cancel = () => { launch.requestedStop = true; launch.abort.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    launch.detachSignal = () => signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) cancel();
    this.launches.set(id, launch);
    launch.task = this.activate(launch, automatic);
    return launch.task;
  }

  private assertActive(launch: Launch): void {
    if (launch.requestedStop || launch.abort.signal.aborted) throw new Error(MANAGED_START_CANCELLED);
    if (launch.closed || this.shuttingDown) throw new Error(MANAGED_LIFECYCLE_REJECTED);
  }

  private async activate(launch: Launch, automatic: boolean): Promise<ProcessInfo> {
    const { id, config } = launch.info;
    try {
      await this.persist(launch, ProcessStatus.STARTING);
      this.assertActive(launch);
      const handle = await this.preparation.startLifecycle(config!.managedLaunch!.runtimeAssetId, id, launch.abort.signal, automatic);
      launch.handle = handle;
      // Same double-read capture as the handoff, not an earlier policy read.
      config!.managedLaunch!.autoRestart = handle.autoRestart;
      launch.info.pid = handle.pid;
      void handle.closed.then(result => {
        launch.closed = result;
        // Do not race a STARTING/RUNNING database write with terminal projection.
        void launch.task.catch(() => undefined).then(() => this.finish(launch)).catch(() => undefined);
      });
      await handle.ready;
      this.assertActive(launch);
      launch.identity = { runtimeAssetId: config!.managedLaunch!.runtimeAssetId, serverId: id,
        generation: handle.launchId, pid: handle.pid, startedAt: launch.info.startTime.toISOString() };
      await this.evidence?.recordStarted(launch.identity);
      this.assertActive(launch);
      await this.persist(launch, ProcessStatus.RUNNING);
      this.assertActive(launch);
      await this.events.emitAsync('process.started', {
        processId: id, eventType: 'started', timestamp: new Date(),
        data: { pid: handle.pid, launchId: handle.launchId, managedMode: TRUSTED_MCP_MODE },
      });
      this.assertActive(launch);
      launch.published = true;
      return this.get(id)!;
    } catch {
      launch.abort.abort();
      await launch.handle?.close();
      await this.finish(launch);
      throw new Error(launch.requestedStop ? MANAGED_START_CANCELLED : MANAGED_LIFECYCLE_REJECTED);
    }
  }

  private finish(launch: Launch): Promise<void> {
    if (launch.terminal) return launch.terminal;
    launch.terminal = (async () => {
      if (this.launches.get(launch.info.id) !== launch) return;
      const stopped = launch.requestedStop;
      const code = stopped ? undefined : MANAGED_LIFECYCLE_REJECTED;
      await this.persist(launch, stopped ? ProcessStatus.STOPPED : ProcessStatus.ERROR, code);
      if (launch.identity) {
        await this.evidence?.recordTerminal(launch.identity, stopped ? 'stopped' : 'unexpected_exit',
          { error: code }).catch(() => undefined);
      }
      // Startup rejection is handled by the caller; no endless bootstrap retry.
      if (stopped) {
        await this.events.emitAsync('process.stopped', { processId: launch.info.id, eventType: 'stopped',
          timestamp: new Date(), data: { managedMode: TRUSTED_MCP_MODE } });
      } else if (launch.published) {
        await this.events.emitAsync('process.error', { processId: launch.info.id,
          errorType: ProcessErrorType.PROCESS_EXIT, error: new Error(MANAGED_LIFECYCLE_REJECTED),
          timestamp: new Date(), context: { managedMode: TRUSTED_MCP_MODE } });
      }
    })().finally(() => {
      launch.detachSignal?.();
      launch.detachSignal = undefined;
      launch.handle = undefined;
      launch.identity = undefined;
      launch.finished = true;
    });
    return launch.terminal;
  }

  private async persist(launch: Launch, status: ProcessStatus, error?: string): Promise<void> {
    launch.info.status = status;
    launch.info.updatedAt = new Date();
    launch.info.lastError = error;
    const info = structuredClone(launch.info);
    await this.repository.save(this.repository.create({
      serverId: info.id, pid: info.pid, startTime: info.startTime, status, restartCount: info.restartCount,
      lastError: error ?? null, updatedAt: info.updatedAt,
    }));
    await this.events.emitAsync('process.info.updated', { serverId: info.id, processInfo: info, timestamp: new Date() });
  }

  async stop(id: string): Promise<void> {
    this.restarts.get(id)?.abort();
    const launch = this.launches.get(id);
    if (!launch) return;
    launch.requestedStop = true;
    launch.abort.abort();
    await launch.handle?.close();
    await launch.task.catch(() => undefined);
    await this.finish(launch);
    // Stopping a failed process also cancels scheduled recovery.
    if (launch.info.status !== ProcessStatus.STOPPED) {
      await this.persist(launch, ProcessStatus.STOPPED);
      await this.events.emitAsync('process.stopped', { processId: id, eventType: 'stopped',
        timestamp: new Date(), data: { managedMode: TRUSTED_MCP_MODE } });
    }
  }

  async restart(id: string, automatic = false): Promise<ProcessInfo> {
    const launch = this.launches.get(id);
    if (!launch || this.shuttingDown || this.restarts.has(id)) throw new Error(MANAGED_LIFECYCLE_REJECTED);
    const operation = new AbortController();
    this.restarts.set(id, operation);
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    this.restartCompletions.add(completion);
    try {
      const runtimeAssetId = launch.info.config!.managedLaunch!.runtimeAssetId;
      if (automatic && !await this.preparation.lifecycleAutoRestart(runtimeAssetId, id))
        throw new Error(MANAGED_LIFECYCLE_REJECTED);
      await this.preflight(runtimeAssetId, id);
      if (operation.signal.aborted) throw new Error(MANAGED_START_CANCELLED);
      // Internal stop must not cancel this restart; external stop still can.
      this.restarts.delete(id);
      const stopping = this.stop(id);
      this.restarts.set(id, operation);
      await stopping;
      if (operation.signal.aborted || this.shuttingDown) throw new Error(MANAGED_START_CANCELLED);
      this.restarts.delete(id);
      return await this.start(id, runtimeAssetId, launch.info.restartCount + 1, undefined, automatic);
    } catch {
      throw new Error(operation.signal.aborted ? MANAGED_START_CANCELLED : MANAGED_LIFECYCLE_REJECTED);
    } finally {
      if (this.restarts.get(id) === operation) this.restarts.delete(id);
      this.restartCompletions.delete(completion);
      complete();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const operation of this.restarts.values()) operation.abort();
    await Promise.all([
      ...[...this.launches.keys()].map(id => this.stop(id)),
      ...this.restartCompletions,
    ]);
  }
}
