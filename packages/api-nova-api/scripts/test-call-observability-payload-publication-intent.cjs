'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const load = name => require('../src/' + name + '.ts');
const entities = load('database/entities/runtime-call-observability.entity');
const { DATABASE_ENTITIES } = load('database/database.entities');
const { InitialSqliteSchema1788825600000: Initial } = load('database/migrations/1788825600000-InitialSqliteSchema');
const { PayloadPublicationIntentSqlite1790000000000: Forward } =
  load('database/migrations/1790000000000-PayloadPublicationIntentSqlite');
const { CallObservabilityStore } = load('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = load('modules/call-observability/call-observability-payload.store');
const { PayloadQuotaPrimitives } = load('modules/call-observability/call-observability-payload-quota');
const { PayloadPublicationIntentStore } = load('modules/call-observability/call-observability-payload-publication-intent');
const { canonicalJson, contentHash } = load('modules/call-observability/call-observability-storage');
const parent = path.resolve(__dirname, '../../../tmp/observability-publication-intent-tests');
const code = expected => error => error.code === expected;
const { McpInboundAuthModeSqlite1790000002000: InboundMode } = load('database/migrations/1790000002000-McpInboundAuthModeSqlite');
const migrations = [Initial, Forward, InboundMode];

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloads = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: DATABASE_ENTITIES }).initialize();
  const store = new CallObservabilityStore(db, payloads);
  const ownerId = await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await store.transaction(tx => quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500 }));
  await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'isolated-test-baseline', committedBytes: 0 }));
  const intent = new PayloadPublicationIntentStore();
  const input = { sourceInstanceId: 'source', sourceEventId: 'event', payloadId: 'a'.repeat(64),
    generation: '0', fileKey: 'aa/' + 'a'.repeat(64) + '.body',
    digest: 'b'.repeat(64), storedBytes: 50 };
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  return { db, store, payloads, quota, intent, input, initial, ownerId, directory };
}

test('new reserve and immutable intent commit together before any publication hook is wired', async t => {
  const f = await fixture(t);
  const result = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  assert.equal(result.replayed, false);
  assert.equal(result.reservationState, 'reserved');
  assert.match(result.temporaryKey, /^aa\/[a-f0-9]{64}\.body\.[a-f0-9-]{36}\.tmp$/);
  const row = await f.store.readSnapshot(tx => f.intent.load(tx, result.reservationId));
  assert.equal(row.payloadId, f.input.payloadId);
  assert.equal(row.temporaryKey, result.temporaryKey);
  assert.equal(row.storedBytes, '50');
  assert.equal(row.ownerId, f.ownerId);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).reservedBytes, '100');
});

test('caller transaction failure rolls back both reservation and intent with no budget leak', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.transaction(async tx => {
    await f.intent.reserve(tx, f.initial.epoch, f.input);
    throw new Error('injected-after-intent');
  }), /injected-after-intent/);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 0);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).reservedBytes, '0');
});

test('legacy reservation without intent remains unknown and cannot be backfilled on replay', async t => {
  const f = await fixture(t);
  const operationId = 'publish:' + contentHash(canonicalJson([
    f.input.sourceInstanceId, f.input.sourceEventId, f.input.payloadId, '0',
  ]));
  await f.store.transaction(tx => f.quota.reserve(tx, f.initial.epoch, operationId, 100));
  await assert.rejects(f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input)),
    code('PAYLOAD_PUBLICATION_INTENT_MISSING_OR_CONFLICT'));
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
    .findOneByOrFail({ operationId })).state, 'reserved');
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).reservedBytes, '100');
});

test('pending replay preserves the original temporary path and never inserts a second intent', async t => {
  const f = await fixture(t);
  const first = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  const replay = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservationState, 'reserved');
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(replay.temporaryKey, first.temporaryKey);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 1);
  assert.equal((await f.store.readSnapshot(tx => f.intent.load(tx, first.reservationId))).temporaryKey,
    first.temporaryKey);
});

test('uncertain replay returns the same path without releasing held quota', async t => {
  const f = await fixture(t);
  const first = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  await f.store.transaction(tx => f.quota.settle(tx, f.initial.epoch, first.operationId,
    { reason: 'unknown' }));
  const replay = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservationState, 'uncertain');
  assert.equal(replay.temporaryKey, first.temporaryKey);
  assert.equal(await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 1);
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).reservedBytes, '100');
});
test('scope or stored digest corruption fails closed during load and does not change quota', async t => {
  const f = await fixture(t);
  const first = await f.store.transaction(tx => f.intent.reserve(tx, f.initial.epoch, f.input));
  await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity)
    .update({ reservationId: first.reservationId }, { digest: 'c'.repeat(64) });
  await assert.rejects(f.store.readSnapshot(tx => f.intent.load(tx, first.reservationId)),
    code('INVALID_PAYLOAD_PUBLICATION_INTENT'));
  assert.equal((await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity)
    .findOneByOrFail({ ownerId: f.ownerId })).reservedBytes, '100');
});

test('existing SQLite database applies only forward migration and never backfills an old reservation', async t => {
  const old = await new DataSource({ type: 'sqljs', entities: DATABASE_ENTITIES,
    migrations: [Initial], synchronize: false }).initialize();
  await old.runMigrations({ transaction: 'all' });
  const legacyId = 'f'.repeat(64);
  await old.getRepository(entities.RuntimePayloadQuotaReservationEntity).insert({
    id: legacyId, ownerId: 'd'.repeat(36), operationId: 'publish:' + 'e'.repeat(64),
    epoch: 'c'.repeat(36), generation: '0', requestHash: 'b'.repeat(64),
    reservedBytes: '100', committedBytes: null, state: 'uncertain',
    settlementHash: null, updatedAt: new Date().toISOString(),
  });
  const database = old.driver.export();
  await old.destroy();
  const upgraded = await new DataSource({ type: 'sqljs', database,
    entities: DATABASE_ENTITIES, migrations, synchronize: false }).initialize();
  t.after(() => upgraded.destroy());
  const applied = await upgraded.runMigrations({ transaction: 'all' });
  assert.equal(applied.length, 2);
  assert.equal(await upgraded.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
  assert.equal(await upgraded.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(), 1);
  assert.equal((await upgraded.driver.createSchemaBuilder().log()).upQueries.length, 0);
  const restarted = await new DataSource({ type: 'sqljs', database: upgraded.driver.export(),
    entities: DATABASE_ENTITIES, migrations, synchronize: false }).initialize();
  t.after(() => restarted.destroy());
  assert.equal((await restarted.runMigrations({ transaction: 'all' })).length, 0);
  assert.equal((await restarted.driver.createSchemaBuilder().log()).upQueries.length, 0);
  assert.equal(await restarted.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
});

test('fresh SQLite database runs all current migrations and has no schema drift', async t => {
  const db = await new DataSource({ type: 'sqljs', entities: DATABASE_ENTITIES,
    migrations, synchronize: false }).initialize();
  t.after(() => db.destroy());
  assert.equal((await db.runMigrations({ transaction: 'all' })).length, 3);
  assert.equal(await db.getRepository(entities.RuntimePayloadPublicationIntentEntity).count(), 0);
  assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
});

test('both dialect snapshots contain the forward table and historical Initial stays unchanged', () => {
  for (const [dialect, migrationName] of [
    ['sqlite', '1790000000000-PayloadPublicationIntentSqlite'],
    ['postgres', '1790000001000-PayloadPublicationIntentPostgres'],
  ]) {
    const schema = fsSync.readFileSync(path.resolve(__dirname, '../database/' + dialect + '-schema.sql'), 'utf8');
    const forward = fsSync.readFileSync(path.resolve(__dirname, '../src/database/migrations/' + migrationName + '.ts'), 'utf8');
    const initial = fsSync.readFileSync(path.resolve(__dirname, '../src/database/migrations/' +
      (dialect === 'sqlite' ? '1788825600000-InitialSqliteSchema' : '1788825601000-InitialPostgresSchema') + '.ts'), 'utf8');
    assert.match(schema, /CREATE TABLE "runtime_payload_publication_intents"/);
    assert.match(schema, /CREATE INDEX "IDX_obs_publication_intent_scope"/);
    assert.ok(forward.includes('CREATE TABLE "runtime_payload_publication_intents"'));
    assert.doesNotMatch(initial, /runtime_payload_publication_intents/);
  }
});