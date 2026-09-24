'use strict';
// Only run through the disposable-cluster wrapper, never a configured database.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { buildDatabaseOptions } = require('../dist/src/database/database-options');
const { GatewayHeaderHistoryLedgerEntity: Ledger } = require('../dist/src/database/entities/gateway-header-history-ledger.entity');
const { GatewayHeaderHistoryLedgerService: Service } = require('../dist/src/database/gateway-header-history-ledger.service');
async function main() {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_USERNAME, 'schema_fixture');
  const options = buildDatabaseOptions();
  let db = await new DataSource({ ...options, migrations: options.migrations.filter(path => !path.includes('GatewayHeaderHistoryLedger')) }).initialize();
  const namespace = 'gateway:pg-fixture', digest = 'a'.repeat(64);
  try {
    assert.equal((await db.runMigrations()).length, 5);
    await db.query(`INSERT INTO source_service_assets (id, "sourceKey") VALUES ('00000000-0000-0000-0000-000000000001','legacy')`);
    await db.destroy(); db = await new DataSource(options).initialize();
    assert.equal((await db.runMigrations()).length, 1);
    assert.equal(await db.getRepository(Ledger).count(), 0);
    let store = new Service(db).asStore(namespace, digest);
    let races = await Promise.all([store.commit(namespace, 0, ['X-Old']), store.commit(namespace, 0, ['X-Other'])]);
    assert.equal(races.filter(Boolean).length, 1);
    const initial = await store.load(namespace);
    races = await Promise.all([store.commit(namespace, 1, ['X-New']), store.commit(namespace, 1, ['X-Parallel'])]);
    assert.equal(races.filter(Boolean).length, 1);
    assert.equal(await store.commit(namespace, 2, []), true);
    const saved = await store.load(namespace); for (const name of initial.names) assert.ok(saved.names.includes(name));
    for (const patch of [{ sourceKind: 'unknown' }, { version: 9 }, { revision: 0 }]) await assert.rejects(db.getRepository(Ledger).update({ namespace }, patch));
    await assert.rejects(new Service(db).load(namespace, 'b'.repeat(64)));
    assert.deepEqual((await db.driver.createSchemaBuilder().log()).upQueries, []);
    await db.destroy(); db = await new DataSource(options).initialize();
    store = new Service(db).asStore(namespace, digest); assert.deepEqual(await store.load(namespace), saved);
    assert.equal((await db.query(`SELECT "sourceKey" FROM source_service_assets WHERE id='00000000-0000-0000-0000-000000000001'`))[0].sourceKey, 'legacy');
    await db.undoLastMigration(); assert.equal((await db.runMigrations()).length, 1);
    assert.equal(await db.getRepository(Ledger).count(), 0);
    assert.deepEqual((await db.driver.createSchemaBuilder().log()).upQueries, []);
    console.log(JSON.stringify({ marker: 'POSTGRES_HEADER_HISTORY_LEDGER_OK', dialect: 'postgres', concurrentCas: true, reopen: true, checks: true, oldMigration: true, zeroDrift: true, noActivation: true }));
  } finally { if (db.isInitialized) await db.destroy(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
