const fs = require('node:fs');
const path = require('node:path');

const databaseName = `api-nova-verify-${process.pid}-${Date.now()}.sqlite`;
const databasePath = path.resolve(__dirname, '..', '..', '..', 'tmp', databaseName);
const safeRoot = path.resolve(__dirname, '..', '..', '..', 'tmp');
const expectedDomainTableCount = 38;
const requiredTables = [
  'source_service_instances',
  'endpoint_test_cases',
  'endpoint_test_runs',
  'endpoint_test_samples',
  'runtime_upstream_bindings',
  'runtime_upstream_binding_instances',
  'runtime_verification_runs',
  'runtime_verification_results',
  'gateway_route_snapshots',
];
const forbiddenSourceAssetColumns = ['scheme', 'host', 'port', 'normalizedBasePath'];
let dataSource;

if (path.dirname(databasePath) !== safeRoot || !/^api-nova-verify-[0-9]+-[0-9]+\.sqlite$/.test(databaseName)) {
  throw new Error('Refusing to use an unsafe isolated SQLite database path');
}
fs.mkdirSync(safeRoot, { recursive: true });
process.env.DB_TYPE = 'sqlite';
process.env.DB_SQLITE_PATH = databasePath;
process.env.DB_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
({ AppDataSource: dataSource } = require('../dist/src/database/data-source.js'));

async function main() {
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'all' });
  const tableRows = await dataSource.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tableNames = tableRows.map(row => row.name);
  const domainTables = tableNames.filter(name => name !== 'migrations');
  const missingTables = requiredTables.filter(name => !tableNames.includes(name));
  const nonEmptyTables = [];
  for (const tableName of domainTables) {
    const quoted = `"${String(tableName).replace(/"/g, '""')}"`;
    const count = Number((await dataSource.query(`SELECT COUNT(*) AS count FROM ${quoted}`))[0].count);
    if (count !== 0) nonEmptyTables.push({ tableName, count });
  }
  const sourceColumns = await dataSource.query('PRAGMA table_info("source_service_assets")');
  const sourceColumnNames = sourceColumns.map(row => row.name);
  const presentForbiddenColumns = forbiddenSourceAssetColumns.filter(name =>
    sourceColumnNames.includes(name),
  );
  const hasPendingMigrations = await dataSource.showMigrations();
  const result = {
    database: databaseName,
    domainTableCount: domainTables.length,
    migrationTablePresent: tableNames.includes('migrations'),
    missingTables,
    nonEmptyTables,
    presentForbiddenColumns,
    hasPendingMigrations,
  };
  console.log(JSON.stringify(result));
  if (
    domainTables.length !== expectedDomainTableCount ||
    !result.migrationTablePresent ||
    missingTables.length ||
    nonEmptyTables.length ||
    presentForbiddenColumns.length ||
    hasPendingMigrations
  ) {
    throw new Error('Isolated SQLite baseline verification failed');
  }
}

async function cleanup() {
  if (dataSource?.isInitialized) await dataSource.destroy();
  if (fs.existsSync(databasePath)) fs.rmSync(databasePath);
  console.log(JSON.stringify({ cleanedDatabase: databaseName }));
}

main()
  .catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => cleanup().catch(error => {
    console.error(`SQLite cleanup failed: ${error.message || error}`);
    process.exitCode = 1;
  }));
