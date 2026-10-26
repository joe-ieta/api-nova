'use strict';
// SEC-F1-02F: disposable PostgreSQL acceptance for F1 publication/guard persistence,
// reopen and the concurrent single-winner revision claim. Requires a built API and
// local PostgreSQL binaries. Never opens a configured database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const packageRoot = path.resolve(__dirname, '..');
const scratchRoot = process.env.F1_02F_TEMP || path.join(path.parse(packageRoot).root, 'temp', 'opencode', 'f1-02f');
const binaryRoot = process.env.API_NOVA_TEST_PG_BIN;
const executable = name => binaryRoot
  ? path.join(binaryRoot, name + (process.platform === 'win32' ? '.exe' : '')) : name;
// Preserve OS execution essentials, not application/PG configuration or secrets.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key)));
let directory, data, started = false;
function pg(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable(name), args, { env: environment, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(Object.assign(new Error(name + ' exited ' + code), { code }));
    });
  });
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function smoke(port) {
  const env = { ...environment, NODE_ENV: 'test', DB_TYPE: 'postgres', DB_HOST: '127.0.0.1',
    DB_PORT: String(port), DB_USERNAME: 'f1_02f_fixture', DB_PASSWORD: '', DB_DATABASE: 'postgres',
    DB_ADMIN_DATABASE: 'postgres', DB_SSL: 'false', DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false',
    API_NOVA_ISOLATED_F1_02F: 'true',
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    API_NOVA_AUDIT_DIR: path.join(directory, 'audit'),
    API_NOVA_OBSERVABILITY_DATA_DIR: path.join(directory, 'observability'),
    LOG_DIRECTORY: path.join(directory, 'logs'), PID_DIRECTORY: path.join(directory, 'pids') };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/test-f1-02f-postgres.cjs'], {
      cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-64000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('close', code => {
      for (const secret of [env.JWT_SECRET, env.JWT_REFRESH_SECRET]) output = output.split(secret).join('[REDACTED]');
      if (code !== 0) return reject(new Error('Isolated F1-02F database acceptance failed (' + code + '):\n' + output));
      try {
        const line = output.split(/\r?\n/).find(line => line.startsWith('{"marker":"POSTGRES_F1_02F_OK"'));
        assert.ok(line, 'Missing complete F1-02F acceptance report');
        const report = JSON.parse(line);
        assert.equal(report.dialect, 'postgres');
        assert.equal(report.reopen, true);
        assert.equal(report.schemaDrift, 0);
        assert.equal(report.revocations, true);
        assert.equal(report.gatewayPublication, true);
        assert.equal(report.mcpPublication, true);
        assert.equal(report.zeroWritesAfterReject, true);
        assert.equal(report.concurrency.winners, 1);
        assert.equal(report.concurrency.losers, 1);
        assert.equal(report.concurrency.revision, 2);
        resolve(report);
      } catch (error) { reject(error); }
    });
  });
}
async function stop() {
  if (!data) return;
  if (!started) {
    try { await pg('pg_ctl', ['-D', data, 'status']); started = true; }
    catch (error) { if (error.code === 3 || error.code === 4) return; throw error; }
  }
  await pg('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']);
  started = false;
}
async function main() {
  await fs.access(path.join(packageRoot, 'dist/src/main.js'));
  await pg('initdb', ['--version']);
  await fs.mkdir(scratchRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(scratchRoot, 'pg-f1-02f-'));
  data = path.join(directory, 'pgdata');
  let report;
  try {
    await pg('initdb', ['-D', data, '-U', 'f1_02f_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await freePort();
    await fs.appendFile(path.join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 24\nfsync = on\nsynchronous_commit = on\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'),
      'host all f1_02f_fixture 127.0.0.1/32 trust\nlocal all f1_02f_fixture trust\n');
    await pg('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']);
    started = true;
    report = await smoke(port);
  } finally {
    await stop();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), scratchRoot);
    assert.ok(path.basename(target).startsWith('pg-f1-02f-'));
    assert.equal(started, false, 'Refusing to delete a running cluster');
    await fs.rm(target, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...report,
    marker: 'ISOLATED_POSTGRES_F1_02F_OK', clusterStopped: true, clusterRemoved: true,
    scope: 'f1-publication-guard-reopen-revocation-concurrent-single-winner' }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
