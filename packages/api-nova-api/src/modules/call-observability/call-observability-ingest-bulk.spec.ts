import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { DataSource } from 'typeorm';
import { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity, RuntimeInvocationRevisionEntity,
  RuntimeIngestReceiptEntity, RuntimeIngestCheckpointEntity, RuntimeIngestQuarantineEntity, RuntimePayloadEntity, RuntimePipelineStateEntity, RuntimeIngestReceiptTombstoneEntity, RuntimeMetricBucketEntity, RuntimeCallerBucketEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { ConfigService } from '@nestjs/config';
import { CallObservabilityCallersProjector } from './call-observability-callers.projector';
import { CallObservabilityCollector } from './call-observability.collector';

describe('bounded bulk fact SQL', () => {
  let db: DataSource, store: CallObservabilityStore, payloads: CallObservabilityPayloadStore;
  let collector: CallObservabilityCollector, directory: string, location: string;
  const oldAudit = process.env.API_NOVA_AUDIT_DIR, oldPayload = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  const evidence = (overrides: Record<string, unknown> = {}) => {
    const invocationId = randomUUID();
    return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
      sourceSequence: 1, recordVersion: 1, phase: 'started', requestId: randomUUID(), traceId: invocationId,
      rootInvocationId: invocationId, kind: 'admission', spanKind: 'gateway_request', transport: 'gateway',
      serverType: 'gateway', protocolTransport: 'http', origin: 'external', runtimeAssetId: randomUUID(),
      identitySource: 'authenticated', callerId: 'caller', credentialId: 'credential',
      startedAt: new Date(Date.now() - 1000).toISOString(), method: 'GET', path: '/sample',
      byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress',
      requestHeaders: {}, responseHeaders: {}, request: { state: 'unavailable', reason: 'not_captured' },
      response: { state: 'unavailable', reason: 'not_captured' }, ...overrides };
  };
  const terminal = (start: ReturnType<typeof evidence>) => ({ ...start, eventId: randomUUID(),
    sourceSequence: 2, recordVersion: 2, phase: 'finished', completedAt: new Date().toISOString(), durationMs: 25, outcome: 'success', statusCode: 200 });
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/ingest-batch-tests');
    await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(join(root, 'run-'));
    process.env.API_NOVA_AUDIT_DIR = directory; process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(directory, 'data');
    location = join(directory, 'db.sqlite');
    db = await new DataSource({ type: 'sqljs', location, autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
    payloads = new CallObservabilityPayloadStore(); store = new CallObservabilityStore(db, payloads);
    collector = new CallObservabilityCollector(store);
  });
  afterEach(async () => {
    collector.onModuleDestroy(); await payloads.onModuleDestroy(); if (db.isInitialized) await db.destroy();
    if (oldAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = oldAudit;
    if (oldPayload === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldPayload;
  });
  const source = async (records: unknown[]) => {
    const fileName = 'calls-v2-' + randomUUID() + '.jsonl';
    const text = records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n';
    await fs.writeFile(join(directory, fileName), text); return { fileName, bytes: Buffer.byteLength(text) };
  };
  const bulk = { batchFacts: true, coalesceBuckets: true };
  const checkpointEntries = (records: unknown[]) => records.map((input, index) => ({ input, context: {
    checkpoint: { id: 'b'.repeat(64), fileName: 'calls-v2-bulk.jsonl', fileIdentity: 'bulk-identity',
      previousOffset: String(index), byteOffset: String(index + 1), boundaryHash: 'a'.repeat(64) },
  } }));

  it('cuts SQL round trips while retaining the same 16 facts, receipts, events and durable checkpoint', async () => {
    await store.ensurePayloadStorage();
    const log = jest.spyOn(db.logger, 'logQuery');
    const records = Array.from({ length: 16 }, () => terminal(evidence()));
    await store.ingestBatch(checkpointEntries(records), undefined, { coalesceBuckets: true });
    const baseline = log.mock.calls.length;
    await db.destroy();
    db = await new DataSource({ type: 'sqljs', location: join(directory, 'bulk.sqlite'), autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
    await payloads.onModuleDestroy(); process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(directory, 'bulk-data');
    payloads = new CallObservabilityPayloadStore();
    store = new CallObservabilityStore(db, payloads); await store.ensurePayloadStorage();
    const optimized = jest.spyOn(db.logger, 'logQuery');
    const saves = jest.spyOn(db.driver as any, 'autoSave');
    await store.ingestBatch(checkpointEntries(records), undefined, bulk);
    const actual = optimized.mock.calls.length;
    console.log(JSON.stringify({ fixture: '16 terminal facts/checkpoints', baselineQueries: baseline, bulkQueries: actual }));
    expect(actual).toBeLessThan(baseline * 0.65);
    expect(saves).toHaveBeenCalledTimes(4);
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(16);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(16);
    expect(await db.getRepository(RuntimeIngestReceiptEntity).count()).toBe(16);
    expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(16);
    expect((await db.getRepository(RuntimeIngestCheckpointEntity).findOneByOrFail({ id: 'b'.repeat(64) })).byteOffset).toMatch(/16$/);
    const bulkLocation = (db.options as any).location;
    await db.destroy();
    db = await new DataSource({ type: 'sqljs', location: bulkLocation, autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] }).initialize();
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(16);
  });

  it('retains all same-invocation versions, closes historical intervals and preserves first payload expiry', async () => {
    const start = evidence(); await store.ingest(start);
    const progress = { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2 };
    const finish = { ...terminal(start), sourceSequence: 3, recordVersion: 3 };
    const seen: number[] = [];
    const result = await store.ingestBatch([{ input: progress, context: {} }, { input: finish, context: {} }], async (_tx, before, after) => {
      seen.push(before!.recordVersion); after.sourceId = 'trusted-source';
    }, bulk);
    expect(result.map(row => row.status)).toEqual(['updated', 'updated']); expect(seen).toEqual([1, 2]);
    const revisions = await db.getRepository(RuntimeInvocationRevisionEntity).find({ order: { recordVersion: 'ASC' } });
    expect(revisions.map(row => row.recordVersion)).toEqual([1, 2, 3]);
    expect(revisions[0].validUntilSequence).toBe(revisions[1].validFromSequence);
    expect(revisions[1].validUntilSequence).toBe(revisions[2].validFromSequence);
    expect(revisions[2].validUntilSequence).toBeNull();
    expect(revisions[2].sourceId).toBe('trusted-source');
    const payload = await db.getRepository(RuntimePayloadEntity).findOneByOrFail({ id: revisions[2].requestPayloadId! });
    expect(payload.expiresAt).toBe(new Date(Date.parse(start.startedAt) + 7 * 86400000).toISOString());
  });

  it('chains duplicate, stale, conflict and malformed neighbours without losing valid records', async () => {
    const start = evidence(), progress = { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2 };
    const finish = { ...terminal(start), sourceSequence: 3, recordVersion: 3 };
    const old = { ...start, eventId: randomUUID(), sourceSequence: 4 };
    const conflict = { ...finish, outcome: 'error' };
    const entries: any[] = checkpointEntries([start, progress, start, old, conflict, finish]);
    entries.splice(4, 0, { rejection: { hash: 'c'.repeat(64), reason: 'INVALID_SOURCE_SCHEMA' }, context: {} });
    const result = await store.ingestBatch(entries, undefined, bulk);
    expect(result.map(row => row.status)).toEqual(['inserted', 'updated', 'duplicate', 'stale', 'quarantined', 'updated', 'quarantined']);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(3);
    expect(await db.getRepository(RuntimeIngestQuarantineEntity).count()).toBe(2);
    expect((await db.getRepository(RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId })).outcome).toBe('error');
  });

  it('rolls back deferred core facts and immediate hook writes when final checkpoint SQL fails, then retries once', async () => {
    const entries = checkpointEntries(Array.from({ length: 16 }, () => terminal(evidence())));
    const runner = db.createQueryRunner(), query = runner.query.bind(runner);
    const spy = jest.spyOn(runner, 'query').mockImplementation(async (...args: any[]) => {
      if (/^INSERT INTO "runtime_ingest_checkpoints"/.test(args[0])) throw new Error('late checkpoint write failed');
      return query(...args as Parameters<typeof query>);
    });
    const hook = async (tx: any) => { await tx.manager.getRepository(RuntimePipelineStateEntity).upsert({
      id: 'hook-atomic', value: { valid: true }, updatedAt: tx.now,
    }, ['id']); };
    await expect(store.ingestBatch(entries, hook, bulk)).rejects.toThrow('late checkpoint');
    spy.mockRestore();
    for (const entity of [RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimeIngestReceiptEntity,
      RuntimePayloadEntity, RuntimeIngestCheckpointEntity, RuntimeObservabilityEventEntity]) expect(await db.getRepository(entity).count()).toBe(0);
    expect(await db.getRepository(RuntimePipelineStateEntity).findOneBy({ id: 'hook-atomic' })).toBeNull();
    expect((await store.ingestBatch(entries, hook, bulk)).filter(row => row.status === 'inserted')).toHaveLength(16);
  });

  it('preserves an existing orphan payload deadline when later revisions reference the same prepared ID', async () => {
    const oldExpiry = new Date(Date.now() - 86400000).toISOString();
    const prepare = payloads.prepare.bind(payloads); let preparedCount = 0;
    jest.spyOn(payloads, 'prepare').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (++preparedCount <= 2) await db.getRepository(RuntimePayloadEntity).insert({ ...result.entity, expiresAt: oldExpiry });
      return result;
    });
    const start = evidence(), finish = terminal(start);
    await store.ingestBatch([{ input: start, context: {} }, { input: finish, context: {} }], undefined, bulk);
    const current = await db.getRepository(RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
    for (const id of [current.requestPayloadId, current.responsePayloadId]) {
      expect((await db.getRepository(RuntimePayloadEntity).findOneByOrFail({ id: id! })).expiresAt).toBe(oldExpiry);
    }
  });

  it('matches the immediate path across core and caller/source tables with the actual production hook', async () => {
    await store.ensurePayloadStorage();
    const emptyDatabase = Buffer.from((db.driver as any).databaseConnection.export());
    const originals = Array.from({ length: 8 }, () => evidence({ authState: 'authenticated', peerIp: '127.0.0.1' }));
    const entries = checkpointEntries(originals.flatMap(start => [start, terminal(start)]));
    const projector = new CallObservabilityCallersProjector(new ConfigService({
      API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 'a'.repeat(32), API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID: 'v1',
    }));
    const snapshot = async () => {
      const tables: Record<string, unknown[]> = {};
      const normalize = (value: any): any => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
          .filter(([key]) => !['createdAt', 'updatedAt', 'ingestedAt', 'queuedAt', 'expiresAt', 'occurredAt'].includes(key))
          .map(([key, child]) => [key, normalize(child)]));
        return value;
      };
      for (const entity of [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity]) {
        const rows = await db.getRepository(entity).find();
        tables[entity.name] = rows.map(row => {
          if (entity === RuntimeObservabilityEventEntity) delete (row as any).id;
          return normalize(row);
        }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return tables;
    };
    await store.ingestBatch(entries, projector.project, { coalesceBuckets: true });
    const expected = await snapshot(); await db.destroy();
    const secondLocation = join(directory, 'equivalent.sqlite'); await fs.writeFile(secondLocation, emptyDatabase);
    db = await new DataSource({ type: 'sqljs', location: secondLocation, autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] }).initialize();
    store = new CallObservabilityStore(db, payloads);
    await store.ingestBatch(entries, projector.project, bulk);
    expect(await snapshot()).toEqual(expected);
  });

  it('keeps arbitrary hooks on the immediate default path with preceding core facts visible', async () => {
    const start = evidence(), finish = terminal(start); let index = 0;
    await store.ingestBatch([{ input: start, context: {} }, { input: finish, context: {} }], async (tx, before) => {
      expect(await tx.manager.getRepository(RuntimeIngestReceiptEntity).count()).toBe(++index);
      expect(await tx.manager.getRepository(RuntimeInvocationEntity).count()).toBe(before ? 1 : 0);
    });
  });
});
