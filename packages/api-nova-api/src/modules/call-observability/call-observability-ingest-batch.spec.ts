import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { DataSource } from 'typeorm';
import { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity, RuntimeInvocationRevisionEntity,
  RuntimeIngestReceiptEntity, RuntimeIngestCheckpointEntity, RuntimeIngestQuarantineEntity, RuntimePayloadEntity, RuntimeMetricBucketEntity, RuntimeCallerBucketEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityCollector } from './call-observability.collector';

describe('bounded durable collector batches', () => {
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
  it('commits 16 chained source offsets, survives reopen and replays without new revisions/events', async () => {
    const records = Array.from({ length: 16 }, () => terminal(evidence()));
    const file = await source(records); const report = await collector.collectFile(file.fileName, { maxRecords: 16 });
    expect(report.processedRecords).toBe(16); expect(report.byteOffset).toBe(String(file.bytes));
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(16);
    const events = await db.getRepository(RuntimeObservabilityEventEntity).count();
    await db.destroy();
    db = await new DataSource({ type: 'sqljs', location, autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity] }).initialize();
    store = new CallObservabilityStore(db, payloads);
    expect(await db.getRepository(RuntimeIngestReceiptEntity).count()).toBe(16);
    const duplicate = await store.ingestBatch(records.map(input => ({ input, context: {} })));
    expect(duplicate.every(row => row.status === 'duplicate' && row.events.length === 0)).toBe(true);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(16);
    expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(events);
  });
  it('rolls back all facts, receipts, events and checkpoint after a mid-batch projection failure, then retries', async () => {
    const file = await source(Array.from({ length: 16 }, () => terminal(evidence()))); let projected = 0;
    await expect(collector.collectFile(file.fileName, {}, async () => {
      if (++projected === 9) throw new Error('injected ninth projection failure');
    })).rejects.toThrow('injected ninth');
    for (const entity of [RuntimeInvocationEntity, RuntimeIngestReceiptEntity, RuntimeIngestCheckpointEntity, RuntimeObservabilityEventEntity]) {
      expect(await db.getRepository(entity).count()).toBe(0);
    }
    expect((await collector.collectFile(file.fileName)).processedRecords).toBe(16);
  });
  it('keeps valid neighbours while quarantining malformed JSON and invalid schemas in one batch', async () => {
    const file = await source([terminal(evidence()), '{bad', { bad: true }, terminal(evidence())]);
    const report = await collector.collectFile(file.fileName);
    expect(report.processedRecords).toBe(4); expect(report.quarantinedRecords).toBe(2);
    expect(report.byteOffset).toBe(String(file.bytes));
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(2);
    expect(await db.getRepository(RuntimeIngestQuarantineEntity).count()).toBe(2);
  });
  it('reads preceding revisions in its own transaction and preserves original payload expiry', async () => {
    const start = evidence(), finish = terminal(start);
    const results = await store.ingestBatch([{ input: start, context: {} }, { input: finish, context: {} }]);
    expect(results.map(row => row.status)).toEqual(['inserted', 'updated']);
    expect(results[0].events).toHaveLength(1); expect(results[1].events).toHaveLength(2);
    const revisions = await db.getRepository(RuntimeInvocationRevisionEntity).find({ order: { recordVersion: 'ASC' } });
    expect(revisions.map(row => row.recordVersion)).toEqual([1, 2]);
    const row = await db.getRepository(RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
    const payload = await db.getRepository(RuntimePayloadEntity).findOneByOrFail({ id: row.requestPayloadId! });
    expect(payload.expiresAt).toBe(new Date(Date.parse(start.startedAt) + 7 * 86400000).toISOString());
  });
  it('uses one durable acquire/read/commit/release cycle for 16 records without disabling autoSave', async () => {
    await store.ensurePayloadStorage();
    const save = jest.spyOn(db.driver as any, 'autoSave');
    for (let index = 0; index < 16; index++) await store.ingest(evidence());
    expect(save).toHaveBeenCalledTimes(64);
    save.mockClear();
    await store.ingestBatch(Array.from({ length: 16 }, () => ({ input: evidence(), context: {} })));
    expect(db.options.type).toBe('sqljs'); expect((db.options as any).autoSave).toBe(true);
    expect(save).toHaveBeenCalledTimes(4);
    await expect(store.ingestBatch(Array.from({ length: 17 }, () => ({ input: evidence(), context: {} })))).rejects.toThrow('INVALID_INGEST_BATCH');
  });
  it('blocks GC during preparation and refuses commit after a real writer lease is released', async () => {
    let lease: any; const acquire = store.payloadCoordination.acquireWriter.bind(store.payloadCoordination);
    jest.spyOn(store.payloadCoordination, 'acquireWriter').mockImplementation(async () => { lease = await acquire(); return lease; });
    const prepare = payloads.prepare.bind(payloads); let calls = 0;
    jest.spyOn(payloads, 'prepare').mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      if (++calls === 1) {
        expect(await store.payloadCoordination.acquireGc()).toEqual({ lease: null, reason: 'writer_active' });
        await store.payloadCoordination.releaseWriter(lease);
      }
      return prepared;
    });
    await expect(store.ingestBatch([{ input: evidence(), context: {} }])).rejects.toThrow('PAYLOAD_WRITE_LEASE_LOST');
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeIngestReceiptEntity).count()).toBe(0);
  });
  it('coalesces repeated dirty buckets with equivalent suppression, versions and final watermark', async () => {
    const asset = randomUUID(), startedAt = new Date(Date.now() - 1000).toISOString();
    const entries = Array.from({ length: 16 }, (_, index) => ({
      input: terminal(evidence({ runtimeAssetId: asset, startedAt })), context: { suppressEvent: index !== 0 },
    }));
    const queryLog = jest.spyOn(db.logger, 'logQuery');
    await store.ingestBatch(entries);
    const bucketWrites = () => queryLog.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/.test(sql) &&
      (sql.includes(db.getMetadata(RuntimeMetricBucketEntity).tableName) || sql.includes(db.getMetadata(RuntimeCallerBucketEntity).tableName))).length;
    const baselineWrites = bucketWrites();
    const normalize = (rows: unknown[]) => JSON.parse(JSON.stringify(rows).replace(/"queuedAt":"[^"]+"/g, '"queuedAt":"same"'));
    const expectedMetric = normalize(await db.getRepository(RuntimeMetricBucketEntity).find({ order: { id: 'ASC' } }));
    const expectedCaller = normalize(await db.getRepository(RuntimeCallerBucketEntity).find({ order: { id: 'ASC' } }));
    await db.destroy();
    db = await new DataSource({ type: 'sqljs', location: join(directory, 'coalesced.sqlite'), autoSave: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
    await payloads.onModuleDestroy(); process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(directory, 'coalesced-data');
    payloads = new CallObservabilityPayloadStore(); store = new CallObservabilityStore(db, payloads);
    const optimizedLog = jest.spyOn(db.logger, 'logQuery');
    await store.ingestBatch(entries, undefined, { coalesceBuckets: true });
    expect(normalize(await db.getRepository(RuntimeMetricBucketEntity).find({ order: { id: 'ASC' } }))).toEqual(expectedMetric);
    expect(normalize(await db.getRepository(RuntimeCallerBucketEntity).find({ order: { id: 'ASC' } }))).toEqual(expectedCaller);
    const writes = optimizedLog.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/.test(sql) &&
      (sql.includes(db.getMetadata(RuntimeMetricBucketEntity).tableName) || sql.includes(db.getMetadata(RuntimeCallerBucketEntity).tableName))).length;
    expect(writes).toBeLessThan(baselineWrites / 4);
  });

});
