import { DataSource, In } from 'typeorm';
import { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationRevisionEntity, RuntimeMetricBucketEntity,
  RuntimeCallerBucketEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';

describe('bucket observation resource ceiling', () => {
  it('reads at most MAX+1, rejects before source expansion, retains both pending markers, and accepts exactly MAX', async () => {
    const db = await new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES,
      RuntimeObservabilityEventEntity], synchronize: true }).initialize();
    try {
      const store = new CallObservabilityStore(db, {} as CallObservabilityPayloadStore);
      const now = new Date(), start = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
      const end = new Date(Date.parse(start) + 60000).toISOString();
      const expiry = new Date(now.getTime() + 86400000).toISOString(), zero = '0'.repeat(20);
      const projection = { bucketStart: start, bucketEnd: end, scope: 'business', origin: 'external',
        timeBasis: 'startedAt', runtimeAssetId: null };
      // Direct bounded entity inserts avoid ingest/projection work in this resource test.
      await db.transaction(async manager => {
        for (let offset = 0; offset < MAX_METRIC_OBSERVATIONS + 2; offset += 16) {
          await manager.getRepository(RuntimeInvocationRevisionEntity).insert(Array.from({
            length: Math.min(16, MAX_METRIC_OBSERVATIONS + 2 - offset),
          }, (_, local) => ({ id: 'row-' + (offset + local), invocationId: 'invocation-' + (offset + local),
            sourceInstanceId: 'source', sourceRecordVersion: 1, recordVersion: 1, recordHash: 'a'.repeat(64),
            createdSequence: zero, updatedSequence: zero, validFromSequence: zero, validUntilSequence: null,
            runtimeAssetId: null, serverType: 'gateway', spanKind: 'gateway_request', origin: 'external',
            callerId: 'caller', sourceId: 'source-' + (offset + local), startedAt: start, phase: 'started',
            record: {}, expiresAt: expiry, ingestedAt: now.toISOString(),
          })));
        }
        await manager.getRepository(RuntimeMetricBucketEntity).insert({ id: 'metric', scope: 'business',
          bucketStart: start, bucketEnd: end, dimensions: { keySchemaVersion: 1, ...projection, interval: '1m' },
          metrics: { recompute: { state: 'pending', action: 'recompute', invocationId: 'invocation-0', runtimeAssetId: null } },
          version: 0, dataWatermark: zero, expiresAt: expiry } as RuntimeMetricBucketEntity);
        await manager.getRepository(RuntimeCallerBucketEntity).insert({ id: 'caller', callerId: 'caller', runtimeAssetId: null,
          bucketStart: start, metrics: { recompute: { state: 'pending', action: 'recompute', invocationId: 'invocation-0',
            callerId: 'caller', bucketScope: 'business', bucketTimeBasis: 'startedAt', bucketInterval: '1m',
            runtimeAssetId: null, origin: 'external' } }, version: 0, expiresAt: expiry } as RuntimeCallerBucketEntity);
      });
      const sources = jest.spyOn(store as any, 'loadSources');
      const sql = jest.spyOn(db.logger, 'logQuery');
      expect(await store.recomputePendingBuckets()).toEqual({ recomputed: 0, failed: 2 });
      expect(sources).not.toHaveBeenCalled();
      const selects = sql.mock.calls.map(([statement]) => statement)
        .filter(statement => /^SELECT/.test(statement) && statement.includes('runtime_invocation_revisions'));
      expect(selects).toHaveLength(2);
      expect(selects.every(statement => statement.endsWith('LIMIT ' + (MAX_METRIC_OBSERVATIONS + 1)))).toBe(true);
      expect((await db.getRepository(RuntimeMetricBucketEntity).findOneByOrFail({ id: 'metric' })).metrics.recompute.state).toBe('pending');
      expect((await db.getRepository(RuntimeCallerBucketEntity).findOneByOrFail({ id: 'caller' })).metrics.recompute.state).toBe('pending');
      expect((await db.getRepository(RuntimePipelineStateEntity).findOneByOrFail({ id: 'call-observability:storage-diagnostics' }))
        .value.recomputeBucketFailures).toBe(2);
      expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(0);
      await db.getRepository(RuntimeInvocationRevisionEntity).delete({ id: In(['row-5000', 'row-5001']) });
      const rows = await store.readSnapshot(tx => (store as any).loadBucketInvocations(tx, projection, tx.now, zero));
      expect(rows).toHaveLength(MAX_METRIC_OBSERVATIONS);
    } finally { await db.destroy(); }
  });
});
