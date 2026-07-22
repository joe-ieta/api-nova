const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const environmentPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(environmentPath)) {
  for (const line of fs.readFileSync(environmentPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const databaseName = `api_nova_verify_${process.pid}_${Date.now()}`;
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

if (!/^api_nova_verify_[0-9]+_[0-9]+$/.test(databaseName)) {
  throw new Error('Refusing to use an unsafe isolated PostgreSQL database name');
}

const connection = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
};
const adminDatabase = process.env.DB_ADMIN_DATABASE || 'postgres';
const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;
let created = false;
let dataSource;

async function verifySchema() {
  const tableRows = await dataSource.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const tableNames = tableRows.map(row => row.table_name);
  const domainTables = tableNames.filter(name => name !== 'migrations');
  const missingTables = requiredTables.filter(name => !tableNames.includes(name));
  const nonEmptyTables = [];
  for (const tableName of domainTables) {
    const count = Number((await dataSource.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
    ))[0].count);
    if (count !== 0) nonEmptyTables.push({ tableName, count });
  }
  const sourceColumns = await dataSource.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'source_service_assets'`,
  );
  const sourceColumnNames = sourceColumns.map(row => row.column_name);
  const presentForbiddenColumns = forbiddenSourceAssetColumns.filter(name =>
    sourceColumnNames.includes(name),
  );
  const instanceFkType = await dataSource.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'source_service_instances'
       AND column_name = 'sourceServiceAssetId'`,
  );
  const hasPendingMigrations = await dataSource.showMigrations();
  const result = {
    database: databaseName,
    domainTableCount: domainTables.length,
    migrationTablePresent: tableNames.includes('migrations'),
    missingTables,
    nonEmptyTables,
    presentForbiddenColumns,
    sourceServiceInstanceAssetIdType: instanceFkType[0]?.data_type,
    hasPendingMigrations,
  };
  console.log(JSON.stringify(result));
  if (
    domainTables.length !== expectedDomainTableCount ||
    !result.migrationTablePresent ||
    missingTables.length ||
    nonEmptyTables.length ||
    presentForbiddenColumns.length ||
    result.sourceServiceInstanceAssetIdType !== 'uuid' ||
    hasPendingMigrations
  ) {
    throw new Error('Isolated PostgreSQL baseline verification failed');
  }
}

async function main() {
  const admin = new Client({ ...connection, database: adminDatabase });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
  } finally {
    await admin.end();
  }

  process.env.DB_TYPE = 'postgres';
  process.env.DB_DATABASE = databaseName;
  process.env.DB_SYNCHRONIZE = 'false';
  process.env.NODE_ENV = 'test';
  ({ AppDataSource: dataSource } = require('../dist/src/database/data-source.js'));
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'all' });
  await verifySchema();
}

async function cleanup() {
  if (dataSource?.isInitialized) await dataSource.destroy();
  if (!created) return;
  const admin = new Client({ ...connection, database: adminDatabase });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    console.log(JSON.stringify({ cleanedDatabase: databaseName }));
  } finally {
    await admin.end();
  }
}

main()
  .catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => cleanup().catch(error => {
    console.error(`PostgreSQL cleanup failed: ${error.message || error}`);
    process.exitCode = 1;
  }));
