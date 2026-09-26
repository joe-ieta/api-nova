'use strict';
// OBS-16-02 bounded local storage fault unit for the SQL.js call-observability pipeline.
// This suite is intentionally not standalone: scripts/verify-obs-16-local-unit.cjs owns the
// frozen fixture scale and passes it through the OBS16_* environment variables.
process.env.DB_TYPE = 'sqlite';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity: Event } =
  require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { CallObservabilityStore } =
  require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } =
  require('../dist/src/modules/call-observability/call-observability-payload.store.js');

const RAW_EVENT_NAME = 'local.fault.batch_marker';
const temporaryRoot = path.resolve(__dirname, '../../../tmp/observability-local-fault-unit-tests');

function frozenScale() {
  const definitions = {
    callCount: 'OBS16_CALL_COUNT',
    eventBatch: 'OBS16_EVENT_BATCH',
    payloadCount: 'OBS16_PAYLOAD_COUNT',
    seed: 'OBS16_SEED',
  };
  const scale = {};
  for (const [name, variable] of Object.entries(definitions)) {
    const value = Number(process.env[variable]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Missing frozen OBS-16 scale variable ${variable}; run through scripts/verify-obs-16-local-unit.cjs`);
    }
    scale[name] = value;
  }
  if (scale.payloadCount > scale.callCount || scale.callCount % scale.payloadCount !== 0) {
    throw new Error('Frozen OBS-16 scale requires callCount to be a positive multiple of payloadCount');
  }
  return scale;
}
const SCALE = frozenScale();

function deterministicUuid(label, index) {
  const hex = createHash('sha256').update(`${SCALE.seed}|${label}|${index}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
function deterministicOffset(label, index, modulo) {
  return parseInt(createHash('sha256').update(`${SCALE.seed}|${label}|${index}`).digest('hex').slice(0, 8), 16) % modulo;
}
function ownedDirectory(directory) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('run-')) {
    throw new Error('Refusing a non-owned persistent fault-unit directory');
  }
  return target;
}
// SQL.js autosave is disabled to keep the frozen scale bounded; durability is asserted only at
// explicit driver.save() boundaries, matching the existing restart harness convention.
function createDataSource(location) {
  return new DataSource({ type: 'sqljs', location, autoSave: false,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true, logging: false });
}

const runAnchor = Date.now() - 10 * 60 * 1000;
function startRecord(index) {
  return {
    schemaVersion: 2,
    invocationId: deterministicUuid('invocation', index),
    eventId: deterministicUuid('event-start', index),
    sourceInstanceId: deterministicUuid('source', 0),
    sourceSequence: index * 2 + 1,
    recordVersion: 1,
    phase: 'started',
    requestId: deterministicUuid('request', index),
    spanKind: 'gateway_request',
    serverType: 'gateway',
    transport: 'gateway',
    protocolTransport: 'http',
    origin: 'external',
    identitySource: 'authenticated',
    callerId: 'local-fault-subject',
    credentialId: 'local-fault-credential',
    peerIp: '127.0.0.1',
    runtimeAssetId: deterministicUuid('asset', 0),
    startedAt: new Date(runAnchor - (SCALE.callCount - index) * 1000).toISOString(),
  };
}
function terminalRecord(start, index, withBody) {
  const startedAt = Date.parse(start.startedAt);
  const response = { state: 'unavailable', reason: 'not_captured' };
  if (withBody) {
    const data = `local-fault-response-${index}-seed-${SCALE.seed}`;
    Object.assign(response, { state: 'complete', encoding: 'utf8', contentType: 'text/plain', data,
      totalBytes: Buffer.byteLength(data), capturedBytes: Buffer.byteLength(data), redacted: true });
  }
  return {
    ...start,
    eventId: deterministicUuid('event-end', index),
    sourceSequence: index * 2 + 2,
    recordVersion: 2,
    phase: 'finished',
    completedAt: new Date(startedAt + 50 + deterministicOffset('duration', index, 500)).toISOString(),
    outcome: 'success',
    statusCode: 200,
    response,
  };
}
function buildFixtures() {
  const step = SCALE.callCount / SCALE.payloadCount;
  return Array.from({ length: SCALE.callCount }, (_, index) => {
    const start = startRecord(index);
    return { start, terminal: terminalRecord(start, index, index % step === 0) };
  });
}

const state = { directory: null, payloads: null, database: null, store: null, fixtures: null, baseline: null,
  ingestEvents: null, reopen: null, duplicateReplay: null, quarantine: null, failureReported: null };
const timings = {};

async function openStore(directory) {
  const database = createDataSource(path.join(directory, 'observability.sqlite'));
  await database.initialize();
  return { database, store: new CallObservabilityStore(database, state.payloads) };
}
async function readCounts(store) {
  return store.readSnapshot(async tx => {
    const manager = tx.manager;
    const payloads = manager.getRepository(entities.RuntimePayloadEntity);
    return {
      snapshotSeq: tx.snapshotSeq,
      invocations: await manager.getRepository(entities.RuntimeInvocationEntity).count(),
      receipts: await manager.getRepository(entities.RuntimeIngestReceiptEntity).count(),
      revisions: await manager.getRepository(entities.RuntimeInvocationRevisionEntity).count(),
      payloadRows: await payloads.count(),
      capturedPayloads: await payloads.count({ where: { state: 'captured' } }),
      completedEvents: await manager.getRepository(Event).count({ where: { eventName: 'invocation.completed' } }),
      rawBatchEvents: await manager.getRepository(Event).count({ where: { eventName: RAW_EVENT_NAME } }),
      quarantined: await manager.getRepository(entities.RuntimeIngestQuarantineEntity).count(),
    };
  });
}
function expectedCounts() {
  return {
    invocations: SCALE.callCount,
    receipts: SCALE.callCount * 2,
    revisions: SCALE.callCount * 2,
    // Every invocation retains one unavailable request row and one unavailable response row;
    // each captured terminal response adds one distinct captured row instead of replacing it.
    payloadRows: SCALE.callCount * 2 + SCALE.payloadCount,
    capturedPayloads: SCALE.payloadCount,
    completedEvents: SCALE.callCount,
    rawBatchEvents: SCALE.eventBatch,
    quarantined: 0,
  };
}

before(async () => {
  const started = Date.now();
  await fs.mkdir(temporaryRoot, { recursive: true });
  state.directory = ownedDirectory(await fs.mkdtemp(path.join(temporaryRoot, 'run-')));
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(state.directory, 'data');
  state.payloads = new CallObservabilityPayloadStore();
  const opened = await openStore(state.directory);
  state.database = opened.database;
  state.store = opened.store;
  state.fixtures = buildFixtures();

  let ingestedEvents = 0;
  for (const fixture of state.fixtures) {
    const startedResult = await state.store.ingest(fixture.start);
    assert.equal(startedResult.status, 'inserted', `started record must insert ${fixture.start.invocationId}`);
    assert.equal(startedResult.events.length, 1, 'a started business invocation retains one in-flight transition event');
    const finishedResult = await state.store.ingest(fixture.terminal);
    assert.equal(finishedResult.status, 'updated', `terminal record must update ${fixture.start.invocationId}`);
    assert.equal(finishedResult.events.length, 2, 'a finished invocation retains one transition and one completion event');
    ingestedEvents += startedResult.events.length + finishedResult.events.length;
  }
  timings.ingestMs = Date.now() - started;
  state.ingestEvents = ingestedEvents;
  assert.equal(ingestedEvents, SCALE.callCount * 3);

  timings.eventBatchMs = Date.now();
  const inserted = await state.store.transaction(async tx => {
    const rows = [];
    for (let index = 0; index < SCALE.eventBatch; index++) {
      rows.push({ id: deterministicUuid('raw-event', index), sequence: tx.nextSequence(), schemaVersion: '1.0',
        subjectId: deterministicUuid('raw-subject', index), subjectVersion: 1, eventName: RAW_EVENT_NAME,
        eventFamily: 'runtime.control', severity: 'info', status: 'success', actorType: 'system',
        occurredAt: new Date(), retentionClass: 'standard', dispatchState: 'pending',
        expiresAt: new Date(Date.now() + 14 * 86400000),
        dimensions: { runtimeAssetId: null },
        details: { fixture: 'obs-16-local-fault-unit', seed: SCALE.seed, index } });
    }
    for (let index = 0; index < rows.length; index += 100) {
      await tx.manager.getRepository(Event).insert(rows.slice(index, index + 100));
    }
    return rows.length;
  });
  timings.eventBatchMs = Date.now() - timings.eventBatchMs;
  assert.equal(inserted, SCALE.eventBatch);

  timings.readMs = Date.now();
  state.baseline = await readCounts(state.store);
  state.baseline.watermark = await state.store.watermark();
  timings.readMs = Date.now() - timings.readMs;
  for (const [name, value] of Object.entries(expectedCounts())) {
    assert.equal(state.baseline[name], value, `frozen baseline ${name} must equal ${value}`);
  }
  assert.ok(BigInt(state.baseline.snapshotSeq) > 0n, 'the frozen ingest must allocate durable sequences');
  assert.equal(state.baseline.watermark, state.baseline.snapshotSeq, 'read snapshot must expose the committed watermark');

  const captured = await state.database.getRepository(entities.RuntimePayloadEntity)
    .findOne({ where: { state: 'captured' } });
  assert.ok(captured, 'at least one frozen response body must be captured');
  const body = await state.payloads.read(captured);
  assert.equal(body.state, 'captured');
  assert.match(body.data, /^local-fault-response-\d+-seed-\d+$/);
  timings.fixtureMs = Date.now() - started;
});

test('SQL.js close and reopen preserves durable rows and the committed watermark', async () => {
  const started = Date.now();
  const beforeReopen = await readCounts(state.store);
  const beforeWatermark = await state.store.watermark();
  await state.database.driver.save();
  await state.database.destroy();
  const opened = await openStore(state.directory);
  state.database = opened.database;
  state.store = opened.store;
  const afterReopen = await readCounts(state.store);
  const afterWatermark = await state.store.watermark();
  assert.deepEqual(afterReopen, beforeReopen, 'durable counts must survive DataSource close/reopen');
  assert.equal(afterWatermark, beforeWatermark, 'the committed watermark must survive DataSource close/reopen');
  state.reopen = { counts: afterReopen, watermark: afterWatermark, matches: true };
  timings.reopenMs = Date.now() - started;
});

test('duplicate ingest does not double count and a conflicting duplicate is quarantined', async () => {
  const started = Date.now();
  const before = await readCounts(state.store);
  const beforeWatermark = await state.store.watermark();
  for (const fixture of state.fixtures) {
    const replayStart = await state.store.ingest(fixture.start);
    assert.equal(replayStart.status, 'duplicate', 'replayed started record must be a duplicate');
    const replayTerminal = await state.store.ingest(fixture.terminal);
    assert.equal(replayTerminal.status, 'duplicate', 'replayed terminal record must be a duplicate');
    assert.deepEqual(replayStart.events, [], 'duplicates must not publish new events');
    assert.deepEqual(replayTerminal.events, [], 'duplicates must not publish new events');
  }
  const replayed = await readCounts(state.store);
  assert.deepEqual(replayed, before, 'duplicate replay must not change durable counts');
  assert.equal(await state.store.watermark(), beforeWatermark, 'duplicate replay must not advance the watermark');
  state.duplicateReplay = { records: SCALE.callCount * 2, status: 'duplicate', countsUnchanged: true,
    watermarkUnchanged: true };

  const conflict = { ...state.fixtures[0].terminal, outcome: 'failure' };
  const quarantined = await state.store.ingest(conflict);
  assert.equal(quarantined.status, 'quarantined', 'a conflicting source event must be quarantined');
  assert.equal(quarantined.reason, 'SOURCE_EVENT_CONFLICT');
  const after = await readCounts(state.store);
  assert.deepEqual(after, { ...before, quarantined: before.quarantined + 1 },
    'quarantine must be recorded without double counting the invocation');
  assert.equal(await state.store.watermark(), beforeWatermark, 'quarantine must not advance the watermark');
  state.quarantine = { status: quarantined.status, reason: quarantined.reason,
    quarantineRows: after.quarantined, countsUnchanged: true };
  timings.duplicateMs = Date.now() - started;
});

test('a storage failure after close is reported and leaves durable rows intact', async () => {
  const started = Date.now();
  const before = await readCounts(state.store);
  await state.database.driver.save();
  await state.database.destroy();
  const neverIngested = startRecord(SCALE.callCount);
  await assert.rejects(state.store.ingest(neverIngested), error => {
    assert.ok(error instanceof Error, 'a closed store must report an Error');
    assert.ok(String(error.message || error).length > 0, 'the failure must carry a message');
    return true;
  });
  const opened = await openStore(state.directory);
  state.database = opened.database;
  state.store = opened.store;
  const after = await readCounts(state.store);
  assert.deepEqual(after, before, 'the failed write must not drop or duplicate durable rows');
  assert.equal(await state.database.getRepository(entities.RuntimeInvocationEntity)
    .findOneBy({ invocationId: neverIngested.invocationId }), null, 'the failed write must not persist');
  state.failureReported = { rejected: true, durableCountsUnchanged: true };
  timings.failureMs = Date.now() - started;
});

after(async () => {
  let cleanupError = null;
  try {
    if (state.payloads) await state.payloads.onModuleDestroy();
    if (state.database?.isInitialized) {
      await state.database.driver.save();
      await state.database.destroy();
    }
  } catch (error) {
    cleanupError = error;
  }
  console.log(JSON.stringify({ marker: 'OBS_16_FAULT_UNIT_DETAIL', scale: SCALE,
    frozenExpectations: expectedCounts(), ingestEvents: state.ingestEvents, baseline: state.baseline,
    reopen: state.reopen, duplicateReplay: state.duplicateReplay, quarantine: state.quarantine,
    failureReported: state.failureReported, timings }));
  if (state.directory) await fs.rm(ownedDirectory(state.directory), { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
});
