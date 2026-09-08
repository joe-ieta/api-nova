const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const [command, dialect, ...flags] = process.argv.slice(2);
if (!['generate', 'create', 'smoke'].includes(command) || !['sqlite', 'postgres'].includes(dialect) ||
    flags.some(flag => flag !== '--keep')) {
  throw new Error('Usage: database-tool.cjs <generate|create|smoke> <sqlite|postgres> [--keep]');
}
const keep = command === 'create' || flags.includes('--keep');
const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const stamp = process.pid + '_' + Date.now();
const databaseName = 'api_nova_verify_' + stamp;
const directory = path.join(workspaceRoot, 'tmp', 'database-cleanup-' + dialect + '-' + stamp);
const sqlitePath = path.join(directory, 'empty.sqlite');
if (path.dirname(directory) !== path.join(workspaceRoot, 'tmp') ||
    !/^api_nova_verify_[0-9]+_[0-9]+$/.test(databaseName)) throw new Error('Unsafe isolated database target');
fs.mkdirSync(path.dirname(directory), { recursive: true });
fs.mkdirSync(directory);
process.env.DB_TYPE = dialect;
process.env.DB_DATABASE = databaseName;
process.env.DB_SQLITE_PATH = sqlitePath;
process.env.DB_SYNCHRONIZE = 'false';

let options;
let dataSource;
let createdDatabase = false;
let child;
let childExited;
let complete = false;
const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function adminQuery(sql) {
  const { Client } = require('pg');
  const client = new Client({
    host: options.host, port: options.port, user: options.username, password: options.password,
    database: process.env.DB_ADMIN_DATABASE || 'postgres', ssl: options.ssl,
    connectionTimeoutMillis: 5000,
  });
  try { await client.connect(); return await client.query(sql); }
  finally { await client.end(); }
}

async function openDatabase(migrations = true) {
  const { DataSource } = require('typeorm');
  dataSource = new DataSource({ ...options, migrations: migrations ? options.migrations : [] });
  await dataSource.initialize();
}

function domainTables() {
  return [...new Set(dataSource.entityMetadatas.map(entity => entity.tableName))].sort();
}

async function verifyEmpty() {
  const rows = await dataSource.query(dialect === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const tables = rows.map(row => row.name).filter(name => name !== 'migrations').sort();
  assert.deepEqual(tables, domainTables(), 'Persisted schema must contain exactly the runtime entity tables');
  for (const table of tables) {
    const result = await dataSource.query('SELECT COUNT(*) AS count FROM ' + quote(table));
    assert.equal(Number(result[0].count), 0, table + ' must remain empty');
  }
  assert.equal(await dataSource.showMigrations(), false, 'Pending migrations');
  assert.equal((await dataSource.driver.createSchemaBuilder().log()).upQueries.length, 0, 'Schema drift');
  if (dialect === 'sqlite') {
    assert.deepEqual(await dataSource.query('PRAGMA foreign_key_check'), []);
    assert.equal((await dataSource.query('PRAGMA integrity_check'))[0].integrity_check, 'ok');
  }
  return tables.length;
}

async function generateSchema() {
  const log = await dataSource.driver.createSchemaBuilder().log();
  await dataSource.synchronize();
  let up = log.upQueries.map(query => query.query);
  let down = [...log.downQueries].reverse().map(query => query.query);
  if (dialect === 'sqlite') {
    const rows = await dataSource.query(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name");
    up = rows.map(row => row.sql);
    down = ['PRAGMA defer_foreign_keys = ON', ...rows.filter(row => row.type === 'table').reverse()
      .map(row => 'DROP TABLE ' + quote(row.name))];
  } else {
    up.unshift('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  }
  const label = dialect === 'sqlite' ? 'InitialSqliteSchema' : 'InitialPostgresSchema';
  const timestamp = dialect === 'sqlite' ? '1788825600000' : '1788825601000';
  const className = label + timestamp;
  const source = "import { MigrationInterface, QueryRunner } from 'typeorm';\n\n" +
    '// Initial-development schema. No historical data conversion is performed.\n' +
    'export class ' + className + ' implements MigrationInterface {\n' +
    '  name = ' + JSON.stringify(className) + ';\n' +
    '  async up(queryRunner: QueryRunner): Promise<void> {\n' +
    '    for (const sql of ' + JSON.stringify(up, null, 2) + ') await queryRunner.query(sql);\n  }\n' +
    '  async down(queryRunner: QueryRunner): Promise<void> {\n' +
    '    for (const sql of ' + JSON.stringify(down, null, 2) + ') await queryRunner.query(sql);\n  }\n}\n';
  const migrationPath = path.join(packageRoot, 'src', 'database', 'migrations', timestamp + '-' + label + '.ts');
  const schemaDirectory = path.join(packageRoot, 'database');
  fs.mkdirSync(schemaDirectory, { recursive: true });
  fs.writeFileSync(migrationPath, source);
  fs.writeFileSync(path.join(schemaDirectory, dialect + '-schema.sql'),
    '-- Initial empty schema, generated from the runtime entity registry.\nBEGIN;\n' +
    up.join(';\n') + ';\nCOMMIT;\n');
  return { migration: path.relative(workspaceRoot, migrationPath), domainTables: domainTables().length };
}

async function persistenceSmoke() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const source = runner.manager.getRepository('SourceServiceAssetEntity');
    const id = randomUUID();
    const value = source.create({ id, sourceKey: 'smoke:' + id, displayName: 'Persistence smoke',
      metadata: { nested: { enabled: true, count: 0 }, items: ['one', 'two'] } });
    await source.save(value);
    const loaded = await source.findOneByOrFail({ id });
    assert.deepEqual(loaded.metadata, value.metadata);
    await source.update({ id }, { displayName: 'Updated' });
    assert.equal((await source.findOneByOrFail({ id })).displayName, 'Updated');
    for (const value of [false, 0, 'text']) {
      const repository = runner.manager.getRepository('ConfigOverrideEntity');
      const record = await repository.save(repository.create({ envKey: 'SMOKE_' + typeof value,
        section: 'smoke', field: typeof value, valueType: typeof value, value, restartRequired: false }));
      assert.equal((await repository.findOneByOrFail({ id: record.id })).value, value);
    }
    const serverId = randomUUID();
    await runner.manager.getRepository('ProcessInfoEntity').save({ serverId, pid: 123, startTime: new Date() });
    await runner.manager.getRepository('ProcessLogEntity').save({ serverId, level: 'info',
      message: 'Smoke process log', metadata: { smoke: true } });
    await runner.manager.getRepository('HealthCheckResultEntity').save({ serverId, isHealthy: true, responseTime: 1 });
    await source.delete({ id });
    assert.equal(await source.countBy({ id }), 0);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
  assert.equal(await dataSource.getRepository('ProcessInfoEntity').count(), 0, 'Rollback must remove process data');
  const repository = dataSource.getRepository('SourceServiceAssetEntity');
  await assert.rejects(() => dataSource.transaction(async manager => {
    const source = manager.getRepository('SourceServiceAssetEntity');
    const sourceKey = 'duplicate:' + randomUUID();
    await source.save({ sourceKey });
    await source.save({ sourceKey });
  }));
  assert.equal(await repository.count(), 0, 'Constraint failures must roll back the transaction');
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopApi() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([childExited, sleep(5000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await childExited; }
  child = undefined;
}

async function apiSmoke() {
  await dataSource.destroy();
  const port = await availablePort();
  const mcpPort = await availablePort();
  let output = '';
  let processError;
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MCP_PORT: String(mcpPort),
    DB_LOGGING: 'false', LOG_DIRECTORY: path.join(directory, 'logs'), PID_DIRECTORY: path.join(directory, 'pids'),
    SUPER_ADMIN_USERNAME: 'smoke_admin', SUPER_ADMIN_EMAIL: 'smoke@example.invalid',
    SUPER_ADMIN_PASSWORD: 'Smoke1!' + randomBytes(18).toString('hex'),
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex') };
  delete env.API_NOVA_ENV_FILE;
  child = spawn(process.execPath, ['dist/src/main.js'], { cwd: packageRoot, env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  childExited = new Promise(resolve => child.once('exit', resolve));
  child.once('error', error => { processError = error; });
  const capture = chunk => { output = (output + chunk.toString()).slice(-20000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    const deadline = Date.now() + 45000;
    while (!output.includes('Nest application successfully started')) {
      if (processError) throw processError;
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('API failed to start: ' + output.slice(-6000));
      await sleep(200);
    }
    const response = await fetch('http://127.0.0.1:' + port + '/api/v1/config', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 401, 'Management configuration must reject anonymous access');
  } finally { await stopApi(); }
  await openDatabase();
  assert.ok(await dataSource.getRepository('User').count(), 'API startup must persist bootstrap users');
  // Only this invocation-created database is cleared; configured business databases are never opened.
  if (!createdDatabase && dialect === 'postgres') throw new Error('Refusing to clear an unowned database');
  const tables = domainTables();
  if (dialect === 'postgres') {
    await dataSource.query('TRUNCATE TABLE ' + tables.map(quote).join(', ') + ' RESTART IDENTITY CASCADE');
  } else {
    await dataSource.query('PRAGMA foreign_keys = OFF');
    try {
      await dataSource.transaction(async manager => {
        for (const table of tables) await manager.query('DELETE FROM ' + quote(table));
      });
    } finally { await dataSource.query('PRAGMA foreign_keys = ON'); }
  }
}

async function main() {
  await require('../dist/src/config/environment.js').applicationConfigModule;
  options = require('../dist/src/database/database-options.js').buildDatabaseOptions();
  if (dialect === 'postgres') {
    await adminQuery('CREATE DATABASE ' + quote(databaseName));
    createdDatabase = true;
  }
  await openDatabase(command !== 'generate');
  let result;
  if (command === 'generate') {
    result = await generateSchema();
  } else {
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    assert.equal(migrations.length, 1, 'Exactly one dialect-specific initial migration is required');
    const tableCount = await verifyEmpty();
    if (command === 'smoke') {
      await persistenceSmoke();
      await verifyEmpty();
      await apiSmoke();
      await verifyEmpty();
    }
    result = { domainTables: tableCount, empty: true, schemaDrift: 0,
      persistence: command === 'smoke', apiStartup: command === 'smoke',
      database: dialect === 'postgres' ? databaseName : sqlitePath };
  }
  const report = { marker: 'DATABASE_' + command.toUpperCase() + '_OK', dialect, ...result };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  complete = true;
}

async function cleanup() {
  await stopApi();
  if (dataSource?.isInitialized) await dataSource.destroy();
  if ((!keep || !complete) && createdDatabase) {
    await adminQuery('DROP DATABASE ' + quote(databaseName));
    createdDatabase = false;
  }
  if (!keep || !complete) fs.rmSync(directory, { recursive: true, force: true });
}

main().catch(error => {
  let message = String(error.stack || error);
  for (const [key, value] of Object.entries(process.env)) {
    if (/PASSWORD|SECRET|TOKEN|API_KEY/.test(key) && value) message = message.split(value).join('[REDACTED]');
  }
  console.error(message);
  process.exitCode = 1;
}).finally(() => cleanup().catch(error => {
  console.error('Isolated database cleanup failed: ' + error.message);
  process.exitCode = 1;
}));
