'use strict';
process.env.DB_TYPE = 'sqlite';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } =
  require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } =
  require('../dist/src/modules/call-observability/call-observability-payload.store.js');
const { CallObservabilityCollector, COLLECTOR_DATASET_ID, COLLECTOR_STATUS_ID } =
  require('../dist/src/modules/call-observability/call-observability.collector.js');

const temporaryRoot = path.resolve(__dirname, '../../../tmp/observability-collector-tests');
const encode = value => JSON.stringify(value) + '\n';
const code = expected => error => error?.code === expected;

function evidence(overrides = {}) {
  const invocationId = randomUUID();
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'started', requestId: randomUUID(),
    traceId: invocationId, rootInvocationId: invocationId, spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external',
    runtimeAssetId: randomUUID(), identitySource: 'authenticated', callerId: 'trusted-caller',
    credentialId: 'credential-reference', startedAt: new Date(Date.now() - 1000).toISOString(),
    method: 'GET', path: '/example', ...overrides };
}
function terminal(start, overrides = {}) {
  return { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
    phase: 'finished', completedAt: new Date().toISOString(), outcome: 'success',
    statusCode: 200, durationMs: 10, ...overrides };
}
async function fixture(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  const oldAudit = process.env.API_NOVA_AUDIT_DIR;
  const oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_AUDIT_DIR = source;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  const payloads = new CallObservabilityPayloadStore();
  const database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true, logging: false });
  const store = new CallObservabilityStore(database, payloads);
  const makeCollector = () => {
    const previous = process.env.API_NOVA_AUDIT_DIR;
    process.env.API_NOVA_AUDIT_DIR = source;
    try { return new CallObservabilityCollector(store); }
    finally {
      if (previous === undefined) delete process.env.API_NOVA_AUDIT_DIR;
      else process.env.API_NOVA_AUDIT_DIR = previous;
    }
  };
  const collector = makeCollector();
  if (oldAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR;
  else process.env.API_NOVA_AUDIT_DIR = oldAudit;
  if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData;
  t.after(async () => {
    collector.onModuleDestroy();
    await payloads.onModuleDestroy();
    if (database.isInitialized) await database.destroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('run-')) {
      throw new Error('Refusing non-owned test cleanup');
    }
    await fs.rm(target, { recursive: true, force: true });
  });
  await database.initialize();
  const fileName = 'calls-v2-' + randomUUID() + '.jsonl';
  return { source, directory, database, store, collector, makeCollector, fileName,
    file: path.join(source, fileName), repository: entity => database.getRepository(entity) };
}
async function drain(collector, fileName, options) {
  let processed = 0, quarantined = 0, rounds = 0, result;
  do {
    result = await collector.collectFile(fileName, options);
    processed += result.processedRecords;
    quarantined += result.quarantinedRecords;
    assert.ok(++rounds < 100, 'bounded fixture must converge');
  } while (result.hasMore);
  return { ...result, processed, quarantined, rounds };
}

test('imports phases once and resumes from a transactionally committed byte offset', async t => {
  const f = await fixture(t);
  const start = evidence();
  const end = terminal(start);
  const data = encode(start) + encode(end) + encode(end);
  await fs.writeFile(f.file, data);
  const result = await f.collector.collectFile(f.fileName);
  assert.equal(result.processedRecords, 3);
  assert.equal(result.duplicateRecords, 1);
  assert.equal(result.byteOffset, String(Buffer.byteLength(data)));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeInvocationRevisionEntity).count(), 2);
  assert.equal(await f.repository(entities.RuntimeIngestReceiptEntity).count(), 2);
  assert.equal(await f.repository(Event).count(), 1);
  const restarted = f.makeCollector();
  assert.equal((await restarted.collectFile(f.fileName)).processedRecords, 0);
});

test('waits for an incomplete final line across collector restart without advancing it', async t => {
  const f = await fixture(t);
  const start = evidence();
  const first = encode(start);
  const end = encode(terminal(start));
  await fs.writeFile(f.file, first + end.slice(0, 71));
  const partial = await f.collector.collectFile(f.fileName);
  assert.equal(partial.byteOffset, String(Buffer.byteLength(first)));
  assert.equal(partial.partialBytes, 71);
  assert.equal(partial.hasMore, false);
  assert.equal(await f.repository(Event).count(), 0);
  await fs.appendFile(f.file, end.slice(71));
  const result = await f.makeCollector().collectFile(f.fileName);
  assert.equal(result.processedRecords, 1);
  assert.equal((await f.repository(entities.RuntimeInvocationEntity).find())[0].outcome, 'success');
});

test('carries a long line across bounded reads and respects the record budget', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence({ marker: 'x'.repeat(4000) })) + encode(evidence()));
  const first = await f.collector.collectFile(f.fileName, { maxReadBytes: 512, maxRecords: 1 });
  assert.equal(first.processedRecords, 0);
  assert.ok(first.bytesRead <= 512);
  const result = await drain(f.collector, f.fileName, { maxReadBytes: 512, maxRecords: 1 });
  assert.equal(result.processed, 2);
  assert.ok(result.rounds > 2);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 2);
});

test('hashes oversized lines without retaining them and continues after their newline', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'private-source-content'.repeat(200) + '\n' + encode(evidence()));
  const result = await drain(f.collector, f.fileName, { maxReadBytes: 256, maxLineBytes: 2048 });
  assert.equal(result.quarantined, 1);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  const quarantine = await f.repository(entities.RuntimeIngestQuarantineEntity).find();
  assert.equal(quarantine[0].reason, 'SOURCE_LINE_TOO_LARGE');
  assert.equal(JSON.stringify(quarantine).includes('private-source-content'), false);
  assert.match(quarantine[0].recordHash, /^[a-f0-9]{64}$/);
});

test('quarantines invalid JSON, invalid UTF-8 and old schema, then imports the next record', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, Buffer.concat([
    Buffer.from('not-json-private\n'), Buffer.from([0xff, 10]),
    Buffer.from(encode(evidence({ schemaVersion: 1 })) + encode(evidence())),
  ]));
  const result = await f.collector.collectFile(f.fileName);
  assert.equal(result.quarantinedRecords, 3);
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
  assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 3);
});

test('failed projection does not commit evidence, checkpoint or its boundary fingerprint', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  await assert.rejects(f.collector.collectFile(f.fileName, {}, async () => {
    throw new Error('injected projection failure');
  }), /injected projection failure/);
  for (const entity of [entities.RuntimeInvocationEntity, entities.RuntimeIngestCheckpointEntity,
    entities.RuntimeIngestReceiptEntity, entities.RuntimeInvocationRevisionEntity]) {
    assert.equal(await f.repository(entity).count(), 0);
  }
  const states = await f.repository(entities.RuntimePipelineStateEntity).find();
  assert.equal(states.some(state => state.id.startsWith('call-observability:boundary:')), false);
  assert.equal((await f.collector.collectFile(f.fileName)).processedRecords, 1);
  assert.equal(f.collector.volatileError, null);
});

test('a GC-held write lease fails without consuming the source and can be retried', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  const original = f.store.ingest.bind(f.store);
  f.store.ingest = async () => { const error = new Error('PAYLOAD_GC_BUSY'); error.code = 'PAYLOAD_GC_BUSY'; throw error; };
  await assert.rejects(f.collector.collectFile(f.fileName), code('PAYLOAD_GC_BUSY'));
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 0);
  assert.equal(await f.repository(entities.RuntimeIngestQuarantineEntity).count(), 0);
  f.store.ingest = original;
  assert.equal((await f.collector.collectFile(f.fileName)).processedRecords, 1);
});

test('rename retains the file identity and does not reimport committed records', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  const before = await f.collector.collectFile(f.fileName);
  const renamed = 'calls-v2-renamed-' + randomUUID() + '.jsonl';
  await fs.rename(f.file, path.join(f.source, renamed));
  const after = await f.makeCollector().collectFile(renamed);
  assert.equal(after.checkpointId, before.checkpointId);
  assert.equal(after.processedRecords, 0);
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 1);
});

test('replacement at the same filename starts a new checkpoint without deleting the old one', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  const before = await f.collector.collectFile(f.fileName);
  await fs.rename(f.file, path.join(f.source, 'calls-v2-rotated-' + randomUUID() + '.jsonl'));
  await fs.writeFile(f.file, encode(evidence()));
  const after = await f.collector.collectFile(f.fileName);
  assert.notEqual(after.checkpointId, before.checkpointId);
  assert.equal(after.processedRecords, 1);
  assert.equal(await f.repository(entities.RuntimeIngestCheckpointEntity).count(), 2);
});

test('truncation is reported without resetting the durable checkpoint', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  const before = await f.collector.collectFile(f.fileName);
  await fs.truncate(f.file, 0);
  await assert.rejects(f.collector.collectFile(f.fileName), code('SOURCE_FILE_TRUNCATED'));
  const cp = (await f.repository(entities.RuntimeIngestCheckpointEntity).find())[0];
  assert.equal(BigInt(cp.byteOffset).toString(), before.byteOffset);
  const state = await f.repository(entities.RuntimePipelineStateEntity).findOneByOrFail({ id: COLLECTOR_STATUS_ID });
  assert.equal(state.value.error, 'SOURCE_FILE_TRUNCATED');
});

test('copy-truncate followed by regrowth is detected using the committed boundary', async t => {
  const f = await fixture(t);
  const row = evidence({ marker: 'a'.repeat(100) });
  await fs.writeFile(f.file, encode(row));
  await f.collector.collectFile(f.fileName);
  await fs.writeFile(f.file, encode({ ...row, marker: 'b'.repeat(100) }));
  await assert.rejects(f.makeCollector().collectFile(f.fileName), code('SOURCE_BOUNDARY_CHANGED'));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 1);
});

test('initial dataset events are retained but suppressed, while new events remain pending', async t => {
  const f = await fixture(t);
  const dataset = await f.collector.initialize();
  const historical = terminal(evidence(), {
    completedAt: new Date(Date.parse(dataset.eventLiveSince) - 100).toISOString(),
  });
  const live = terminal(evidence(), {
    completedAt: new Date(Date.parse(dataset.eventLiveSince) + 100).toISOString(),
  });
  await fs.writeFile(f.file, encode(historical) + encode(live));
  await f.collector.collectFile(f.fileName);
  const events = await f.repository(Event).find();
  assert.equal(events.find(row => row.subjectId === historical.invocationId).dispatchState, 'suppressed');
  assert.equal(events.find(row => row.subjectId === live.invocationId).dispatchState, 'pending');
  assert.deepEqual(await f.makeCollector().initialize(), dataset);
  assert.equal(await f.repository(entities.RuntimePipelineStateEntity).countBy({ id: COLLECTOR_DATASET_ID }), 1);
});

test('source sequence gaps are reported and replay cannot move their watermark backwards', async t => {
  const f = await fixture(t);
  const start = evidence();
  await fs.writeFile(f.file, encode(start) + encode(terminal(start, { sourceSequence: 3 })) + encode(start));
  await f.collector.collectFile(f.fileName);
  const state = await f.repository(entities.RuntimePipelineStateEntity)
    .findOneByOrFail({ id: 'call-observability:storage-diagnostics' });
  assert.equal(state.value.sourceSequenceGaps, 1);
  const cp = (await f.repository(entities.RuntimeIngestCheckpointEntity).find())[0];
  assert.equal(BigInt(cp.lastSequence).toString(), '3');
});

test('refuses traversal, non-v2 names, hard links and invalid resource limits', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, encode(evidence()));
  for (const name of ['../' + f.fileName, 'calls-legacy.jsonl', 'C:\\private.jsonl']) {
    await assert.rejects(f.collector.collectFile(name), code('INVALID_SOURCE_FILE'));
  }
  await assert.rejects(f.collector.collectFile(f.fileName, { maxReadBytes: 0 }), code('INVALID_COLLECTOR_LIMIT'));
  const linked = 'calls-v2-linked-' + randomUUID() + '.jsonl';
  await fs.link(f.file, path.join(f.source, linked));
  await assert.rejects(f.collector.collectFile(linked), code('UNSAFE_SOURCE_FILE'));
  assert.equal(await f.repository(entities.RuntimeInvocationEntity).count(), 0);
});
