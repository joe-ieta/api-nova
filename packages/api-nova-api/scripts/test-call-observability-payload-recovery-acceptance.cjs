'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const entities = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require('../src/modules/call-observability/call-observability.store.ts');
const { CallObservabilityPayloadStore } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const { PayloadQuotaPrimitives } = require('../src/modules/call-observability/call-observability-payload-quota.ts');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-recovery-acceptance-tests');
const sqlEntities = [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity];

function withRoot(directory) {
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  try { return new CallObservabilityPayloadStore(); }
  finally {
    if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  }
}
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  let db = await new DataSource({ type: 'sqljs', synchronize: true, entities: sqlEntities }).initialize();
  let payloads = withRoot(directory);
  let store = new CallObservabilityStore(db, payloads);
  await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'isolated-c2c3-baseline', committedBytes: 0 }));
  const f = {
    directory, quota, epoch: initial.epoch,
    get db() { return db; }, get store() { return store; }, get payloads() { return payloads; },
    async status() { return store.readSnapshot(tx => quota.status(tx)); },
    async intent() { return db.getRepository(entities.RuntimePayloadPublicationIntentEntity).findOne({ where: {} }); },
    async reservation() { return db.getRepository(entities.RuntimePayloadQuotaReservationEntity).findOne({ where: {} }); },
    async restart() {
      const database = db.driver.export();
      await payloads.onModuleDestroy(); await db.destroy();
      db = await new DataSource({ type: 'sqljs', database, synchronize: false, entities: sqlEntities }).initialize();
      payloads = withRoot(directory);
      store = new CallObservabilityStore(db, payloads);
      await store.ensurePayloadStorage();
      assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
    },
  };
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  assert.equal((await f.status()).quotaEnforced, false);
  return f;
}
function record(data = '1234567890') {
  const invocationId = randomUUID(), bytes = Buffer.byteLength(data);
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(), traceId: invocationId,
    rootInvocationId: invocationId, runtimeAssetId: randomUUID(), kind: 'admission', spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external', identitySource: 'anonymous',
    outcome: 'success', statusCode: 200, startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8', observedBytes: bytes,
      capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' },
    response: { state: 'unavailable', reason: 'not_captured' } };
}
async function withQuota(t, run) {
  const previous = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
  process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
    else process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED = previous;
  });
  return run();
}
const { PayloadPublicationCorrelationService } = require('../src/modules/call-observability/call-observability-payload-publication-correlation.ts');
const { PayloadPublicationFileProofService } = require('../src/modules/call-observability/call-observability-payload-publication-file-proof.ts');
const { PayloadPublicationReconcileService } = require('../src/modules/call-observability/call-observability-payload-publication-reconcile.ts');

// Inject deferred settlement at its actual boundary. No ledger, intent, receipt,
// revision or payload rows are manufactured by this acceptance suite.
async function deferSettlement(run) {
  const settle = PayloadQuotaPrimitives.prototype.settle;
  PayloadQuotaPrimitives.prototype.settle = function (tx, epoch, operation, outcome) {
    return settle.call(this, tx, epoch, operation,
      outcome.reason === 'confirmed_occupancy_and_unused_absent' ? { reason: 'unknown' } : outcome);
  };
  try { return await run(); } finally { PayloadQuotaPrimitives.prototype.settle = settle; }
}
function recovery(f) { return new PayloadPublicationReconcileService(f.store, f.payloads); }
async function counters(f, reserved, committed) {
  const status = await f.status();
  assert.equal(status.reservedBytes, reserved);
  assert.equal(status.committedBytes, committed);
  assert.equal(status.quotaEnforced, false);
  let physicalBytes = 0;
  async function measure(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await measure(file);
      else if (entry.isFile() && /\.(body|tmp)$/.test(entry.name)) physicalBytes += (await fs.stat(file)).size;
    }
  }
  await measure(path.join(f.directory, 'payloads'));
  assert.ok(reserved + committed >= physicalBytes,
    `accounted ${reserved + committed} must cover physical path bytes ${physicalBytes}`);
}
async function counts(f, receipts, payloads) {
  assert.equal(await f.db.getRepository(entities.RuntimeIngestReceiptEntity).count(), receipts);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadEntity).count(), payloads);
}
async function contents(f, intent, temp = false) {
  return fs.readFile(path.join(f.directory, 'payloads', temp ? intent.temporaryKey : intent.fileKey), 'utf8');
}

test('real ingest deferred settlement survives closed-DB reopen and complete recovery settles once', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await deferSettlement(() => f.store.ingest(event));
  const intent = await f.intent();
  assert.equal((await f.reservation()).state, 'uncertain');
  await counters(f, 20, 0); await counts(f, 1, 2);
  await f.restart();
  assert.equal((await new PayloadPublicationCorrelationService(f.store, f.payloads).inspect(intent.reservationId)).status,
    'linked_unverified');
  assert.equal((await new PayloadPublicationFileProofService(f.store, f.payloads).inspect(intent.reservationId)).status,
    'file_proof_uncommitted');
  await counters(f, 20, 0); // Read-only proofs release nothing.
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'settled');
  await counters(f, 0, 10);
  await f.restart();
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
  await f.store.ingest(event);
  await counters(f, 0, 10); await counts(f, 1, 2);
  assert.equal(await contents(f, intent), event.request.data);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 1);
}));

test('external metadata transaction rollback retains settled file charge and replay restores metadata after reopen', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await assert.rejects(f.store.ingest(event, {}, async () => { throw new Error('external-metadata-failure'); }),
    /external-metadata-failure/);
  const intent = await f.intent();
  await counters(f, 0, 10); await counts(f, 0, 0);
  assert.equal(await contents(f, intent), event.request.data);
  await f.restart();
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
  await counters(f, 0, 10);
  await f.store.ingest(event);
  await counts(f, 1, 2); await counters(f, 0, 10);
  await f.restart(); await f.store.ingest(event);
  await counts(f, 1, 2); await counters(f, 0, 10);
}));

test('deferred settlement plus external metadata rollback cannot invent missing evidence after reopen', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await assert.rejects(deferSettlement(() => f.store.ingest(event, {}, async () => {
    throw new Error('external-metadata-failure');
  })), /external-metadata-failure/);
  const intent = await f.intent();
  await counters(f, 20, 0); await counts(f, 0, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.restart();
    const result = await recovery(f).reconcile(intent.reservationId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'receipt_missing_or_invalid');
    await counters(f, 20, 0); await counts(f, 0, 0);
    assert.equal(await contents(f, intent), event.request.data);
  }
  // Source replay may record an omitted body, but cannot authorize releasing
  // the uncertain physical object whose original metadata did not commit.
  await f.store.ingest(event);
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
  await counters(f, 20, 0);
}));

test('real final plus failed temp cleanup remains fully charged across reopen and repeated recovery', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record(), unlink = fs.unlink;
  fs.unlink = async file => {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('temp-cleanup-failure'), { code: 'EACCES' });
    return unlink(file);
  };
  try { await f.store.ingest(event); } finally { fs.unlink = unlink; }
  const intent = await f.intent();
  assert.equal(await contents(f, intent), event.request.data);
  assert.equal(await contents(f, intent, true), event.request.data);
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.restart();
    assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
    await f.store.ingest(event);
    await counters(f, 20, 0);
    assert.equal(await contents(f, intent), event.request.data);
    assert.equal(await contents(f, intent, true), event.request.data);
  }
}));

test('residual temporary occupancy blocks a proven publication until test-owned cleanup and reopen', async t => withQuota(t, async () => {
  const f = await fixture(t), event = record();
  await deferSettlement(() => f.store.ingest(event));
  const intent = await f.intent();
  const temporary = path.join(f.directory, 'payloads', intent.temporaryKey);
  // Simulate a residual filesystem entry after publication. This is explicit
  // filesystem fault injection; the database evidence stays untouched.
  await fs.writeFile(temporary, event.request.data, { flag: 'wx' });
  await f.restart();
  const result = await recovery(f).reconcile(intent.reservationId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'temporary_present');
  await counters(f, 20, 0);
  assert.equal(await contents(f, intent), event.request.data);
  assert.equal(await contents(f, intent, true), event.request.data);
  await f.restart();
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
  await counters(f, 20, 0);
  // Test-owned repair of the known temporary fixture, not automatic recovery GC.
  await fs.unlink(temporary);
  await f.restart();
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'settled');
  await counters(f, 0, 10);
  await f.restart();
  assert.equal((await recovery(f).reconcile(intent.reservationId)).status, 'blocked');
  await counters(f, 0, 10);
}));
