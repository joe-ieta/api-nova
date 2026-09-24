'use strict';
// Dedicated disposable PostgreSQL fixture only. Never inherits application DB settings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(root, '../../.tmp');
const binary = process.env.API_NOVA_TEST_PG_BIN;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key)));
let directory, data, started = false, timedOut = false;
const phase = (stage, event, extra = {}) => console.log(JSON.stringify({ marker: 'HOST_REGISTRY_PHASE', stage, event, ...extra }));
const executable = name => binary ? path.join(binary, name + (process.platform === 'win32' ? '.exe' : '')) : name;
function command(file, args, environment = env, timeoutMs = 60000, stage = 'command', pgProcess = false) {
  const since = Date.now(); phase(stage, 'start', { timeoutMs });
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const capture = chunk => { output = (output + chunk).slice(-64000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; phase(stage, 'timeout', { elapsedMs: Date.now() - since }); child.kill(); reject(new Error('isolated fixture timeout: ' + stage)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); phase(stage, 'spawn-error', { code: error.code }); reject(error); });
    // PG commands are bounded by process exit, not inherited descendant pipe handles.
    child.once(pgProcess ? 'exit' : 'close', code => { clearTimeout(timer); phase(stage, 'exit', { code, elapsedMs: Date.now() - since }); code === 0 ? resolve(output) : reject(Object.assign(new Error('isolated fixture command failed (' + code + '): ' + output), { code })); });
  });
}
const pg = async (name, args) => {
  const stage = name === 'initdb' ? (args.includes('--version') ? 'initdb-version' : 'initdb-create') : 'pg_ctl-' + args[args.length - 1];
  if (name === 'pg_ctl') {
    const canonical = await fs.realpath(data), owned = await fs.realpath(directory);
    assert.equal(path.dirname(canonical), owned); assert.equal(path.basename(canonical), 'pgdata');
    assert.equal(path.dirname(owned), await fs.realpath(scratch)); assert.ok(path.basename(owned).startsWith('pg-host-registry-'));
    args = args.map(value => value === data ? canonical : value);
  }
  return command(executable(name), args, env, stage === 'initdb-create' ? 180000 : stage === 'pg_ctl-status' ? 15000 : 60000, stage, true);
};
async function stop() { if (started) { await pg('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); started = false; } }
async function main() {
  await fs.access(path.join(root, 'dist/src/modules/gateway-runtime/services/gateway-host-credential-registry.js'));
  await pg('initdb', ['--version']); await fs.mkdir(scratch, { recursive: true });
  directory = await fs.mkdtemp(path.join(scratch, 'pg-host-registry-')); data = path.join(directory, 'pgdata');
  const listener = net.createServer(); await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); assert.notEqual(port, 5432);
  let reports;
  try {
    await pg('initdb', ['-D', data, '-U', 'host_registry_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 30\nfsync = on\nsynchronous_commit = on\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all host_registry_fixture 127.0.0.1/32 trust\nlocal all host_registry_fixture trust\n');
    const workerEnv = { ...env, NODE_ENV: 'test', DB_TYPE: 'postgres', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USERNAME: 'host_registry_fixture', DB_PASSWORD: '', DB_DATABASE: 'postgres', DB_SSL: 'false', DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false',
      API_NOVA_ISOLATED_PG_DATA: await fs.realpath(data), API_NOVA_ISOLATED_HOST_REGISTRY: randomBytes(24).toString('hex'),
      JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex') };
    const run = async mode => {
      let output = await command(process.execPath, ['scripts/test-postgres-host-credential-registry.cjs', mode], workerEnv, 180000, 'worker-' + mode);
      for (const secret of [workerEnv.JWT_SECRET, workerEnv.JWT_REFRESH_SECRET]) output = output.split(secret).join('[REDACTED]');
      const line = output.split(/\r?\n/).find(value => value.startsWith('{"marker":"POSTGRES_HOST_REGISTRY_OK"'));
      assert.ok(line, 'worker did not finish acceptance'); return JSON.parse(line);
    };
    await pg('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    const warm = await run('warm'); await stop();
    await pg('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    reports = [warm, await run('cold')];
  } finally {
    // A failed start can still have created a running server. Stop by this exact owned data dir.
    if (!started && await fs.stat(data).then(() => true, () => false)) { try { await pg('pg_ctl', ['-D', data, 'status']); started = true; } catch (error) { if (error.code !== 3 && error.code !== 4) throw error; } }
    await stop();
    const absolute = path.resolve(directory), canonical = await fs.realpath(directory), canonicalScratch = await fs.realpath(scratch);
    assert.equal(path.dirname(absolute), scratch); assert.equal(path.dirname(canonical), canonicalScratch);
    assert.ok(path.basename(canonical).startsWith('pg-host-registry-')); assert.equal(started, false);
    if (timedOut) phase('cleanup', 'preserved-after-timeout');
    else { await fs.rm(canonical, { recursive: true, force: true }); phase('cleanup', 'removed'); }
  }
  console.log(JSON.stringify({ marker: 'ISOLATED_POSTGRES_HOST_REGISTRY_OK', reports, restarted: true, clusterStopped: true, clusterRemoved: true, noProductionActivation: true }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
