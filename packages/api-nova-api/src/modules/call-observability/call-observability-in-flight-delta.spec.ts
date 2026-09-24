import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { DataSource } from 'typeorm';
import { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimeIngestReceiptEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityEventsService } from './call-observability-events.service';
import { publicSequence } from './call-observability-storage';

describe('retained business in-flight member deltas', () => {
  let db: DataSource, store: CallObservabilityStore, payloads: CallObservabilityPayloadStore;
  const body = () => ({ state: 'unavailable', reason: 'not_captured' });
  const evidence = (overrides: Record<string, unknown> = {}) => {
    const invocationId = randomUUID();
    return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
      sourceSequence: 1, recordVersion: 1, phase: 'started', requestId: randomUUID(), traceId: invocationId,
      rootInvocationId: invocationId, kind: 'admission', spanKind: 'gateway_request', transport: 'gateway',
      serverType: 'gateway', protocolTransport: 'http', origin: 'external', runtimeAssetId: randomUUID(),
      identitySource: 'authenticated', callerId: 'private-caller', credentialId: 'private-credential',
      startedAt: new Date(Date.now() - 1000).toISOString(), method: 'GET', path: '/private-path',
      byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress',
      requestHeaders: { authorization: 'Bearer private-token' }, responseHeaders: {}, request: body(), response: body(), ...overrides };
  };
  const terminal = (start: ReturnType<typeof evidence>) => ({ ...start, eventId: randomUUID(),
    sourceSequence: 2, recordVersion: 2, phase: 'finished', completedAt: new Date().toISOString(), durationMs: 25, outcome: 'success', statusCode: 200 });
  const open = async (database?: Uint8Array) => {
    db = await new DataSource({ type: 'sqljs', database, entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: !database }).initialize();
    store = new CallObservabilityStore(db, payloads);
  };
  const deltas = async () => (await db.getRepository(RuntimeObservabilityEventEntity).find({ order: { sequence: 'ASC' } }))
    .filter(event => event.details?.evidenceScope === 'retained_business_in_flight');
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/in-flight-delta-tests');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(join(root, 'run-'));
    const prior = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
    payloads = new CallObservabilityPayloadStore();
    if (prior === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = prior;
    await open();
  });
  afterEach(async () => { await payloads?.onModuleDestroy(); if (db?.isInitialized) await db.destroy(); });

  it.each(['gateway_request', 'mcp_tool'])('pairs start and terminal %s deltas with persisted revision sequence and final watermark', async spanKind => {
    const start = evidence(spanKind === 'mcp_tool' ? { spanKind, serverType: 'mcp', transport: 'mcp', kind: 'call', toolName: 'sample' } : {});
    await store.ingest(start);
    const result = await store.ingest(terminal(start));
    const events = await deltas();
    expect(events.map(event => event.details.delta)).toEqual([1, -1]);
    expect(events.map(event => event.subjectVersion)).toEqual([1, 2]);
    for (const event of events) {
      const revision = await db.getRepository(RuntimeInvocationRevisionEntity).findOneByOrFail({ invocationId: start.invocationId, recordVersion: event.subjectVersion });
      expect(event.details.revisionSequence).toBe(publicSequence(revision.validFromSequence));
      expect(BigInt(event.sequence)).toBeGreaterThan(BigInt(revision.validFromSequence));
      expect(event.subjectId).toBe(start.invocationId);
    }
    expect(result.snapshotSeq).toBe(await store.watermark());
    expect(BigInt(result.snapshotSeq)).toBeGreaterThan(BigInt(events[1].details.revisionSequence as string));
    expect(JSON.stringify(events)).not.toMatch(/private-token|private-path|private-caller|private-credential/);
  });

  it('emits no delta for direct terminal, non-business, missing asset, started update, duplicate or stale', async () => {
    await store.ingest(terminal(evidence()));
    await store.ingest(evidence({ spanKind: 'upstream_api' }));
    await store.ingest(evidence({ runtimeAssetId: null }));
    expect(await deltas()).toHaveLength(0);
    const start = evidence();
    await store.ingest(start);
    await store.ingest({ ...start, eventId: randomUUID(), recordVersion: 2, sourceSequence: 2 });
    await store.ingest(start);
    await store.ingest({ ...start, eventId: randomUUID() });
    expect(await deltas()).toHaveLength(1);
  });

  it('reconciles once, and an observed terminal after reconciliation does not decrement twice', async () => {
    const start = evidence(); await store.ingest(start);
    await store.reconcile(start.invocationId, 1, { reason: 'progress_timeout', observedBefore: new Date().toISOString() });
    await store.reconcile(start.invocationId, 1, { reason: 'progress_timeout', observedBefore: new Date().toISOString() });
    await store.ingest(terminal(start));
    expect((await deltas()).map(event => event.details.delta)).toEqual([1, -1]);
  });

  it('serializes competing duplicate ingest and terminal writes', async () => {
    const other = new CallObservabilityStore(db, payloads), start = evidence();
    await Promise.all([store.ingest(start), other.ingest(start)]);
    const finish = terminal(start);
    await Promise.all([store.ingest(finish), other.ingest(finish)]);
    expect((await deltas()).map(event => event.details.delta)).toEqual([1, -1]);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(2);
  });

  it('rolls back current, revisions, receipt, event and sequence after delta insertion failure', async () => {
    const start = evidence(), original = store.projectionEvent.bind(store);
    jest.spyOn(store, 'projectionEvent').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('delta-failure'); });
    await expect(store.ingest(start)).rejects.toThrow('delta-failure');
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeIngestReceiptEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(0);
    expect(await store.watermark()).toBe('0');
    await store.ingest(start);
    expect(await deltas()).toHaveLength(1);
  });

  it('restores paired evidence and watermark on reopen, with asset-scoped fixed-field reads', async () => {
    const start = evidence(); await store.ingest(start); await store.ingest(terminal(start));
    await store.ingest(evidence());
    const before = await store.watermark(), database = (db.driver as any).export() as Uint8Array;
    await db.destroy(); await open(database);
    expect(await store.watermark()).toBe(before);
    const reader = new CallObservabilityEventsService(store, { issue: () => 'test-cursor' } as any);
    const scope = { principalId: 'reader', runtimeAssetIds: [start.runtimeAssetId], requiredPermissions: ['monitoring:read'] as const, fingerprint: 'scope' };
    const result = await reader.list({ eventTypes: 'server.state_changed' }, scope);
    expect(result.data.items.map(event => event.data.delta)).toEqual([1, -1]);
    expect(result.data.items[0]).toMatchObject({ subject: { kind: 'in_flight_member', id: start.invocationId, version: 1 }, data: { invocationId: start.invocationId } });
    expect((await reader.list({}, { ...scope, runtimeAssetIds: [] })).data.items).toEqual([]);
  });
});
