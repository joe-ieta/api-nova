'use strict';
// SEC-C3-03: multi-process Registry version/generation coordination over real PostgreSQL.
// Starts a disposable cluster, forks two real API processes over the shared DB, and
// proves single-owner generations, fail-closed foreign actions, cross-process status
// projection (state/generation/Registry revision/approval/failure), monotonic
// generations across ownership changes, and rejection of stale generations/packages.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn, spawnSync, fork } = require('node:child_process');
const { createHash } = require('node:crypto');

const packageRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../api-nova-server');
const parserEntry = path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
const binaryRoot = process.env.API_NOVA_TEST_PG_BIN;
const executable = name => binaryRoot
  ? path.join(binaryRoot, name + (process.platform === 'win32' ? '.exe' : '')) : name;
// Preserve OS execution essentials, not application/PG configuration or secrets.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key)));

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const SERVER_ID = id(5);
const ASSET_ID = id(1);
const APPROVED_ENV_NAMES = ['API_NOVA_RUNTIME_AUTH_MODE', 'API_NOVA_MCP_RESOURCE', 'API_NOVA_RUNTIME_API_KEYS'];

let directory, data, assetsDir, registryPath, configPath, pgPort, mcpPort, started = false;
let commandCounter = 0;
const instances = [];
const checks = [];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(probe, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not observed in time');
    await delay(100);
  }
}

async function portUnreachable(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}

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

function buildManagedAssets() {
  const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    path.join(serverRoot, 'src/managed/entry.ts'), path.join(serverRoot, 'src/managed/handoff.ts'),
    '--outDir', assetsDir, '--module', 'commonjs', '--target', 'ES2020', '--types', 'node', '--skipLibCheck'], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  fsSync.writeFileSync(path.join(assetsDir, 'runtime.js'), `
require(${JSON.stringify(require.resolve('ts-node'))}).register({ transpileOnly: true, project: ${JSON.stringify(path.join(serverRoot, 'tsconfig.json'))} });
const Module = require('node:module'), original = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-parser') return ${JSON.stringify(parserEntry)};
  if (name === 'api-nova-server') return ${JSON.stringify(path.join(assetsDir, 'handoff.js'))};
  return original.call(this, name, ...rest);
};
module.exports = require(${JSON.stringify(path.join(serverRoot, 'src/managed/runtime.ts'))});
`);
}

function instanceEnvironment(mode) {
  return { ...environment, C3_MODE: mode, C3_ASSETS_DIR: assetsDir, C3_SERVER_ID: SERVER_ID, C3_ASSET_ID: ASSET_ID,
    C3_PORT: String(mcpPort), C3_REGISTRY_PATH: registryPath, C3_CONFIG_PATH: configPath,
    C3_SYNCHRONIZE: mode === 'seed' ? 'true' : 'false',
    DB_HOST: '127.0.0.1', DB_PORT: String(pgPort), DB_USERNAME: 'c3_fixture', DB_PASSWORD: '', DB_DATABASE: 'postgres' };
}

function startInstance(label, extraEnv = {}) {
  const child = fork(path.join(__dirname, 'verify-c3-03-instance.cjs'), [], { cwd: packageRoot, silent: true,
    env: { ...instanceEnvironment(extraEnv.C3_MODE || 'instance'), ...extraEnv } });
  const pending = new Map();
  const gates = [];
  let gateWaiter = null;
  let output = '';
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not become ready:\n${output}`)), 120000);
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') { clearTimeout(timer); resolve(message); return; }
      if (message.type === 'fatal') { clearTimeout(timer);
        reject(new Error(`${label} fatal: ${message.error.message}\n${message.error.stack}\n${output}`)); }
    });
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-64000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-64000); });
  child.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'gated') {
      if (gateWaiter) { const release = gateWaiter; gateWaiter = null; release(); } else gates.push(true);
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(Object.assign(new Error(`${label} ${message.error.message}`), { code: message.error.code, remoteName: message.error.name }));
  });
  const instance = {
    label, child, ready, exit,
    get output() { return output; },
    get exited() { return exited; },
    call(message, timeoutMs = 30000) {
      const commandId = ++commandCounter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(commandId); reject(new Error(`${label} timeout for ${message.type}`)); }, timeoutMs);
        pending.set(commandId, { resolve, reject, timer });
        child.send({ ...message, id: commandId });
      });
    },
    waitGate(timeoutMs = 60000) {
      if (gates.shift()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { gateWaiter = null; reject(new Error(`${label} gate timeout`)); }, timeoutMs);
        gateWaiter = () => { clearTimeout(timer); resolve(); };
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
  instances.push(instance);
  return instance;
}

function registryDocument(revision) {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } }, credentials: {},
    sites: [{ id: 'c3-03-fixture', sourceServiceAssetId: id(4), match: { scheme: 'https', host: 'c3-fixture.invalid', port: 443, basePath: '/' },
      allowedHosts: ['c3-fixture.invalid'], credential: 'none', endpoints: [{ endpointDefinitionId: id(3), credential: 'none' }] }],
  };
}

function writeRegistry(revision) {
  const text = JSON.stringify(registryDocument(revision));
  fsSync.writeFileSync(registryPath, text);
  const config = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
  config.sources[ASSET_ID].registrySource.expectedRevision = revision;
  config.sources[ASSET_ID].registrySource.expectedContentDigest = hash(text);
  fsSync.writeFileSync(configPath, JSON.stringify(config));
  return { revision, digest: hash(text) };
}

function initConfig() {
  const config = {
    sources: { [ASSET_ID]: { registrySource: { configId: 'c3-03-fixture', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: '0'.repeat(64) }, approvedEnvironmentNames: APPROVED_ENV_NAMES } },
    lifecycleApproval: { [ASSET_ID]: { version: 1, mode: 'auto', policyId: 'c3-03-runner',
      allowedActions: ['start', 'stop'], allowedServerIds: [SERVER_ID] } },
  };
  fsSync.writeFileSync(configPath, JSON.stringify(config));
}

async function step(name, probe) {
  const value = await probe();
  checks.push(name);
  console.log('  [ok] ' + name);
  return value;
}

async function runScenarios() {
  const seed = startInstance('seed', { C3_MODE: 'seed' });
  await seed.ready;
  await seed.call({ type: 'seed' }, 60000);
  await seed.call({ type: 'close' }, 30000);
  await Promise.race([seed.exit, delay(10000)]);

  const p1 = startInstance('p1');
  const p2 = startInstance('p2');
  await Promise.all([p1.ready, p2.ready]);

  // 1) Concurrent cross-process claim over the shared database: exactly one winner.
  await p1.call({ type: 'armGate' });
  await p2.call({ type: 'armGate' });
  const race = [p1.call({ type: 'start' }, 120000), p2.call({ type: 'start' }, 120000)];
  const settledPromise = Promise.allSettled(race);
  await Promise.all([p1.waitGate(), p2.waitGate()]);
  await Promise.all([p1.call({ type: 'releaseGate' }), p2.call({ type: 'releaseGate' })]);
  const settled = await settledPromise;
  const fulfilled = settled.map((result, index) => ({ result, index })).filter(entry => entry.result.status === 'fulfilled');
  const rejected = settled.map((result, index) => ({ result, index })).filter(entry => entry.result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one process must win the generation');
  assert.equal(rejected.length, 1, 'exactly one process must lose the generation');
  const winner = fulfilled[0].index === 0 ? p1 : p2;
  const loser = winner === p1 ? p2 : p1;
  const firstStart = fulfilled[0].result.value;
  const loserError = rejected[0].result.reason;
  const observedGenerations = [];
  await step('exactly one owner per generation under a concurrent two-process race', () => {
    assert.equal(loserError.code, 'MANAGED_LIFECYCLE_CONFLICT', `loser must fail closed on the CAS, got ${loserError.code}`);
    assert.equal(firstStart.generation, 1);
    assert.equal(firstStart.snapshot.registryRevision, 'r1');
    assert.equal(firstStart.decision.action, 'start');
    assert.equal(firstStart.decision.generation, 1);
    observedGenerations.push(firstStart.generation);
  });

  // 2) The loser mutated nothing; cross-process status exposes activation, generation,
  // Registry revision/digest, approval outcome, and no false current.
  const winnerStatus = await winner.call({ type: 'status' });
  const loserStatus = await loser.call({ type: 'status' });
  await step('loser fails closed without mutating state or spawning a child', () => {
    assert.equal(winnerStatus.owner, 1, 'winner owns generation 1');
    assert.equal(loserStatus.owner, null, 'loser owns no generation');
    assert.equal(winnerStatus.spawns, 1, 'winner attempted exactly one child');
    assert.equal(loserStatus.spawns, 0, 'loser spawned no child');
    assert.equal(loserStatus.status.view.generation, 1, 'generation unchanged by the loser');
    assert.equal(loserStatus.status.view.state, 'current');
  });
  await step('other process observes activation, generation, Registry identity and approval', () => {
    const view = loserStatus.status.view;
    assert.equal(view.current, false, 'foreign process must not claim ownership');
    assert.equal(view.currentVerified, true, 'record itself verifies current');
    assert.equal(view.snapshot.registryRevision, 'r1');
    assert.equal(view.snapshot.registryContentDigest, winnerStatus.status.view.snapshot.registryContentDigest);
    assert.match(view.snapshotDigest, /^[a-f0-9]{64}$/);
    assert.equal(view.startDecision.action, 'start');
    assert.equal(view.startDecision.generation, 1);
    assert.equal(view.terminal, null);
  });
  const unauthorized = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { headers: { accept: 'text/event-stream' } });
  await step('the winner child is really serving (401 without consumer credentials)', () => {
    assert.equal(unauthorized.status, 401);
  });

  // 3) Foreign actions fail closed without mutation: start, stop, and foreign failure events.
  await step('foreign start/stop/event are rejected and the record and child stay untouched', async () => {
    await assert.rejects(loser.call({ type: 'start' }), error => error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    await assert.rejects(loser.call({ type: 'stop' }), error => error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    assert.deepEqual(await loser.call({ type: 'event', generation: 1, eventType: 'failed', code: 'MANAGED_RUNTIME_FAILED' }), { status: 'rejected' });
    const after = await loser.call({ type: 'status' });
    assert.equal(after.spawns, 0);
    assert.equal(after.status.view.state, 'current');
    assert.equal(after.status.view.generation, 1);
  });
  const stillServing = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.equal(stillServing.status, 401);

  // 4) Failure of the owning process's child is observed from the other process.
  process.kill(firstStart.pid, 'SIGKILL');
  const failedView = await waitFor(async () => {
    const status = await loser.call({ type: 'status' });
    return status.status.view.state === 'failed' ? status.status.view : null;
  }, 20000);
  await step('foreign process observes the failure state, generation, static code and Registry identity', () => {
    assert.equal(failedView.generation, 1);
    assert.equal(failedView.currentVerified, false);
    assert.equal(failedView.current, false);
    assert.equal(failedView.snapshot.registryRevision, 'r1');
    assert.equal(failedView.terminal.reason, 'runtime_failed');
    assert.ok(['MANAGED_CHILD_EXITED', 'MANAGED_CHANNEL_FAILED'].includes(failedView.terminal.code),
      `unexpected static failure code ${failedView.terminal.code}`);
  });

  // 5) Ownership change after a Registry revision move: only the new owner advances the
  // generation, and the new snapshot binds the exact revision the child loaded.
  writeRegistry('r2');
  const secondStart = await loser.call({ type: 'start' }, 120000);
  await step('generation advances monotonically to a new owner with the new Registry revision', () => {
    assert.equal(secondStart.generation, 2);
    assert.equal(secondStart.snapshot.registryRevision, 'r2');
    observedGenerations.push(secondStart.generation);
  });
  const foreignView = (await winner.call({ type: 'status' })).status.view;
  await step('previous owner observes generation 2 and cannot advance it', async () => {
    assert.equal(foreignView.generation, 2);
    assert.equal(foreignView.state, 'current');
    assert.equal(foreignView.currentVerified, true);
    assert.equal(foreignView.current, false);
    assert.equal(foreignView.snapshot.registryRevision, 'r2');
    assert.equal(foreignView.startDecision.generation, 2);
    await assert.rejects(winner.call({ type: 'start' }), error => error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT');
    assert.equal((await winner.call({ type: 'status' })).spawns, 1, 'rejected foreign start must not spawn');
  });
  await step('stale generation events cannot override the new current generation', async () => {
    assert.deepEqual(await loser.call({ type: 'event', generation: 1, eventType: 'closed', code: 'MANAGED_CHILD_EXITED' }), { status: 'stale' });
    const after = (await winner.call({ type: 'status' })).status.view;
    assert.equal(after.generation, 2);
    assert.equal(after.state, 'current');
  });

  // 6) Registry hot-update path: re-prepare + restart only. No stale reuse.
  const r3 = writeRegistry('r3');
  const stopped = await loser.call({ type: 'stop' }, 60000);
  const thirdStart = await loser.call({ type: 'start' }, 120000);
  await step('Registry r3 restart re-prepares a new generation and is observable cross-process', () => {
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.generation, 2);
    assert.equal(thirdStart.generation, 3);
    assert.equal(thirdStart.snapshot.registryRevision, 'r3');
    observedGenerations.push(thirdStart.generation);
  });
  const observedThird = (await winner.call({ type: 'status' })).status.view;
  assert.equal(observedThird.snapshot.registryRevision, 'r3');
  assert.equal(observedThird.snapshot.registryContentDigest, r3.digest);
  assert.equal(observedThird.currentVerified, true);

  // 7) A stale captured package (taken before the Registry moved on) must never become current.
  await loser.call({ type: 'stop' });
  const armed = await loser.call({ type: 'armCapture' });
  assert.equal(armed.registryRevision, 'r3');
  const r4 = writeRegistry('r4');
  await assert.rejects(loser.call({ type: 'start' }, 120000), error => error.code === 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
  const staleFailed = (await winner.call({ type: 'status' })).status.view;
  await step('stale captured package is rejected and cannot become current', () => {
    assert.equal(staleFailed.state, 'failed');
    assert.equal(staleFailed.generation, 4);
    assert.equal(staleFailed.snapshot.registryRevision, 'r3', 'failure keeps the stale revision it attempted, not the moved-on revision');
    assert.equal(staleFailed.currentVerified, false);
    assert.equal(staleFailed.terminal.code, 'MANAGED_LIFECYCLE_CHANNEL_FAILED');
  });
  const fifthStart = await loser.call({ type: 'start' }, 120000);
  await step('a fresh start after the rejection binds Registry r4 and restores current', () => {
    assert.equal(fifthStart.generation, 5);
    assert.equal(fifthStart.snapshot.registryRevision, 'r4');
    observedGenerations.push(fifthStart.generation);
  });
  const observedFifth = (await winner.call({ type: 'status' })).status.view;
  assert.equal(observedFifth.snapshot.registryRevision, 'r4');
  assert.equal(observedFifth.snapshot.registryContentDigest, r4.digest);
  assert.equal(observedFifth.currentVerified, true);
  assert.deepEqual(await loser.call({ type: 'event', generation: 3, eventType: 'closed', code: 'STOPPED' }), { status: 'stale' });

  // 8) Owner crash: the other process fails closed, then recover only through an explicit
  // reconcile; the generation keeps increasing and ownership moves between processes.
  await step('foreign start fails closed while the crashed owner generation is still current', async () => {
    await assert.rejects(winner.call({ type: 'start' }), error => error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT');
  });
  loser.kill();
  await Promise.race([loser.exit, delay(10000)]);
  await waitFor(() => portUnreachable(`http://127.0.0.1:${mcpPort}/mcp`), 30000);
  const orphaned = (await winner.call({ type: 'status' })).status.view;
  await step('crashed owner generation is observable as unowned current from the other process', () => {
    assert.equal(orphaned.generation, 5);
    assert.equal(orphaned.state, 'current');
    assert.equal(orphaned.currentVerified, true);
    assert.equal(orphaned.current, false);
    assert.equal(orphaned.snapshot.registryRevision, 'r4');
  });
  await assert.rejects(winner.call({ type: 'start' }), error => error.code === 'MANAGED_LIFECYCLE_FOREIGN_CURRENT');
  const reconciled = await winner.call({ type: 'reconcile' });
  await step('explicit reconcile abandons the crashed generation before takeover', () => {
    assert.equal(reconciled.status, 'observed');
    assert.equal(reconciled.view.state, 'abandoned');
    assert.equal(reconciled.view.generation, 5);
    assert.equal(reconciled.view.currentVerified, false);
  });
  const sixthStart = await winner.call({ type: 'start' }, 120000);
  await step('takeover start advances to generation 6 with the loaded Registry revision', () => {
    assert.equal(sixthStart.generation, 6);
    assert.equal(sixthStart.snapshot.registryRevision, 'r4');
    observedGenerations.push(sixthStart.generation);
    for (let index = 1; index < observedGenerations.length; index++) {
      assert.ok(observedGenerations[index] > observedGenerations[index - 1], 'generations must strictly increase');
    }
  });
  const ownerStatus = await winner.call({ type: 'status' });
  await step('takeover owner is unique and the status projects the final generation', () => {
    assert.equal(ownerStatus.owner, 6);
    assert.equal(ownerStatus.spawns, 2, 'owner spawned once for the failed generation and once for the takeover');
    assert.equal(ownerStatus.status.view.state, 'current');
    assert.equal(ownerStatus.status.view.current, true);
    assert.equal(ownerStatus.status.view.snapshot.registryRevision, 'r4');
  });
  const finalStop = await winner.call({ type: 'stop' }, 60000);
  await step('final stop is owner-verified and leaves no current', () => {
    assert.equal(finalStop.status, 'stopped');
    assert.equal(finalStop.generation, 6);
  });
  await waitFor(() => portUnreachable(`http://127.0.0.1:${mcpPort}/mcp`), 30000);
  await winner.call({ type: 'close' }, 30000);
  await Promise.race([winner.exit, delay(10000)]);
  assert.ok(!p1.output.includes('synthetic-client-key') && !p2.output.includes('synthetic-client-key'), 'no synthetic secret in instance output');
  return { observedGenerations, winner: winner.label, loser: loser.label };
}

async function stopPostgres() {
  if (!data) return;
  if (!started) {
    try { await pg('pg_ctl', ['-D', data, 'status']); started = true; }
    catch (error) { if (error.code === 3 || error.code === 4) return; throw error; }
  }
  await pg('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']);
  started = false;
}

async function cleanup() {
  for (const instance of instances) {
    if (instance.exited) continue;
    try { await instance.call({ type: 'close' }, 10000); } catch { /* killed below */ }
    instance.kill();
  }
  await Promise.allSettled(instances.map(instance => Promise.race([instance.exit, delay(5000)])));
  await stopPostgres();
  if (directory) {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('apinova-c3-03-'));
    assert.equal(started, false, 'Refusing to delete a running cluster');
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function main() {
  await pg('initdb', ['--version']);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apinova-c3-03-'));
  data = path.join(directory, 'pgdata');
  assetsDir = path.join(directory, 'assets');
  registryPath = path.join(directory, 'registry.json');
  configPath = path.join(directory, 'sources.json');
  let report;
  try {
    fsSync.mkdirSync(assetsDir);
    buildManagedAssets();
    await pg('initdb', ['-D', data, '-U', 'c3_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    pgPort = await freePort();
    await fs.appendFile(path.join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 32\nfsync = on\nsynchronous_commit = on\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'),
      'host all c3_fixture 127.0.0.1/32 trust\nlocal all c3_fixture trust\n');
    await pg('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']);
    started = true;
    mcpPort = await freePort();
    initConfig();
    writeRegistry('r1');
    report = await runScenarios();
  } catch (error) {
    for (const instance of instances) {
      if (!instance.exited) console.error(`--- ${instance.label} output ---\n${instance.output}`);
    }
    throw error;
  } finally {
    await cleanup();
  }
  console.log(JSON.stringify({ marker: 'C3_03_VERIFY_OK', dialect: 'postgres', processes: 2, checks: checks.length,
    generations: report.observedGenerations, firstOwner: report.winner, secondOwner: report.loser,
    clusterStopped: true, clusterRemoved: true,
    scope: 'multi-process-generation-registry-revision-ownership-fail-closed-cross-process-status' }));
  console.log('\nC3_03_VERIFY_OK multi-process Registry/generation coordination: ' + checks.length +
    ' checks, 2 real API processes, isolated PostgreSQL, Windows Node ' + process.version);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
