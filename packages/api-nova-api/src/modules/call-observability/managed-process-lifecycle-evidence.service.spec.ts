import { CallObservabilityEventsService } from './call-observability-events.service';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityPolicyEntity } from '../../database/entities/runtime-call-observability.entity';
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
  let store: CallObservabilityStore;

  const open = async (database?: Uint8Array) => {
    dataSource = await new DataSource({
      type: 'sqljs',
      database,
      entities: [RuntimeObservabilityEventEntity, RuntimeObservabilityPolicyEntity, RuntimePipelineStateEntity],
      synchronize: database === undefined,
    }).initialize();
    store = new CallObservabilityStore(dataSource, {} as any);
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

  it('commits one sequence-bound event per accepted observation and restores it on reopen', async () => {
    await open();
    const current = identity('asset-durable', 'server-durable', '2025-01-01T00:00:00.000Z');
    await service.recordStarted(current);
    await service.recordTerminal(current, 'unexpected_exit', { error: 'private process details' });
    const database = (dataSource.driver as any).export() as Uint8Array;
    await dataSource.destroy();
    await open(database);
    const events = await dataSource.getRepository(RuntimeObservabilityEventEntity).find({ order: { sequence: 'ASC' } });
    expect(events).toHaveLength(2);
    expect(await store.watermark()).toBe('2');
    expect(events.map(event => event.subjectVersion)).toEqual([1, 2]);
    expect(events.map(event => event.details.state)).toEqual(['started', 'unexpected_exit']);
    expect(events[1]).toMatchObject({ eventName: 'server.state_changed', subjectId: current.runtimeAssetId,
      runtimeAssetId: current.runtimeAssetId, dispatchState: 'pending', eventFamily: 'runtime.lifecycle',
      details: { generation: current.generation, previousState: 'started' } });
    expect(JSON.stringify(events)).not.toContain('private process details');
    await expect(service.recordTerminal(current, 'lost')).resolves.toEqual({ status: 'duplicate' });
    expect(await store.watermark()).toBe('2');
  });

  it('does not allocate a sequence for stale generations or duplicate observations', async () => {
    await open();
    const old = identity('asset-stale', 'server-stale', '2025-01-01T00:00:00.000Z');
    const next = { ...old, generation: randomUUID(), startedAt: '2025-01-01T00:00:01.000Z' };
    await service.recordStarted(old);
    await service.recordStarted(next);
    await service.recordStarted(next);
    await service.recordStarted(old);
    await service.recordTerminal(old, 'lost');
    expect(await store.watermark()).toBe('2');
    expect(await dataSource.getRepository(RuntimeObservabilityEventEntity).count()).toBe(2);
  });

  it('rolls back latest state, durable event and sequence when the transaction fails after insertion', async () => {
    await open();
    const current = identity('asset-rollback', 'server-rollback', '2025-01-01T00:00:00.000Z');
    await service.recordStarted(current);
    const original = store.projectionEvent.bind(store);
    const failure = jest.spyOn(store, 'projectionEvent').mockImplementation(async (...args) => {
      await original(...args);
      throw new Error('injected transaction failure');
    });
    await expect(service.recordTerminal(current, 'stopped')).rejects.toThrow('injected transaction failure');
    expect((await read(current.runtimeAssetId)).observedEvent).toBe('started');
    expect(await store.watermark()).toBe('1');
    expect(await dataSource.getRepository(RuntimeObservabilityEventEntity).count()).toBe(1);
    failure.mockRestore();
    await expect(service.recordTerminal(current, 'stopped')).resolves.toEqual({ status: 'applied' });
    expect(await store.watermark()).toBe('2');
  });

  it('serializes competing store instances so terminal compare-and-write has one winner', async () => {
    await open();
    const current = identity('asset-race', 'server-race', '2025-01-01T00:00:00.000Z');
    const competing = new ManagedProcessLifecycleEvidenceService(new CallObservabilityStore(dataSource, {} as any));
    const starts = await Promise.all([service.recordStarted(current), competing.recordStarted(current)]);
    expect(starts.map(result => result.status).sort()).toEqual(['applied', 'duplicate']);
    const outcomes = await Promise.all([service.recordTerminal(current, 'lost'), competing.recordTerminal(current, 'unexpected_exit')]);
    expect(outcomes.map(result => result.status).sort()).toEqual(['applied', 'duplicate']);
    expect(await store.watermark()).toBe('2');
    expect(await dataSource.getRepository(RuntimeObservabilityEventEntity).count()).toBe(2);
    expect((await read(current.runtimeAssetId)).stateVersion).toBe(2);
  });

  it('exposes only permitted asset events and fixed lifecycle fields through the existing reader', async () => {
    await open();
    const visible = identity('asset-visible', 'server-visible', '2025-01-01T00:00:00.000Z');
    const hidden = identity('asset-hidden', 'server-hidden', '2025-01-01T00:00:00.000Z');
    await service.recordStarted(visible);
    await service.recordStarted(hidden);
    const reader = new CallObservabilityEventsService(store, { issue: () => 'test-cursor' } as any);
    const scope = { principalId: 'reader', runtimeAssetIds: [visible.runtimeAssetId], requiredPermissions: ['monitoring:read'] as const, fingerprint: 'scope-test' };
    const response = await reader.list({ eventTypes: 'server.state_changed' }, scope);
    expect(response.data.items).toHaveLength(1);
    expect(response.data.items[0]).toMatchObject({ subject: { kind: 'server', id: visible.runtimeAssetId, version: 1 },
      data: { generation: visible.generation, state: 'started', evidenceScope: 'managed_server_process_lifecycle' } });
    expect(JSON.stringify(response.data.items)).not.toContain(hidden.generation);
    expect((await reader.list({}, { ...scope, runtimeAssetIds: [] })).data.items).toEqual([]);
  });

  it('leaves no lifecycle row or event when a first start transaction fails', async () => {
    await open();
    const current = identity('asset-failed-start', 'server-failed-start', '2025-01-01T00:00:00.000Z');
    const original = store.projectionEvent.bind(store);
    jest.spyOn(store, 'projectionEvent').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('first-start commit failure');
    });
    await expect(service.recordStarted(current)).rejects.toThrow('first-start commit failure');
    expect(await read(current.runtimeAssetId)).toBeNull();
    expect(await store.watermark()).toBe('0');
    expect(await dataSource.getRepository(RuntimeObservabilityEventEntity).count()).toBe(0);
    await service.recordStarted(current);
    expect(await store.watermark()).toBe('1');
  });
});