'use strict';
const path = require('node:path');
process.env.API_NOVA_ENV_FILE = path.join(__dirname, '.env');
let database;

async function main() {
  await require('./packages/api-nova-api/dist/src/config/environment.js').applicationConfigModule;
  database = require('./packages/api-nova-api/dist/src/database/data-source.js').AppDataSource;
  await database.initialize();
  if (database.migrations.length !== 1) throw new Error('Exactly one initial migration is required');
  const expected = database.migrations[0].name || database.migrations[0].constructor.name;
  const runner = database.createQueryRunner();
  try {
    const tables = await runner.getTables();
    const ledger = tables.find(table => table.name === 'migrations');
    const domain = tables.filter(table => table.name !== 'migrations');
    if (!ledger && domain.length) throw new Error('Existing schema has no current migration ledger; select a new empty database');
    const applied = ledger ? await database.query('SELECT name FROM migrations') : [];
    if (applied.length > 1 || applied.some(row => row.name !== expected) ||
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
