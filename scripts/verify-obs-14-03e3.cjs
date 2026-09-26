// OBS-14-03E3 overall lifecycle acceptance runner. Windows local SQL.js evidence only.
// Runs the call-observability module jest suites, the bounded physical event cleanup
// acceptance harness (default-off, bounded batches, gap+cursor atomicity, protections,
// restart/resume, idempotent re-run) plus the OBS-14-03 E1/E2A and OBS-14-03D regression
// TAP scripts, then emits one machine-readable marker. PostgreSQL runtime, long-duration
// soak, cross-platform and deployment acceptance are explicitly not covered here.
'use strict';
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages/api-nova-api');
const scriptTimeoutMs = 300000;
const jestTimeoutMs = 15 * 60 * 1000;

const requiredBuiltFiles = [
  'dist/src/database/entities/runtime-call-observability.entity.js',
  'dist/src/database/entities/runtime-observability-event.entity.js',
  'dist/src/modules/call-observability/call-observability.store.js',
  'dist/src/modules/call-observability/call-observability-deliveries.service.js',
  'dist/src/modules/call-observability/call-observability-lifecycle-retention.service.js',
];

const TAP_SUITES = [
  { script: 'test-call-observability-event-retention-cleanup.cjs', scope: 'OBS-14-03E2B bounded physical event cleanup end state (SQL.js)',
    acceptance: true },
  { script: 'test-call-observability-event-gaps.cjs', scope: 'OBS-14-03E1 non-contiguous deletion gaps and cursor protection (SQL.js)' },
  { script: 'test-call-observability-event-retention-preview.cjs', scope: 'OBS-14-03E2A read-only candidate classification (SQL.js)' },
  { script: 'test-call-observability-deliveries.cjs', scope: 'OBS-14-03D delivery lifecycle regression (dist)' },
  { script: 'test-call-observability-outbox.cjs', scope: 'OBS-14-03D outbox regression (dist)' },
  { script: 'test-call-observability-webhook-worker.cjs', scope: 'OBS-14-03D webhook worker regression (dist)' },
  { script: 'test-call-observability-api-foundation.cjs', scope: 'OBS-14-03D API foundation regression (dist)' },
  { script: 'test-call-observability-collector.cjs', scope: 'OBS-14-03D collector regression (dist)' },
];

const ANSI = /\u001b\[[0-9;]*m/g;
function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? text.slice(-length) : text;
}
function fail(message, details) {
  console.error(`[verify-obs-14-03e3] ${message}`);
  const payload = { marker: 'OBS_14_03E3_FAILED', workPackage: 'OBS-14-03E3', message };
  if (details !== undefined) payload.details = details;
  console.error(JSON.stringify(payload));
  process.exit(1);
}
function resolveJestCli() {
  for (const candidate of [apiCwd, repository]) {
    try {
      return path.join(path.dirname(require.resolve('jest/package.json', { paths: [candidate] })), 'bin', 'jest.js');
    } catch { /* try the next workspace root */ }
  }
  throw new Error('jest CLI not found. Run: npm install');
}
function tapCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
  return matches.length ? Number(matches.pop()[1]) : null;
}
function runTap(entry) {
  const started = Date.now();
  const result = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', path.join('scripts', entry.script)],
    { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
      timeout: scriptTimeoutMs, env: { ...process.env, DB_TYPE: 'sqlite' } });
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI, '');
  const summary = {
    script: entry.script,
    scope: entry.scope,
    kind: 'tap',
    status: result.status === 0 ? 'pass' : (timedOut ? 'timeout' : 'fail'),
    tests: tapCount(output, 'tests'),
    pass: tapCount(output, 'pass'),
    fail: tapCount(output, 'fail'),
    durationMs: Date.now() - started,
  };
  if (summary.status === 'pass' && (summary.tests === null || summary.fail !== 0)) summary.status = 'fail';
  let detail = null;
  if (entry.acceptance) {
    const line = output.split('\n').find(value => value.includes('OBS_14_03E3_DETAIL'));
    if (line) {
      const start = line.indexOf('{'), end = line.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { detail = JSON.parse(line.slice(start, end + 1)); } catch { detail = null; }
      }
    }
  }
  return { summary, output, detail };
}
function runJest() {
  const outputFile = path.join(repository, '.tmp', 'obs-14-03e3-jest.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const started = Date.now();
  const result = spawnSync(process.execPath,
    [resolveJestCli(), '--runInBand', '--json', '--outputFile', outputFile, 'src/modules/call-observability'],
    { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: jestTimeoutMs });
  let summary = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    summary = {
      target: 'src/modules/call-observability',
      scope: 'Full call-observability module jest suite (OBS-14-03 lifecycle and regressions)',
      kind: 'jest',
      status: parsed.success ? 'pass' : 'fail',
      suites: parsed.numTotalTestSuites,
      passedSuites: parsed.numPassedTestSuites,
      failedSuites: parsed.numFailedTestSuites,
      tests: parsed.numTotalTests,
      pass: parsed.numPassedTests,
      fail: parsed.numFailedTests,
      durationMs: Date.now() - started,
    };
  } catch {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI, '');
    summary = { target: 'src/modules/call-observability', kind: 'jest', status: 'fail',
      suites: null, tests: null, pass: null, fail: null, durationMs: Date.now() - started,
      error: result.error ? String(result.error.message || result.error) : truncate(output, 2000) };
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
  return summary;
}

const startedAt = Date.now();
for (const relative of requiredBuiltFiles) {
  if (!fs.existsSync(path.join(apiCwd, relative))) {
    fail(`Missing ${relative}. Run: npm run build --workspace api-nova-api`);
  }
}
for (const entry of TAP_SUITES) {
  if (!fs.existsSync(path.join(apiCwd, 'scripts', entry.script))) fail(`Missing scripts/${entry.script}`);
}

const jestSummary = runJest();
const runs = TAP_SUITES.map(runTap);
const acceptanceRun = runs.find(run => run.summary.script === 'test-call-observability-event-retention-cleanup.cjs');
const detail = acceptanceRun?.detail ?? null;
const failures = [];
if (jestSummary.status !== 'pass') failures.push('jest:src/modules/call-observability');
for (const run of runs) {
  if (run.summary.status !== 'pass') failures.push(`tap:${run.summary.script}`);
}

const checks = [];
function check(name, condition, actual) {
  checks.push({ check: name, status: condition ? 'pass' : 'fail', actual: actual === undefined ? null : actual });
  if (!condition) failures.push(`acceptance:${name}`);
}
check('detail-present', detail !== null, detail ? 'present' : null);
if (detail) {
  check('default-off-no-deletes',
    detail.defaultOff?.runsRefused === 2 && detail.defaultOff?.survivingEvents === 2 &&
    detail.defaultOff?.cursorAdvanced === false && detail.defaultOff?.watermarkUnchanged === true,
    detail.defaultOff?.survivingEvents);
  check('default-off-worker-toggle',
    detail.defaultOff?.workerDefaultEventsEnabled === false, detail.defaultOff?.workerDefaultEventsEnabled);
  check('enabled-deletes-authorized',
    detail.enabled?.deleted === 2 && detail.enabled?.gapRanges === 1 && detail.enabled?.checkpointNull === true,
    detail.enabled?.deleted);
  check('gap-cursor-atomicity',
    detail.atomicity?.rolledBack === true && detail.atomicity?.cursorUnchangedOnFailure === true &&
    detail.atomicity?.retriedDeleted === 1, detail.atomicity?.retriedDeleted);
  check('bounded-batches',
    JSON.stringify(detail.bounded?.batches) === JSON.stringify([2, 2, 1, 0]) &&
    detail.bounded?.scanLimit === 4 && detail.bounded?.deleteLimit === 2, detail.bounded?.batches);
  check('restart-resume-and-tail-reset',
    detail.bounded?.resumedAcrossInstances === true && detail.bounded?.tailReset === true,
    detail.bounded?.tailReset);
  check('asset-scope', detail.bounded?.scopedOutHiddenRows === 1, detail.bounded?.scopedOutHiddenRows);
  check('protections-hold',
    detail.protections?.leaseProtectedThenDeleted === true &&
    detail.protections?.openAttemptProtectedThenDeleted === true &&
    detail.protections?.validIdempotencyProtectedThenDeleted === true, detail.protections?.releasedDeleted);
  check('idempotent-rerun',
    detail.idempotentRerun?.deleted === 0 && detail.idempotentRerun?.gapRangesUnchanged === true,
    detail.idempotentRerun?.gapRanges);
}

const environment = {
  commit: execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim(),
  uncommittedTrackedChanges: execSync('git status --porcelain --untracked-files=no', {
    cwd: repository, encoding: 'utf8',
  }).trim().length > 0,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cwd: apiCwd,
  database: 'sqljs in-process, single process, synchronize-based fixture; dist+source dual run',
};
const report = {
  marker: failures.length ? 'OBS_14_03E3_FAILED' : 'OBS_14_03E3_OK',
  status: failures.length ? 'failed' : 'pass',
  workPackage: 'OBS-14-03E3',
  feature: 'OBS-14-03E2B authorized physical deletion',
  environment,
  jest: jestSummary,
  suites: runs.map(run => run.summary),
  acceptance: { script: acceptanceRun?.summary.script ?? null, detail, checks },
  failures,
  notCovered: [
    'PostgreSQL runtime execution and true multi-process concurrency (platform item; dialect shape is covered only by shared entities/migrations)',
    'long-duration soak and sustained deletion volume',
    'Linux/macOS execution (Windows local evidence only)',
    'production deployment, activation and rollback sign-off',
  ],
  notes: [
    'Physical event deletion is default-off; the acceptance harness enables it explicitly.',
    'Event deletion, its deletion gap and the persisted cursor are committed in one Store transaction; failure rolls back all three.',
    'Tombstones from OBS-14-03D are reused unchanged and never expire; this runner verifies they are not touched by event cleanup.',
  ],
  durationMs: Date.now() - startedAt,
};
console.log(JSON.stringify(report));
if (failures.length) {
  for (const run of runs) {
    if (run.summary.status !== 'pass') {
      console.error(`--- ${run.summary.script} (last output) ---\n${run.output.slice(-6000)}`);
    }
  }
  process.exit(1);
}
