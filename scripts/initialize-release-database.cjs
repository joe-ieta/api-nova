'use strict';
const path = require('node:path');
process.env.API_NOVA_ENV_FILE = path.join(__dirname, '.env');
let database;

async function main() {
  await require('./packages/api-nova-api/dist/src/config/environment.js').applicationConfigModule;
  database = require('./packages/api-nova-api/dist/src/database/data-source.js').AppDataSource;
  await database.initialize();
  const expected = database.migrations.map(migration => migration.name || migration.constructor.name)
    .sort((a, b) => Number(a.slice(-13)) - Number(b.slice(-13)));
  if (!expected.length || !/^Initial(?:Sqlite|Postgres)Schema/.test(expected[0]) ||
      new Set(expected).size !== expected.length) throw new Error('Invalid release migration chain');
  const runner = database.createQueryRunner();
  try {
    const tables = await runner.getTables();
    const ledger = tables.find(table => table.name === 'migrations');
    const domain = tables.filter(table => table.name !== 'migrations');
    if (!ledger && domain.length) throw new Error('Existing schema has no current migration ledger; select a new empty database');
    const applied = ledger ? await database.query('SELECT name FROM migrations ORDER BY id') : [];
    if (applied.length > expected.length || applied.some((row, index) => row.name !== expected[index]) ||
        (applied.length === 0 && domain.length)) {
      throw new Error('Historical database schemas are unsupported; no data was converted');
    }
    await database.runMigrations({ transaction: 'all' });
    const drift = await database.driver.createSchemaBuilder().log();
    if (drift.upQueries.length) throw new Error('Database schema differs from this release; automatic repair is disabled');
    console.log('[ApiNova] Initial database schema is ready');
  } finally {
    await runner.release();
  }
}

main().catch(error => {
  let message = String(error.message || error);
  for (const [key, value] of Object.entries(process.env)) {
    if (/PASSWORD|SECRET|TOKEN|API_KEY/.test(key) && value) message = message.split(value).join('[REDACTED]');
  }
  console.error('[ApiNova] Database initialization failed: ' + message);
  process.exitCode = 1;
}).finally(async () => {
  if (database?.isInitialized) await database.destroy();
});
