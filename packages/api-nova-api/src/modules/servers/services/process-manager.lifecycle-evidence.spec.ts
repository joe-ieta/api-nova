import { EventEmitter } from 'events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { RuntimePipelineStateEntity } from '../../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from '../../call-observability/call-observability.store';
import {
  MANAGED_PROCESS_LIFECYCLE_PREFIX,
  ManagedProcessLifecycleEvidenceService,
  managedProcessLifecycleView,
} from '../../call-observability/managed-process-lifecycle-evidence.service';
import { ProcessConfig, ProcessStatus } from '../interfaces/process.interface';
import { ProcessManagerService } from './process-manager.service';

describe('ProcessManagerService managed lifecycle evidence', () => {
  jest.setTimeout(30000);
  let dataSource: DataSource;
  let service: ProcessManagerService;
  let directory: string;

  const view = async (runtimeAssetId: string) => {
    const row = await dataSource.getRepository(RuntimePipelineStateEntity).findOne({
      where: { id: `${MANAGED_PROCESS_LIFECYCLE_PREFIX}${runtimeAssetId}` },
    });
    return managedProcessLifecycleView(row, runtimeAssetId);
  };

  const waitFor = async (runtimeAssetId: string, event: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const current = await view(runtimeAssetId);
      if (current?.observedEvent === event) return current;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${runtimeAssetId}:${event}`);
  };

  const config = (id: string, runtimeAssetId: string, script: string): ProcessConfig => ({
    id,
    name: id,
    scriptPath: process.execPath,
    args: ['-e', script],
    env: { API_NOVA_RUNTIME_AUTH_MODE: 'anonymous' },
    mcpConfig: {
      managed: true,
      runtimeAssetId,
      inboundAuthMode: 'anonymous',
      transport: 'stdio',
    },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'api-nova-managed-process-'));
    dataSource = await new DataSource({
      type: 'sqljs',
      entities: [RuntimePipelineStateEntity],
      synchronize: true,
    }).initialize();
    const evidence = new ManagedProcessLifecycleEvidenceService(
      new CallObservabilityStore(dataSource, {} as any),
    );
    const processInfoRepository = {
      create: jest.fn((value) => value),
      save: jest.fn(async value => value),
      delete: jest.fn(),
    };
    const processLogRepository = {
      create: jest.fn((value) => ({ id: 'log-1', ...value })),
      save: jest.fn(async value => value),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => ({
        PROCESS_TIMEOUT: 3000,
        PID_DIRECTORY: join(directory, 'pids'),
        LOG_DIRECTORY: join(directory, 'logs'),
        PROCESS_LOG_PERSIST_ENABLED: false,
      } as Record<string, unknown>)[key] ?? fallback),
    };
    const appConfigService = {
      processTimeout: 3000,
      processMaxRetries: 0,
      processRestartDelay: 10,
    };
    const resourceMonitor = {
      stopMonitoring: jest.fn(),
      startMonitoring: jest.fn(),
      getProcessResourceMetrics: jest.fn(),
      getSystemResourceInfo: jest.fn(),
      getResourceHistory: jest.fn(),
    };
    const logMonitor = {
      stopLogMonitoring: jest.fn(),
      startLogMonitoring: jest.fn(),
      addLogEntry: jest.fn(),
      getLogHistory: jest.fn(),
    };
    service = new ProcessManagerService(
      processInfoRepository as any,
      processLogRepository as any,
      new EventEmitter2(),
      configService as unknown as ConfigService,
      appConfigService as any,
      resourceMonitor as any,
      logMonitor as any,
      undefined,
      evidence,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('records one stopped terminal state for a real managed child', async () => {
    const info = await service.startProcess(config(
      'managed-stop',
      'asset-stop',
      'setInterval(() => undefined, 1000)',
    ));
    expect(await view('asset-stop')).toEqual(expect.objectContaining({
      observedEvent: 'started',
      pid: info.pid,
      stateVersion: 1,
    }));

    await service.stopProcess('managed-stop', true);
    const stopped = await waitFor('asset-stop', 'stopped');
    expect(stopped).toEqual(expect.objectContaining({
      pid: info.pid,
      stateVersion: 2,
      businessProcessLivenessEvaluated: false,
    }));
  });

  it('records an unexpected exit from a real managed child', async () => {
    const info = await service.startProcess(config(
      'managed-exit',
      'asset-exit',
      'setTimeout(() => process.exit(7), 150)',
    ));
    const exited = await waitFor('asset-exit', 'unexpected_exit');
    expect(exited).toEqual(expect.objectContaining({
      pid: info.pid,
      exitCode: 7,
      stateVersion: 2,
    }));
  });

  it('maps the child error hook to lost without allowing a later exit to overwrite it', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 7654 });
    const managed = config('managed-lost', 'asset-lost', '');
    const processInfo = {
      id: managed.id,
      name: managed.name,
      pid: child.pid!,
      startTime: new Date('2025-01-01T00:00:00.000Z'),
      status: ProcessStatus.RUNNING,
      restartCount: 0,
      updatedAt: new Date(),
      config: managed,
      process: child,
    };
    (service as any).processes.set(managed.id, child);
    (service as any).processInfo.set(managed.id, processInfo);
    const identity = (service as any).createManagedProcessIdentity(managed, child, processInfo.startTime);
    (service as any).managedProcessIdentities.set(child, identity);
    (service as any).setupProcessListeners(managed.id, child, managed);
    await (service as any).recordManagedProcessStarted(child);

    child.emit('error', new Error('child channel lost'));
    const lost = await waitFor('asset-lost', 'lost');
    child.emit('exit', 1, null);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(await view('asset-lost')).toEqual(expect.objectContaining({
      generation: lost.generation,
      observedEvent: 'lost',
      error: 'child channel lost',
      stateVersion: 2,
    }));
  });
});