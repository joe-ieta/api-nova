const { Client } = require('pg');

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

async function main() {
  if (process.env.DB_TYPE !== 'postgres') {
    throw new Error('DB_TYPE=postgres is required for PostgreSQL baseline verification');
  }
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const tableRows = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tableNames = tableRows.rows.map((row) => row.table_name);
    const domainTables = tableNames.filter((name) => name !== 'migrations');
    const missingTables = requiredTables.filter((name) => !tableNames.includes(name));
    const nonEmptyTables = [];
    for (const tableName of domainTables) {
      const quoted = `"${tableName.replace(/"/g, '""')}"`;
      const count = Number((await client.query(`SELECT COUNT(*) AS count FROM ${quoted}`)).rows[0].count);
      if (count !== 0) nonEmptyTables.push({ tableName, count });
    }
    const sourceColumns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'source_service_assets'`,
    );
    const sourceColumnNames = sourceColumns.rows.map((row) => row.column_name);
    const presentForbiddenColumns = forbiddenSourceAssetColumns.filter((name) =>
      sourceColumnNames.includes(name),
    );
    const instanceFkType = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'source_service_instances'
         AND column_name = 'sourceServiceAssetId'`,
    );
    const result = {
      database: process.env.DB_DATABASE,
      domainTableCount: domainTables.length,
      migrationTablePresent: tableNames.includes('migrations'),
      missingTables,
      nonEmptyTables,
      presentForbiddenColumns,
      sourceServiceInstanceAssetIdType: instanceFkType.rows[0]?.data_type,
    };
    console.log(JSON.stringify(result));
    if (
      domainTables.length !== 38 ||
      missingTables.length ||
      nonEmptyTables.length ||
      presentForbiddenColumns.length ||
      result.sourceServiceInstanceAssetIdType !== 'uuid'
    ) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
