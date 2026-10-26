'use strict';
// OBS-16-03 Stage 4: thin aggregator for the environment-dependent execution lane.
//
// Runs the independently runnable stage scripts and prints one machine-readable
// OBS_16_03_VERIFY_OK line with a per-cell matrix {cellId, AC refs, platform, db, command,
// result pass/fail/blocked, evidence}. Any real failure gates the exit code; only the
// documented blocked cells (TLS success without CA injection, --network none in the Alpine
// container) may appear without failing the run.
//
// Stage 1: Windows isolated PostgreSQL multi-process lane.
// Stage 2: controlled loopback receiver matrix.
// Stage 3: Linux container subset (node:24-alpine + Alpine PostgreSQL 16).
const { spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages/api-nova-api');
const logRoot = path.join(process.env.OBS16_TMP_DIR || os.tmpdir(), 'obs-16-03-verify');
const ANSI = /\u001b\[[0-9;]*m/g;

function fail(message, details) {
  console.error(`[verify-obs-16-03] ${message}`);
  const payload = { marker: 'OBS_16_03_VERIFY_FAILED', workPackage: 'OBS-16-03', message };
  if (details !== undefined) payload.details = details;
  console.error(JSON.stringify(payload));
  process.exit(1);
}
function tapCounts(output) {
  const count = name => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.pop()[1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail') };
}
function detailLine(output, marker) {
  const line = String(output).split('\n').find(value => value.includes(marker));
  if (!line) return null;
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(line.slice(start, end + 1)); } catch { return null; }
}
function runScript(cwd, script, timeout) {
  const result = spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI, '');
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return { output, exitCode: result.status, timedOut };
}
function runTap(cwd, script, timeout) {
  const result = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', script],
    { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI, '');
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return { output, exitCode: result.status, timedOut, tap: tapCounts(output) };
}
function writeLog(name, output) {
  fs.mkdirSync(logRoot, { recursive: true });
  const target = path.join(logRoot, name);
  fs.writeFileSync(target, output);
  return target;
}

const required = 'packages/api-nova-api/dist/src/database/entities/runtime-call-observability.entity.js';
if (!fs.existsSync(path.join(repository, required))) {
  fail(`Missing ${required}. Run: npm run build --workspace api-nova-api`);
}
for (const script of [
  'packages/api-nova-api/scripts/test-obs-16-03-pg-multiprocess.cjs',
  'packages/api-nova-api/scripts/test-obs-16-03-receiver-matrix.cjs',
  'scripts/run-obs-16-03-linux-container.cjs',
]) {
  if (!fs.existsSync(path.join(repository, script))) fail(`Missing ${script}`);
}

const startedAt = Date.now();
const stage1 = runTap(apiCwd, 'scripts/test-obs-16-03-pg-multiprocess.cjs', 1200000);
const stage1Log = writeLog('stage1-win-pg-multiprocess.log', stage1.output);
const stage1Env = detailLine(stage1.output, 'OBS_16_03_STAGE1_ENV');
const stage1PgUnavailable = /PostgreSQL unavailable/.test(stage1.output);

const stage2 = runTap(apiCwd, 'scripts/test-obs-16-03-receiver-matrix.cjs', 600000);
const stage2Log = writeLog('stage2-win-receiver-matrix.log', stage2.output);
const stage2Detail = detailLine(stage2.output, 'OBS_16_03_RECEIVER_DETAIL');

const stage3 = runScript(repository, 'scripts/run-obs-16-03-linux-container.cjs', 1800000);
const stage3Log = writeLog('stage3-linux-container.log', stage3.output);
const stage3Detail = detailLine(stage3.output, 'OBS_16_03_LINUX_DETAIL');

const failures = [];
function tapCell(id, ac, platform, db, command, run, evidenceLog, extras = {}) {
  const pass = run.exitCode === 0 && !run.timedOut && run.tap && run.tap.tests > 0 && run.tap.fail === 0;
  if (!pass) failures.push(id);
  return {
    cellId: id, ac, platform, db, command,
    result: pass ? 'pass' : (run.timedOut ? 'timeout' : 'fail'),
    tap: run.tap, exitCode: run.exitCode,
    evidence: evidenceLog, ...extras,
  };
}

const cells = [];
if (stage1PgUnavailable) {
  cells.push({
    cellId: 'win-stage1-pg-multiprocess', ac: 'AC-09 AC-12 AC-13 AC-20',
    platform: 'win32', db: 'PostgreSQL isolated (unavailable)',
    command: 'node --test --test-reporter=tap scripts/test-obs-16-03-pg-multiprocess.cjs',
    result: 'blocked',
    reason: 'No isolated PostgreSQL (API_NOVA_TEST_PG_BIN/initdb), no local postgres:16.14 '
      + 'image and no OBS16_PG_MODE=external target were available.',
    evidence: stage1Log,
  });
} else {
  cells.push(tapCell('win-stage1-pg-multiprocess', 'AC-09 AC-12 AC-13 AC-20', 'win32',
    `PostgreSQL ${stage1Env ? stage1Env.postgresVersion : 'unknown'} (isolated local cluster)`,
    'node --test --test-reporter=tap packages/api-nova-api/scripts/test-obs-16-03-pg-multiprocess.cjs '
      + '(cwd packages/api-nova-api; API_NOVA_TEST_PG_BIN)',
    stage1, stage1Log, { postgres: stage1Env ? stage1Env.postgresVersion : null }));
}
cells.push(tapCell('win-stage2-receiver-matrix', 'AC-04 AC-12 AC-20', 'win32',
  'SQL.js in-process fixture database',
  'node --test --test-reporter=tap packages/api-nova-api/scripts/test-obs-16-03-receiver-matrix.cjs '
    + '(cwd packages/api-nova-api)',
  stage2, stage2Log, {
    tlsSuccess: stage2Detail ? stage2Detail.tlsSuccess : null,
  }));

const blocked = [];
if (stage2Detail?.tlsSuccess) {
  blocked.push({
    cellId: 'receiver-tls-success-self-signed-ca', ac: 'AC-12',
    platform: 'win32 / linux/musl (loopback receiver)',
    db: 'n/a', command: 'node --test --test-reporter=tap '
      + 'packages/api-nova-api/scripts/test-obs-16-03-receiver-matrix.cjs (self-signed TLS cell)',
    result: 'blocked', prerequisite: stage2Detail.tlsSuccess.prerequisite,
    evidence: stage2Log,
  });
}
if (stage3Detail) {
  for (const cell of stage3Detail.cells || []) {
    if (cell.result === 'fail') failures.push(cell.cellId);
    cells.push({
      cellId: cell.cellId, ac: 'AC-04 AC-12 AC-13 AC-20',
      platform: `linux/musl Docker (${stage3Detail.environment?.image || 'node:24-alpine'})`,
      db: cell.cellId.includes('stage1')
        ? `Alpine PostgreSQL ${String(stage3Detail.environment?.containerPostgres || '').replace(/^.*\s/, '')}`
        : 'SQL.js in-process fixture database (inside container)',
      command: cell.command, result: cell.result, tap: cell.tap, exitCode: cell.exitCode,
      evidence: cell.evidence || stage3Log,
    });
  }
  for (const cell of stage3Detail.blocked || []) {
    blocked.push({
      cellId: cell.cellId, ac: 'AC-20',
      platform: `linux/musl Docker (${stage3Detail.environment?.image || 'node:24-alpine'})`,
      db: 'n/a', command: 'node scripts/run-obs-16-03-linux-container.cjs',
      result: 'blocked', prerequisite: cell.reason, reason: cell.reason,
      evidence: stage3Log,
    });
  }
} else {
  failures.push('linux-container-subset');
  cells.push({
    cellId: 'linux-container-subset', ac: 'AC-04 AC-12 AC-13 AC-20',
    platform: 'linux/musl Docker', db: 'PostgreSQL / SQL.js',
    command: 'node scripts/run-obs-16-03-linux-container.cjs',
    result: 'fail', reason: 'Stage 3 produced no OBS_16_03_LINUX_DETAIL report.',
    evidence: stage3Log,
  });
}

for (const cell of blocked) cells.push(cell);

const report = {
  marker: failures.length ? 'OBS_16_03_VERIFY_FAILED' : 'OBS_16_03_VERIFY_OK',
  status: failures.length ? 'failed' : 'pass',
  workPackage: 'OBS-16-03',
  lane: 'environment-dependent execution',
  environment: {
    commit: execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim(),
    uncommittedTrackedChanges: execSync('git status --porcelain --untracked-files=no',
      { cwd: repository, encoding: 'utf8' }).trim().length > 0,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    tempRoot: logRoot,
    stages: {
      stage1: { script: 'test-obs-16-03-pg-multiprocess.cjs', tap: stage1.tap, exitCode: stage1.exitCode },
      stage2: { script: 'test-obs-16-03-receiver-matrix.cjs', tap: stage2.tap, exitCode: stage2.exitCode,
        scenarios: stage2Detail ? stage2Detail.scenarios : null },
      stage3: stage3Detail ? { status: stage3Detail.status, environment: stage3Detail.environment } : null,
    },
  },
  matrix: cells,
  blocked,
  notCovered: [
    'Real owned TLS success with a self-signed CA: blocked — the retained worker has no CA/trust-root '
      + 'injection contract; no production code was added.',
    'Actual deployment acceptance: worker switches, installed secrets, allowlisted hosts, receiver '
      + 'ownership and deployment authorization are NOT PERFORMED here.',
    'Long-duration soak, sustained load and performance measurements are not covered.',
    'Linux coverage is Alpine/musl (amd64) in a local Docker engine only; glibc distributions, '
      + 'kernel races and multi-host topologies are not covered.',
    'The Alpine container phase cannot use --network none because the PostgreSQL packages must be '
      + 'installed from the package mirror before the run; tests themselves use loopback and one '
      + 'reserved .invalid DNS name only.',
  ],
  notes: [
    'Claim/lease behaviour is asserted against the actual source mechanism: PostgreSQL '
      + 'pessimistic_write + skip_locked, 15 s event leases and 30 s delivery leases.',
    'Crash recovery is a real SIGKILL of a worker process; leases are pinned/aged in PostgreSQL '
      + 'to simulate elapsed wall-clock time deterministically.',
    'Synthetic secrets and loopback receivers only; no real external network and no image pulls.',
  ],
  durationMs: Date.now() - startedAt,
};

console.log(report.marker);
console.log(JSON.stringify(report));
if (failures.length) {
  for (const log of [stage1Log, stage2Log, stage3Log]) {
    console.error(`[verify-obs-16-03] evidence: ${log}`);
  }
  process.exit(1);
}
