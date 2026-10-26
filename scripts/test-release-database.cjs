'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sqljs = require('sql.js');

test('release initialization supports forward migrations and rejects unknown ledgers', async t => {
  const parent = path.join(root, '.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'release-database-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'packages'));
  fs.symlinkSync(path.join(root, 'packages/api-nova-api'), path.join(directory, 'packages/api-nova-api'), 'junction');
  fs.copyFileSync(path.join(__dirname, 'initialize-release-database.cjs'), path.join(directory, 'initialize.cjs'));
  fs.writeFileSync(path.join(directory, '.env'), '');
  const databasePath = path.join(directory, 'database.sqlite');
  const env = { ...process.env, NODE_ENV: 'test', DB_TYPE: 'sqlite',
    DB_SQLITE_PATH: databasePath, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false',
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    API_NOVA_ENV_FILE: path.join(directory, '.env') };
  const run = args => spawnSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const initialize = () => run(['initialize.cjs']);
  const success = result => assert.equal(result.status, 0, result.stderr + result.stdout);
  const SQL = await sqljs();
  const edit = sql => {
    const db = new SQL.Database(fs.readFileSync(databasePath));
    try { db.run(sql); fs.writeFileSync(databasePath, db.export()); }
    finally { db.close(); }
  };
  const read = sql => {
    const db = new SQL.Database(fs.readFileSync(databasePath));
    try { return db.exec(sql); } finally { db.close(); }
  };
  await t.test('fresh database and repeated startup apply all migrations once', () => {
    success(initialize());
    const rows = read('SELECT name FROM migrations ORDER BY id');
    assert.ok(rows[0].values.length > 1);
    success(initialize());
    assert.deepEqual(read('SELECT name FROM migrations ORDER BY id'), rows);
  });
  await t.test('known initial migration advances to the current schema', () => {
    fs.unlinkSync(databasePath);
    const source = "(async()=>{await require('./packages/api-nova-api/dist/src/config/environment.js').applicationConfigModule;const {DataSource}=require(" + JSON.stringify(require.resolve('typeorm')) + ");const options=require('./packages/api-nova-api/dist/src/database/database-options.js').buildDatabaseOptions();const db=await new DataSource({...options,migrations:options.migrations.slice(0,1)}).initialize();try{await db.runMigrations();}finally{await db.destroy();}})().catch(e=>{console.error(e);process.exitCode=1})";
    success(run(['-e', source]));
    assert.equal(read('SELECT name FROM migrations')[0].values.length, 1);
    success(initialize());
    assert.ok(read('SELECT name FROM migrations')[0].values.length > 1);
  });
  await t.test('unknown or discontinuous ledger is rejected without applying migrations', () => {
    const original = fs.readFileSync(databasePath);
    for (const sql of ["UPDATE migrations SET name='UnknownMigration1999999999999' WHERE id=1", 'DELETE FROM migrations WHERE id=1']) {
      fs.writeFileSync(databasePath, original);
      edit(sql);
      const before = read('SELECT * FROM migrations ORDER BY id');
      const result = initialize();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Historical database schemas are unsupported/);
      assert.deepEqual(read('SELECT * FROM migrations ORDER BY id'), before);
    }
    fs.writeFileSync(databasePath, original);
  });
  await t.test('existing schema without migration ledger is rejected', () => {
    edit('DROP TABLE migrations');
    const result = initialize();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Existing schema has no current migration ledger/);
  });
});
