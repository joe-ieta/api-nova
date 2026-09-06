const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const databasePath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  process.env.DB_SQLITE_PATH || 'data/api-nova.db',
);

const requiredTables = [
  'config_overrides',
  'config_backups',
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

async function main() {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`SQLite database does not exist: ${databasePath}`);
  }

  const SQL = await initSqlJs();
  const database = new SQL.Database(fs.readFileSync(databasePath));
  const tableResult = database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tableNames = (tableResult[0]?.values || []).map(([name]) => String(name));
  const missingTables = requiredTables.filter((name) => !tableNames.includes(name));
  const counts = {};

  for (const tableName of requiredTables) {
    if (!missingTables.includes(tableName)) {
      counts[tableName] = Number(
        database.exec(`SELECT COUNT(*) FROM "${tableName}"`)[0].values[0][0],
      );
    }
  }

  const nonEmptyTables = Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([name]) => name);
  const sourceAssetColumns = database
    .exec('PRAGMA table_info("source_service_assets")')[0]
    .values.map((row) => String(row[1]));
  const presentForbiddenColumns = forbiddenSourceAssetColumns.filter((name) =>
    sourceAssetColumns.includes(name),
  );

  console.log(
    JSON.stringify({
      databasePath,
      tableCount: tableNames.length,
      missingTables,
      counts,
      presentForbiddenColumns,
    }),
  );

  if (
    missingTables.length > 0 ||
    nonEmptyTables.length > 0 ||
    presentForbiddenColumns.length > 0
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
