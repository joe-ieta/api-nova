'use strict';

// Isolated call-observability tests. Never load configured business DB options.
process.env.DB_TYPE = 'sqlite';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } =
  require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } =
  require('../dist/src/modules/call-observability/call-observability-payload.store.js');
const { sequenceKey, publicSequence, canonicalJson, SerialStorageLane } =
  require('../dist/src/modules/call-observability/call-observability-storage.js');

const workspace = path.resolve(__dirname, '../../..');
const temporaryRoot = path.join(workspace, 'tmp', 'observability-storage-tests');
const hash = value => createHash('sha256').update(value).digest('hex');
const errorCode = code => error => error && error.code === code;
const body = (data = '{"ok":true}') => ({
  state: 'complete', contentType: 'application/json', encoding: 'utf8',
  data, totalBytes: Buffer.byteLength(data), capturedBytes: Buffer.byteLength(data),
  sha256: hash(data), redacted: true,
});
const missingBody = () => ({ state: 'unavailable', reason: 'not_captured' });

function evidence(overrides = {}) {
  const invocationId = randomUUID();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return {
    schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'started',
    requestId: randomUUID(), traceId: invocationId, rootInvocationId: invocationId,
    kind: 'admission', spanKind: 'gateway_request', transport: 'gateway',
    serverType: 'gateway', protocolTransport: 'http', origin: 'external',
    runtimeAssetId: randomUUID(), identitySource: 'authenticated',
    callerId: 'caller-test', credentialId: 'credential-test',
    startedAt, method: 'GET', path: '/sample',
    byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress',
    requestHeaders: { authorization: 'Bearer private-test-secret' },
    responseHeaders: {}, request: body(), response: missingBody(),
    ...overrides,
  };
}

function terminal(start, overrides = {}) {
  return {
    ...start, eventId: randomUUID(), sourceSequence: start.sourceSequence + 1,
    recordVersion: start.recordVersion + 1, phase: 'finished',
    completedAt: new Date().toISOString(), durationMs: 25,
    outcome: 'success', statusCode: 200, response: body('{"result":"ok"}'),
    ...overrides,
  };
}

function checkpoint(previousOffset = '0', byteOffset = '100', seed = randomUUID()) {
  const fileName = 'calls-v2-2026-09-08-' + seed + '.jsonl';
  return { id: hash(fileName), fileName, fileIdentity: 'fixture:' + seed, previousOffset, byteOffset };
}

async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
  const oldDirectory = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloads = new CallObservabilityPayloadStore();
  if (oldDirectory === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldDirectory;
  const database = new DataSource({
    type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false,
  });
  t.after(async () => {
    if (database.isInitialized) await database.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('run-')) {
      throw new Error('Refusing to delete a non-owned test directory');
    }
    await fs.rm(target, { recursive: true, force: true });
  });
  await database.initialize();
  const store = new CallObservabilityStore(database, payloads);
  const repository = entity => database.getRepository(entity);
  return { database, payloads, store, directory, repository };
}

test('stores metadata, body references, receipt, version and checkpoint atomically', async t => {
  const f = await fixture(t);
  const row = evidence();
  const cp = checkpoint();
  const result = await f.store.ingest(row, { checkpoint: cp });
  assert.equal(result.status, 'inserted');
  assert.equal(result.snapshotSeq, '1');
  assert.equal(result.events.length, 0);
  const current = await f.repository(entities.RuntimeInvocationEntity)
    .findOneByOrFail({ invocationId: row.invocationId });
  assert.equal(current.sourceRecordVersion, 1);
  assert.equal(current.recordVersion, 1);
  assert.equal(current.record.request.data, undefined);
  assert.equal(current.record.response.data, undefined);
  assert.equal(JSON.stringify(current).includes('private-test-secret'), false);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeInvocationRevisionEntity).count(), 1);
  const savedCheckpoint = await f.repository(entities.RuntimeIngestCheckpointEntity).findOneByOrFail({ id: cp.id });
  assert.equal(savedCheckpoint.byteOffset, sequenceKey('100'));
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  assert.equal((await f.payloads.read(payload)).data, row.request.data);
});

test('finished calls persist metadata-only events before returning event references', async t => {
  const f = await fixture(t);
  const start = evidence();
  const result = await f.store.ingest(terminal(start));
  const event = await f.repository(RuntimeObservabilityEventEntity).findOneByOrFail({ id: result.events[0].eventId });
  assert.equal(event.eventName, 'invocation.completed');
  assert.equal(publicSequence(event.sequence), result.snapshotSeq);
  assert.equal(event.dispatchState, 'pending');
  assert.equal(event.details.request.data, undefined);
  assert.equal(event.details.response.data, undefined);
  assert.equal(event.details.requestHeaders, undefined);
  assert.equal(event.details.clientIp, undefined);
  assert.equal(event.details.path, undefined);
});

test('same source event is idempotent and does not advance the public watermark', async t => {
  const f = await fixture(t);
  const row = terminal(evidence());
  const cp = checkpoint();
  const first = await f.store.ingest(row, { checkpoint: cp });
  const second = await f.store.ingest(row, { checkpoint: cp });
  assert.equal(second.status, 'duplicate');
  assert.equal(second.snapshotSeq, first.snapshotSeq);
  assert.equal(second.recordVersion, 1);
  assert.equal(second.events.length, 0);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 1);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 1);
});

test('a failed projection hook rolls back receipt, invocation, checkpoint and sequence', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  await assert.rejects(() => f.store.ingest(terminal(evidence()), { checkpoint: cp },
    async () => { throw new Error('injected projection failure'); }), /injected projection failure/);
  for (const entity of [entities.RuntimeIngestReceiptEntity, entities.RuntimeInvocationEntity,
    entities.RuntimeInvocationRevisionEntity, entities.RuntimePayloadEntity,
    entities.RuntimeIngestCheckpointEntity, RuntimeObservabilityEventEntity]) {
    assert.equal(await f.repository(entity).count(), 0, entity.name);
  }
  assert.equal(await f.store.watermark(), '0');
});

test('same source event with different content is quarantined without overwriting evidence', async t => {
  const f = await fixture(t);
  const row = terminal(evidence());
  await f.store.ingest(row);
  const conflict = await f.store.ingest({ ...row, response: body('private-conflicting-content') });
  assert.equal(conflict.status, 'quarantined');
  assert.equal(conflict.reason, 'SOURCE_EVENT_CONFLICT');
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.responsePayloadId });
  assert.equal((await f.payloads.read(payload)).data, row.response.data);
  const quarantined = await f.repository(entities.RuntimeIngestQuarantineEntity).find();
  assert.equal(quarantined.length, 1);
  assert.equal(JSON.stringify(quarantined).includes('private-conflicting-content'), false);
});

test('same source version with a different event is a version conflict', async t => {
  const f = await fixture(t);
  const row = evidence();
  await f.store.ingest(row);
  const result = await f.store.ingest({ ...row, eventId: randomUUID() });
  assert.equal(result.reason, 'SOURCE_VERSION_CONFLICT');
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
});

test('an invocation cannot switch runtime asset ownership', async t => {
  const f = await fixture(t);
  const row = evidence();
  await f.store.ingest(row);
  const result = await f.store.ingest(terminal(row, { runtimeAssetId: randomUUID() }));
  assert.equal(result.reason, 'INVOCATION_IDENTITY_CONFLICT');
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  assert.equal(current.runtimeAssetId, row.runtimeAssetId);
});

test('an observed terminal outcome cannot be mutated by a higher source version', async t => {
  const f = await fixture(t);
  const row = terminal(evidence());
  await f.store.ingest(row);
  const result = await f.store.ingest(terminal(row, { outcome: 'error', statusCode: 500 }));
  assert.equal(result.reason, 'TERMINAL_RECORD_MUTATION');
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  assert.equal(current.outcome, 'success');
});

test('late progress is receipted but cannot regress a newer terminal projection', async t => {
  const f = await fixture(t);
  const start = evidence();
  await f.store.ingest(terminal(start, { recordVersion: 3, sourceSequence: 3 }));
  const result = await f.store.ingest({
    ...start, eventId: randomUUID(), phase: 'progress', recordVersion: 2, sourceSequence: 2,
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.recordVersion, 1);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 2);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 1);
});

test('inferred unknown and late observed terminal use independent projection/source versions', async t => {
  const f = await fixture(t);
  const start = evidence();
  await f.store.ingest(start);
  const inferred = await f.store.reconcile(start.invocationId, 1, {
    reason: 'process_exit', observedBefore: new Date().toISOString(),
  });
  assert.equal(inferred.status, 'updated');
  let current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
  assert.equal(current.recordVersion, 2);
  assert.equal(current.sourceRecordVersion, 1);
  assert.equal(current.outcome, 'unknown');
  assert.equal(current.completedAt, null);
  assert.equal(current.record.durationMs, null);
  assert.equal(current.record.completionSource, 'reconciled');
  const observed = await f.store.ingest(terminal(start));
  assert.equal(observed.status, 'updated');
  current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
  assert.equal(current.recordVersion, 3);
  assert.equal(current.sourceRecordVersion, 2);
  assert.equal(current.outcome, 'success');
  assert.equal(current.record.completionSource, 'observed');
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  const events = await f.repository(RuntimeObservabilityEventEntity).find({ order: { sequence: 'ASC' } });
  assert.deepEqual(events.map(item => item.eventName), ['invocation.reconciled', 'invocation.reconciled']);
});

test('stale reconciliation cannot overwrite a newer observed record', async t => {
  const f = await fixture(t);
  const start = evidence();
  await f.store.ingest(start);
  await f.store.ingest(terminal(start));
  const watermark = await f.store.watermark();
  const result = await f.store.reconcile(start.invocationId, 1, {
    reason: 'progress_timeout', observedBefore: new Date().toISOString(),
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.snapshotSeq, watermark);
});

test('checkpoint optimistic offset conflict rolls back the entire second call', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  await f.store.ingest(evidence(), { checkpoint: cp });
  const before = await f.store.watermark();
  await assert.rejects(() => f.store.ingest(terminal(evidence()), {
    checkpoint: { ...cp, previousOffset: '50', byteOffset: '200' },
  }), errorCode('CHECKPOINT_CONFLICT'));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 1);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 0);
  assert.equal(await f.store.watermark(), before);
});

test('a changed checkpoint file identity does not skip uncommitted evidence', async t => {
  const f = await fixture(t);
  const cp = checkpoint();
  await f.store.ingest(evidence(), { checkpoint: cp });
  await assert.rejects(() => f.store.ingest(terminal(evidence()), {
    checkpoint: { ...cp, fileIdentity: 'replacement-file', previousOffset: '100', byteOffset: '200' },
  }), errorCode('CHECKPOINT_FILE_CHANGED'));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
});

test('payload write failure degrades content but still commits invocation metadata', async t => {
  const f = await fixture(t);
  f.payloads.publish = async () => { throw new Error('injected disk failure'); };
  const start = evidence();
  const result = await f.store.ingest(start, { checkpoint: checkpoint() });
  assert.equal(result.status, 'inserted');
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: start.invocationId });
  assert.equal(current.record.request.state, 'omitted');
  assert.equal(current.record.request.reason, 'storage_error');
  assert.equal(current.record.request.observedBytes, start.request.totalBytes);
  const diagnostics = await f.repository(entities.RuntimePipelineStateEntity)
    .findOneByOrFail({ id: 'call-observability:storage-diagnostics' });
  assert.equal(diagnostics.value.payloadWriteFailures, 1);
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 1);
});

test('HTTP 200 with a tool error remains an error event', async t => {
  const f = await fixture(t);
  const row = terminal(evidence({
    kind: 'tool', spanKind: 'mcp_tool', serverType: 'mcp',
    transport: 'mcp', protocolTransport: 'stdio', byteMeasurement: 'serialized_payload',
  }), { toolIsError: true });
  const result = await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  assert.equal(current.outcome, 'error');
  const event = await f.repository(RuntimeObservabilityEventEntity).findOneByOrFail({ id: result.events[0].eventId });
  assert.equal(event.status, 'failed');
});

test('cancelled calls are not reported as successful events', async t => {
  const f = await fixture(t);
  const result = await f.store.ingest(terminal(evidence(), { outcome: 'cancelled' }));
  const event = await f.repository(RuntimeObservabilityEventEntity).findOneByOrFail({ id: result.events[0].eventId });
  assert.equal(event.status, 'partial');
  assert.equal(event.details.outcome, 'cancelled');
});

test('captured empty content stays distinguishable from unavailable content', async t => {
  const f = await fixture(t);
  const row = evidence({ request: body(''), response: missingBody() });
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const request = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  const response = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.responsePayloadId });
  assert.equal(request.state, 'captured');
  assert.equal((await f.payloads.read(request)).data, '');
  assert.equal(response.state, 'unavailable');
  assert.equal((await f.payloads.read(response)).observedBytes, null);
});

test('omitted bodies never retain accidentally supplied fragments', async t => {
  const f = await fixture(t);
  const row = evidence({ request: { ...body('omitted-secret-fragment'), state: 'omitted', reason: 'policy' } });
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  assert.equal(payload.fileKey, null);
  assert.equal((await f.payloads.read(payload)).data, undefined);
  assert.equal(JSON.stringify(current).includes('omitted-secret-fragment'), false);
});

test('body retention can expire independently of retained invocation metadata', async t => {
  const f = await fixture(t);
  const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const row = terminal(evidence({ startedAt: oldTime }), { completedAt: oldTime });
  const result = await f.store.ingest(row);
  assert.equal(result.status, 'inserted');
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.responsePayloadId });
  assert.equal(payload.state, 'expired');
  await assert.rejects(() => f.payloads.read(payload), errorCode('PAYLOAD_EXPIRED'));
});

test('object paths cannot be replaced with caller-controlled traversal paths', async t => {
  const f = await fixture(t);
  const row = evidence();
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  await assert.rejects(() => f.payloads.read({ ...payload, fileKey: '../../outside' }),
    errorCode('INVALID_PAYLOAD_METADATA'));
});

test('stored byte integrity is checked rather than trusting a filename', async t => {
  const f = await fixture(t);
  const row = evidence();
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  const file = path.join(f.directory, 'payloads', payload.fileKey);
  await fs.writeFile(file, 'x'.repeat(payload.metadata.storedBytes), 'utf8');
  await assert.rejects(() => f.payloads.read(payload), errorCode('PAYLOAD_INTEGRITY_ERROR'));
});

test('a symlinked shard cannot redirect payload writes outside the object root', async t => {
  const f = await fixture(t);
  const row = evidence();
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  const payload = await f.repository(entities.RuntimePayloadEntity).findOneByOrFail({ id: current.requestPayloadId });
  const object = path.join(f.directory, 'payloads', payload.fileKey);
  const shard = path.dirname(object);
  const outside = path.join(f.directory, 'outside-object-root');
  await fs.mkdir(outside);
  await fs.unlink(object);
  await fs.rmdir(shard);
  await fs.symlink(outside, shard, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.payloads.prepare({
    sourceInstanceId: row.sourceInstanceId, invocationId: row.invocationId, side: 'request',
  }, { ...payload.metadata, data: row.request.data }, new Date().toISOString(), payload.expiresAt, '0');
  assert.equal(result.storageFailed, true);
  assert.equal(result.body.reason, 'storage_error');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('stored-size limits preserve measured byte counts when content is omitted', async t => {
  const f = await fixture(t);
  f.payloads.writeLimit = 4;
  const row = evidence({ request: body('12345678') });
  await f.store.ingest(row);
  const current = await f.repository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: row.invocationId });
  assert.equal(current.record.request.state, 'omitted');
  assert.equal(current.record.request.reason, 'storage_body_limit');
  assert.equal(current.record.request.observedBytes, 8);
  assert.equal(current.record.request.storedBytes, 0);
});

test('unsupported source schemas are rejected, then safely quarantined by the collector', async t => {
  const f = await fixture(t);
  const row = evidence({ schemaVersion: 1 });
  await assert.rejects(() => f.store.ingest(row), /schemaVersion/);
  const cp = checkpoint();
  const result = await f.store.rejectRecord({ checkpoint: cp }, hash(JSON.stringify(row)), 'INVALID_SCHEMA');
  assert.equal(result.status, 'quarantined');
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 1);
});

test('malformed input quarantine stores only hashes and safe reason codes', async t => {
  const f = await fixture(t);
  const invalidJson = '{"access_token":"private-malformed-secret"';
  await f.store.rejectRecord({ checkpoint: checkpoint() }, hash(invalidJson), 'INVALID_JSON');
  const records = await f.repository(entities.RuntimeIngestQuarantineEntity).find();
  assert.equal(records.length, 1);
  assert.equal(records[0].recordHash, hash(invalidJson));
  assert.equal(JSON.stringify(records).includes('private-malformed-secret'), false);
});

test('rolled-back sequence reservations cannot become public watermarks', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.store.transaction(async tx => {
    assert.equal(publicSequence(tx.nextSequence()), '1');
    assert.equal(publicSequence(tx.nextSequence()), '2');
    throw new Error('rollback sequence');
  }), /rollback sequence/);
  assert.equal(await f.store.watermark(), '0');
  const result = await f.store.ingest(terminal(evidence()));
  assert.equal(result.snapshotSeq, '1');
});

test('concurrent local writes have unique commit sequences and durable events', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.store.ingest(terminal(evidence()))));
  assert.deepEqual(results.map(result => result.snapshotSeq), ['1', '2', '3', '4', '5', '6']);
  assert.equal(await f.store.watermark(), '6');
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 6);
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 6);
});

test('multiple store instances share a local DataSource write lane', async t => {
  const f = await fixture(t);
  const second = new CallObservabilityStore(f.database, f.payloads);
  const results = await Promise.all([
    f.store.ingest(terminal(evidence())), second.ingest(terminal(evidence())),
    f.store.ingest(terminal(evidence())), second.ingest(terminal(evidence())),
  ]);
  assert.equal(new Set(results.map(result => result.snapshotSeq)).size, 4);
  assert.equal(await f.store.watermark(), '4');
  assert.equal(await f.repository(RuntimeObservabilityEventEntity).count(), 4);
});

test('historical projection rows preserve stable snapshot visibility', async t => {
  const f = await fixture(t);
  const start = evidence();
  const first = await f.store.ingest(start);
  const second = await f.store.ingest(terminal(start));
  const visible = snapshot => f.repository(entities.RuntimeInvocationRevisionEntity)
    .createQueryBuilder('version')
    .where('version.invocationId = :id', { id: start.invocationId })
    .andWhere('version.validFromSequence <= :snapshot', { snapshot: sequenceKey(snapshot) })
    .andWhere('(version.validUntilSequence IS NULL OR version.validUntilSequence > :snapshot)')
    .getOneOrFail();
  assert.equal((await visible(first.snapshotSeq)).phase, 'started');
  assert.equal((await visible(second.snapshotSeq)).phase, 'finished');
  assert.equal((await visible(first.snapshotSeq)).recordVersion, 1);
});

test('sequence encoding preserves uint64 order and rejects unsafe input', () => {
  assert.equal(publicSequence(sequenceKey('9007199254740993')), '9007199254740993');
  assert.equal(sequenceKey('9') < sequenceKey('10'), true);
  assert.equal(publicSequence(sequenceKey('18446744073709551615')), '18446744073709551615');
  assert.throws(() => sequenceKey('18446744073709551616'), errorCode('SEQUENCE_EXHAUSTED'));
  for (const value of ['-1', '1.2', '1e3', '']) assert.throws(() => sequenceKey(value), errorCode('INVALID_SEQUENCE'));
});

test('canonical receipt hashing is key-order independent and rejects cycles', () => {
  assert.equal(canonicalJson({ b: 2, a: [1, null] }), canonicalJson({ a: [1, null], b: 2 }));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), errorCode('INVALID_RECORD_VALUE'));
});

test('local lane capacity fails explicitly and releases capacity after rejection', async () => {
  const lane = new SerialStorageLane(1);
  let release;
  const first = lane.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(() => lane.run(async () => 2), errorCode('STORAGE_BUSY'));
  release(1);
  assert.equal(await first, 1);
  assert.equal(await lane.run(async () => 3), 3);
  assert.equal(lane.pending, 0);
});
