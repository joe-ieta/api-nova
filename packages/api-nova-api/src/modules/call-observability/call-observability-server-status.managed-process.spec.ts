import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityPolicyEntity } from '../../database/entities/runtime-call-observability.entity';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } from '../../database/entities/runtime-asset.entity';
import { RuntimeObservabilityStateEntity } from '../../database/entities/runtime-observability-state.entity';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { CallObservabilityStore } from './call-observability.store';
import { ManagedProcessLifecycleEvidenceService } from './managed-process-lifecycle-evidence.service';

describe('CallObservabilityServerStatusService managed process projection', () => {
  let dataSource: DataSource;

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('projects durable child identity without treating management heartbeat as business liveness', async () => {
    dataSource = await new DataSource({
      type: 'sqljs',
      entities: [RuntimeObservabilityEventEntity, RuntimeObservabilityPolicyEntity, RuntimeAssetEntity, RuntimeObservabilityStateEntity, RuntimePipelineStateEntity],
      synchronize: true,
    }).initialize();
    const runtimeAssetId = randomUUID();
    await dataSource.getRepository(RuntimeAssetEntity).save({
      id: runtimeAssetId,
      name: 'managed-observability-test',
      type: RuntimeAssetType.MCP_SERVER,
      status: RuntimeAssetStatus.ACTIVE,
    });
    const store = new CallObservabilityStore(dataSource, {} as any);
    const lifecycle = new ManagedProcessLifecycleEvidenceService(store);
    const generation = randomUUID();
    await lifecycle.recordStarted({
      runtimeAssetId,
      serverId: 'managed-server',
      generation,
      pid: 9876,
      startedAt: '2025-01-01T00:00:00.000Z',
    });

    const service = new CallObservabilityServerStatusService(store);
    const result = await store.readSnapshot(tx => service.readInSnapshot(
      tx,
      {
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-01-01T01:00:00.000Z',
        origin: 'external',
        timeBasis: 'startedAt',
      },
      {
        principalId: 'tester',
        runtimeAssetIds: [runtimeAssetId],
        requiredPermissions: ['monitoring:read'],
        fingerprint: 'test',
      },
      [],
    ));

    expect(result.managementHeartbeat).toBeNull();
    expect(result.livenessEvaluated).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      runtimeAssetId,
      processInstanceId: generation,
      stateVersion: '1',
      lastHeartbeatAt: null,
      managedProcessLifecycle: expect.objectContaining({
        evidenceScope: 'managed_server_process_lifecycle',
        generation,
        observedEvent: 'started',
        businessProcessLivenessEvaluated: false,
      }),
    }));
  });
});