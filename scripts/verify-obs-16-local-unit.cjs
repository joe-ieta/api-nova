// OBS-16-02 bounded local fault/carrying unit runner. Windows local isolated evidence only.
// Runs the SQL.js-scoped call-observability harness scripts plus one new bounded storage fault
// unit, then emits one machine-readable marker. Linux, PostgreSQL, multi-process, sustained
// load/performance and deployment acceptance are explicitly not covered by this run.
'use strict';
const { spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages/api-nova-api');

// Frozen fixture scale and expected metrics for this bounded local unit. The runner owns this
// single constant block and passes it to the fault unit through the OBS16_* environment variables.
const FIXTURE = Object.freeze({
  CALL_COUNT: 500,
  EVENT_BATCH: 200,
  PAYLOAD_COUNT: 50,
  SEED: 20260926,
  EXPECTED: Object.freeze({
    INVOCATIONS: 500,
    RECEIPTS: 1000,
    REVISIONS: 1000,
    PAYLOAD_ROWS: 1050,
    CAPTURED_PAYLOADS: 50,
    COMPLETED_EVENTS: 500,
    RAW_BATCH_EVENTS: 200,
    INGEST_EVENTS: 1500,
  }),
});

const SUITES = Object.freeze([
  { script: 'test-call-observability-statistics.cjs', scope: 'AC-11 statistics read contracts (SQL.js)' },
  { script: 'test-call-observability-series-groups.cjs', scope: 'AC-11 series/group read contracts (SQL.js)' },
  { script: 'test-call-observability-overview.cjs', scope: 'AC-14/19 overview read snapshot (SQL.js, ts-node source)' },
  { script: 'test-call-observability-payloads.cjs', scope: 'AC-08/15/17 payload read and retention contracts (SQL.js)' },
  { script: 'test-call-observability-restart.cjs', scope: 'AC-09/10 isolated restart recovery (SQL.js child processes)' },
  { script: 'test-call-observability-local-fault-unit.cjs', scope: 'OBS-16-02 new bounded storage fault unit (SQL.js)',
    faultUnit: true },
]);
const FAULT_SCRIPT = SUITES.find(entry => entry.faultUnit).script;

const prerequisiteFiles = [
  'dist/src/database/entities/runtime-call-observability.entity.js',
  'dist/src/database/entities/runtime-observability-event.entity.js',
  'dist/src/modules/call-observability/call-observability.store.js',
  'dist/src/modules/call-observability/call-observability-payload.store.js',
];
for (const file of prerequisiteFiles) {
  if (!fs.existsSync(path.join(apiCwd, file))) {
    throw new Error(`Missing ${file}. Run: npm run build --workspace api-nova-api`);
  }
}
for (const entry of SUITES) {
  if (!fs.existsSync(path.join(apiCwd, 'scripts', entry.script))) {
    throw new Error(`Missing scripts/${entry.script}`);
  }
}

const ANSI = /\u001b\[[0-9;]*m/g;
function tapCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
  return matches.length ? Number(matches.pop()[1]) : null;
}
function runTap(entry) {
  const env = { ...process.env, DB_TYPE: 'sqlite' };
  if (entry.faultUnit) {
    Object.assign(env, {
      OBS16_CALL_COUNT: String(FIXTURE.CALL_COUNT),
      OBS16_EVENT_BATCH: String(FIXTURE.EVENT_BATCH),
      OBS16_PAYLOAD_COUNT: String(FIXTURE.PAYLOAD_COUNT),
      OBS16_SEED: String(FIXTURE.SEED),
    });
  }
  const started = Date.now();
  const result = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', path.join('scripts', entry.script)],
    { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI, '');
  const summary = {
    script: entry.script,
    scope: entry.scope,
    status: result.status === 0 ? 'pass' : 'fail',
    tests: tapCount(output, 'tests'),
    pass: tapCount(output, 'pass'),
    fail: tapCount(output, 'fail'),
    durationMs: Date.now() - started,
  };
  if (summary.status === 'pass' && (summary.tests === null || summary.fail !== 0)) summary.status = 'fail';
  let detail = null;
  const detailLine = output.split('\n').find(value => value.includes('OBS_16_FAULT_UNIT_DETAIL'));
  if (detailLine) {
    const start = detailLine.indexOf('{');
    const end = detailLine.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { detail = JSON.parse(detailLine.slice(start, end + 1)); } catch { detail = null; }
    }
  }
  return { summary, output, detail };
}

const startedAt = Date.now();
const runs = SUITES.map(runTap);
const failures = [];
for (const run of runs) {
  if (run.summary.status !== 'pass') failures.push(run.summary.script);
}

const faultRun = runs.find(run => run.summary.script === FAULT_SCRIPT);
const detail = faultRun?.detail ?? null;
const checks = [];
function check(name, condition, actual) {
  checks.push({ check: name, status: condition ? 'pass' : 'fail', actual: actual === undefined ? null : actual });
  if (!condition) failures.push(`fault-unit:${name}`);
}
check('detail-present', detail !== null, detail ? 'present' : null);
if (detail) {
  check('scale-callCount', detail.scale?.callCount === FIXTURE.CALL_COUNT, detail.scale?.callCount);
  check('scale-eventBatch', detail.scale?.eventBatch === FIXTURE.EVENT_BATCH, detail.scale?.eventBatch);
  check('scale-payloadCount', detail.scale?.payloadCount === FIXTURE.PAYLOAD_COUNT, detail.scale?.payloadCount);
  check('scale-seed', detail.scale?.seed === FIXTURE.SEED, detail.scale?.seed);
  check('baseline-invocations', detail.baseline?.invocations === FIXTURE.EXPECTED.INVOCATIONS, detail.baseline?.invocations);
  check('baseline-receipts', detail.baseline?.receipts === FIXTURE.EXPECTED.RECEIPTS, detail.baseline?.receipts);
  check('baseline-revisions', detail.baseline?.revisions === FIXTURE.EXPECTED.REVISIONS, detail.baseline?.revisions);
  check('baseline-payloadRows', detail.baseline?.payloadRows === FIXTURE.EXPECTED.PAYLOAD_ROWS, detail.baseline?.payloadRows);
  check('baseline-capturedPayloads', detail.baseline?.capturedPayloads === FIXTURE.EXPECTED.CAPTURED_PAYLOADS,
    detail.baseline?.capturedPayloads);
  check('baseline-completedEvents', detail.baseline?.completedEvents === FIXTURE.EXPECTED.COMPLETED_EVENTS,
    detail.baseline?.completedEvents);
  check('baseline-rawBatchEvents', detail.baseline?.rawBatchEvents === FIXTURE.EXPECTED.RAW_BATCH_EVENTS,
    detail.baseline?.rawBatchEvents);
  check('ingest-events', detail.ingestEvents === FIXTURE.EXPECTED.INGEST_EVENTS, detail.ingestEvents);
  check('reopen-preserved', detail.reopen?.matches === true && detail.reopen?.watermark === detail.baseline?.watermark,
    detail.reopen ? detail.reopen.watermark : null);
  check('duplicate-no-double-count',
    detail.duplicateReplay?.countsUnchanged === true && detail.duplicateReplay?.watermarkUnchanged === true,
    detail.duplicateReplay ? detail.duplicateReplay.records : null);
  check('conflict-quarantined',
    detail.quarantine?.reason === 'SOURCE_EVENT_CONFLICT' && detail.quarantine?.quarantineRows === 1,
    detail.quarantine ? detail.quarantine.reason : null);
  check('failure-reported',
    detail.failureReported?.rejected === true && detail.failureReported?.durableCountsUnchanged === true,
    detail.failureReported ? detail.failureReported.rejected : null);
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
  database: 'sqljs file-backed, single process, explicit save boundaries',
};
const report = {
  marker: failures.length ? 'OBS_16_LOCAL_UNIT_FAILED' : 'OBS_16_LOCAL_UNIT_OK',
  status: failures.length ? 'failed' : 'pass',
  workPackage: 'OBS-16-02',
  environment,
  frozenScale: FIXTURE,
  suites: runs.map(run => run.summary),
  faultUnit: {
    script: FAULT_SCRIPT,
    status: faultRun?.summary.status ?? 'missing',
    tap: faultRun?.summary ?? null,
    detail,
    checks,
  },
  failures,
  notCovered: [
    'Linux execution (OBS-16-03 NEED_ENV)',
    'PostgreSQL storage and dialect',
    'multi-process/multi-writer concurrency outside the restart suite child processes',
    'sustained load and performance measurements',
    'deployment acceptance, activation and rollback',
  ],
  notes: [
    'Windows local isolated unit evidence only; no platform matrix claim and no AVAILABLE claim.',
    'The new fault unit disables SQL.js autosave and asserts durability at explicit driver.save() boundaries.',
    'Restart coverage here is isolated local process recovery, not a production multi-process topology.',
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
