import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import {
  MANAGED_PROCESS_LIFECYCLE_PREFIX,
  ManagedProcessLifecycleEvidenceService,
  ManagedProcessLifecycleIdentity,
  managedProcessLifecycleView,
} from './managed-process-lifecycle-evidence.service';

describe('ManagedProcessLifecycleEvidenceService', () => {
  let dataSource: DataSource;
  let service: ManagedProcessLifecycleEvidenceService;

  const open = async (database?: Uint8Array) => {
    dataSource = await new DataSource({
      type: 'sqljs',
      database,
      entities: [RuntimePipelineStateEntity],
      synchronize: database === undefined,
    }).initialize();
    const store = new CallObservabilityStore(dataSource, {} as any);
    service = new ManagedProcessLifecycleEvidenceService(store);
  };

  const identity = (runtimeAssetId: string, serverId: string, startedAt: string): ManagedProcessLifecycleIdentity => ({
    runtimeAssetId,
    serverId,
    generation: randomUUID(),
    pid: 321,
    startedAt,
  });

  const read = async (runtimeAssetId: string) => {
    const row = await dataSource.getRepository(RuntimePipelineStateEntity).findOne({
      where: { id: `${MANAGED_PROCESS_LIFECYCLE_PREFIX}${runtimeAssetId}` },
    });
    return managedProcessLifecycleView(row, runtimeAssetId);
  };

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects late terminal events from an older generation', async () => {
    await open();
    const first = identity('asset-1', 'server-1', '2025-01-01T00:00:00.000Z');
    const second = { ...identity('asset-1', 'server-1', '2025-01-01T00:00:01.000Z'), pid: 654 };

    await expect(service.recordStarted(first)).resolves.toEqual({ status: 'applied' });
    await expect(service.recordStarted(second)).resolves.toEqual({ status: 'applied' });
    await expect(service.recordTerminal(first, 'unexpected_exit', { exitCode: 7 }))
      .resolves.toEqual({ status: 'stale' });

    expect(await read('asset-1')).toEqual(expect.objectContaining({
      generation: second.generation,
      pid: 654,
      observedEvent: 'started',
      stateVersion: 2,
      businessProcessLivenessEvaluated: false,
    }));
  });

  it('preserves the first terminal observation for stop/error/exit races', async () => {
    await open();
    const current = identity('asset-2', 'server-2', '2025-01-01T00:00:00.000Z');

    await service.recordStarted(current);
    await expect(service.recordTerminal(current, 'stopped', { signal: 'SIGTERM' }))
      .resolves.toEqual({ status: 'applied' });
    await expect(service.recordTerminal(current, 'lost', { error: 'late error' }))
      .resolves.toEqual({ status: 'duplicate' });
    await expect(service.recordTerminal(current, 'unexpected_exit', { exitCode: 1 }))
      .resolves.toEqual({ status: 'duplicate' });

    expect(await read('asset-2')).toEqual(expect.objectContaining({
      observedEvent: 'stopped',
      signal: 'SIGTERM',
      error: null,
      stateVersion: 2,
    }));
  });

  it('persists unexpected exit evidence across a SQL.js reopen', async () => {
    await open();
    const current = identity('asset-reopen', 'server-reopen', '2025-01-01T00:00:00.000Z');
    await service.recordStarted(current);
    await service.recordTerminal(current, 'unexpected_exit', { exitCode: 9, signal: 'SIGKILL' });

    const database = (dataSource.driver as any).export() as Uint8Array;
    await dataSource.destroy();
    await open(database);

    expect(await read('asset-reopen')).toEqual(expect.objectContaining({
      runtimeAssetId: 'asset-reopen',
      serverId: 'server-reopen',
      generation: current.generation,
      observedEvent: 'unexpected_exit',
      exitCode: 9,
      signal: 'SIGKILL',
      stateVersion: 2,
    }));
  });

  it('treats malformed rows as unavailable evidence', async () => {
    await open();
    await dataSource.getRepository(RuntimePipelineStateEntity).save({
      id: `${MANAGED_PROCESS_LIFECYCLE_PREFIX}asset-invalid`,
      value: { evidenceScope: 'managed_server_process_lifecycle', runtimeAssetId: 'asset-invalid' },
      updatedAt: 'invalid',
    });

    expect(await read('asset-invalid')).toBeNull();
  });
});