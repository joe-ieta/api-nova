// OBS-14-05D quota state-machine and local fault joint acceptance runner. Windows
// local SQL.js evidence plus real filesystem I/O in isolated temporary roots.
// Aggregates the payload/quota regression TAP scripts and the OBS-14-05D joint
// scenarios (watermarks, physical statfs reserve, version/disabled states,
// permission/business bypass, pressure fault recovery), then emits one marker.
// PostgreSQL/Linux runtime, long-duration soak, true multi-process writers and
// production enable/rollback are explicitly not covered here.
'use strict';
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages/api-nova-api');
const scriptTimeoutMs = 300000;
const jestTimeoutMs = 15 * 60 * 1000;

const requiredBuiltFiles = [
  'dist/src/modules/call-observability/call-observability.store.js',
  'dist/src/modules/call-observability/call-observability-payload.store.js',
  'dist/src/modules/call-observability/call-observability-payload-quota.js',
  'dist/src/modules/call-observability/call-observability-payload-physical.js',
  'dist/src/modules/call-observability/call-observability-payload-publication-intent.js',
  'dist/src/modules/call-observability/call-observability-payloads.service.js',
];

const TAP_SUITES = [
  { script: 'test-call-observability-payload-quota-joint.cjs', scope: 'OBS-14-05D joint state machine: watermarks, statfs reserve, version/disabled, permission, pressure fault (SQL.js + real files)', acceptance: true },
  { script: 'test-call-observability-payload-quota.cjs', scope: 'OBS-14-05A ledger, reservation and H/L boundaries (SQL.js)' },
  { script: 'test-call-observability-payload-quota-publication.cjs', scope: 'OBS-14-05B optional publication gate end state (SQL.js + real files)' },
  { script: 'test-call-observability-payload-capacity.cjs', scope: 'Payload capacity scan samples and GC regression (SQL.js)' },
  { script: 'test-call-observability-payload-inventory.cjs', scope: 'OBS-14-05C1 read-only bounded inventory (SQL.js)' },
  { script: 'test-call-observability-payload-inventory-fence.cjs', scope: 'OBS-14-05C2B1 cross-batch writer/GC fence (SQL.js)' },
  { script: 'test-call-observability-payload-inventory-checkpoint.cjs', scope: 'OBS-14-05C2A durable unverified prefix checkpoint (SQL.js)' },
  { script: 'test-call-observability-payload-baseline.cjs', scope: 'OBS-14-05C2B2 fenced atomic baseline (SQL.js)' },
  { script: 'test-call-observability-payload-baseline-faults.cjs', scope: 'OBS-14-05C2B3 fence and baseline fault matrix (SQL.js)' },
  { script: 'test-call-observability-payload-reconciliation.cjs', scope: 'OBS-14-02 metadata repair regression (SQL.js)' },
  { script: 'test-call-observability-payload-recovery-hold.cjs', scope: 'OBS-14-05C2C2A conservative uncertain reservation hold (SQL.js)' },
  { script: 'test-call-observability-payload-recovery-evidence.cjs', scope: 'OBS-14-05C2C1 read-only reservation/orphan evidence (SQL.js)' },
  { script: 'test-call-observability-payload-publication-intent.cjs', scope: 'OBS-14-05C2C2B1/B2 durable publication intent (SQL.js)' },
  { script: 'test-call-observability-payload-publication-correlation.cjs', scope: 'OBS-14-05C2C2C1 read-only correlation (SQL.js)' },
  { script: 'test-call-observability-payload-publication-file-proof.cjs', scope: 'OBS-14-05C2C2C2A read-only file proof (SQL.js)' },
  { script: 'test-call-observability-payload-publication-reconcile.cjs', scope: 'OBS-14-05C2C2C2B atomic settlement (SQL.js)' },
  { script: 'test-call-observability-payload-publication-restart.cjs', scope: 'OBS-14-05C2C2B3 intent crash windows and restart (SQL.js)' },
  { script: 'test-call-observability-payload-recovery-acceptance.cjs', scope: 'OBS-14-05C2C3 real ingest fault chains and recovery (SQL.js + real files)' },
  { script: 'test-call-observability-payloads.cjs', scope: 'Payload read API authorization and audit boundary (dist + HTTP)' },
];

const RESET_ENVIRONMENT = [
  'API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED',
  'API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_PHYSICAL_ENABLED',
  'API_NOVA_OBSERVABILITY_DATA_DIR',
];

const ANSI = /\u001b\[[0-9;]*m/g;
function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? text.slice(-length) : text;
}
function fail(message, details) {
  console.error(`[verify-obs-14-05d] ${message}`);
  const payload = { marker: 'OBS_14_05D_FAILED', workPackage: 'OBS-14-05D', message };
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
function resetEnvironment() {
  const env = { ...process.env, DB_TYPE: 'sqlite' };
  for (const name of RESET_ENVIRONMENT) delete env[name];
  return env;
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
      timeout: scriptTimeoutMs, env: resetEnvironment() });
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
    const line = output.split('\n').find(value => value.includes('OBS_14_05D_DETAIL'));
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
  const outputFile = path.join(repository, '.tmp', 'obs-14-05d-jest.json');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const started = Date.now();
  const result = spawnSync(process.execPath,
    [resolveJestCli(), '--runInBand', '--json', '--outputFile', outputFile, 'src/modules/call-observability'],
    { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      timeout: jestTimeoutMs, env: resetEnvironment() });
  let summary = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    summary = {
      target: 'src/modules/call-observability',
      scope: 'Full call-observability module jest suite (OBS-14-05D plus regressions)',
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
const acceptanceRun = runs.find(run => run.summary.script === 'test-call-observability-payload-quota-joint.cjs');
const detail = acceptanceRun?.detail ?? null;
const failures = [];
if (jestSummary.status !== 'pass') failures.push('jest:src/modules/call-observability');
for (const run of runs) {
  if (run.summary.status !== 'pass') failures.push(`tap:${run.summary.script}`);
}
const byScript = new Map(runs.map(run => [run.summary.script, run.summary]));

const checks = [];
function check(name, condition, actual) {
  checks.push({ check: name, status: condition ? 'pass' : 'fail', actual: actual === undefined ? null : actual });
  if (!condition) failures.push(`acceptance:${name}`);
}
function suitePass(script, tests, pass) {
  const summary = byScript.get(script);
  return Boolean(summary) && summary.status === 'pass' && summary.tests === tests && summary.pass === pass && summary.fail === 0;
}
check('detail-present', detail !== null, detail ? 'present' : null);
check('scenario1-watermark-hysteresis',
  detail?.scenario1?.committedAtHigh === 900 && detail?.scenario1?.deniedReason === 'quota_exhausted' &&
  detail?.scenario1?.deniedWrites === 0 && detail?.scenario1?.hysteresis?.atHigh === 'limited' &&
  detail?.scenario1?.hysteresis?.overHigh === 'QUOTA_NOT_READY' && detail?.scenario1?.hysteresis?.atLowCommitted === 800 &&
  detail?.scenario1?.hysteresis?.atLow === 'ready' && detail?.scenario1?.hardBoundExact === 1000,
  detail?.scenario1?.hysteresis);
check('scenario2-physical-statfs-reserve',
  (detail?.scenario2?.realObservationBytes ?? 0) > 0 && detail?.scenario2?.simulatedLow === 'quota_physical_low' &&
  detail?.scenario2?.staleEvidence === 'quota_physical_unknown' && detail?.scenario2?.missingEvidence === 'quota_physical_unknown' &&
  detail?.scenario2?.deniedTemporaryWrites === 0 && detail?.scenario2?.defaultOffConsulted === true,
  detail?.scenario2);
check('scenario3-version-disabled-state',
  detail?.scenario3?.configurationConflict === 'QUOTA_CONFIGURATION_CONFLICT' && detail?.scenario3?.versionConflict === 'QUOTA_VERSION_CONFLICT' &&
  detail?.scenario3?.epochMismatch === 'QUOTA_EPOCH_MISMATCH' && detail?.scenario3?.operationConflict === 'QUOTA_OPERATION_CONFLICT' &&
  detail?.scenario3?.disabledState === 'disabled' && detail?.scenario3?.disabledBaselineKey === null &&
  detail?.scenario3?.disabledReservations === 0, detail?.scenario3);
check('scenario4-permission-bypass',
  detail?.scenario4?.deniedReason === 'quota_exhausted' && detail?.scenario4?.forgedRelief === 'rejected' &&
  detail?.scenario4?.crossAssetRead === 'NOT_FOUND' && detail?.scenario4?.authorizedRead === 'captured',
  detail?.scenario4);
check('scenario5-pressure-fault-recovery',
  (detail?.scenario5?.heldReserved ?? 0) >= (detail?.scenario5?.heldPhysicalBytes ?? -1) &&
  detail?.scenario5?.settledReserved === 0 && detail?.scenario5?.replayDelta === 0 &&
  detail?.scenario5?.reservationRowsAfterReplay === 1 && detail?.scenario5?.undercountOrOversell === false,
  detail?.scenario5);
check('scenario6-business-effect-declared',
  detail?.scenario6?.silentDrop === false && detail?.scenario6?.businessOutcome === 'success' &&
  detail?.scenario6?.recoveryStatus === 'settled', detail?.scenario6);
check('scenario1-script-05a-ledger', suitePass('test-call-observability-payload-quota.cjs', 8, 8));
check('scenario2-script-05b-gate', suitePass('test-call-observability-payload-quota-publication.cjs', 13, 13));
check('scenario2-script-joint', suitePass('test-call-observability-payload-quota-joint.cjs', 5, 5));
check('scenario5-script-recovery-acceptance', suitePass('test-call-observability-payload-recovery-acceptance.cjs', 5, 5));
check('scenario5-script-baseline-faults', suitePass('test-call-observability-payload-baseline-faults.cjs', 7, 7));
check('scenario5-script-publication-reconcile', suitePass('test-call-observability-payload-publication-reconcile.cjs', 10, 10));
check('scenario5-script-publication-restart', suitePass('test-call-observability-payload-publication-restart.cjs', 8, 8));
check('scenario4-script-payload-http-authorization', suitePass('test-call-observability-payloads.cjs', 23, 23));
check('aggregate-tap-suites',
  runs.every(run => run.summary.status === 'pass' && run.summary.fail === 0 && run.summary.tests !== null),
  runs.map(run => `${run.summary.script}:${run.summary.pass}/${run.summary.tests}`));
const tapTotals = runs.reduce((total, run) => ({
  tests: total.tests + (run.summary.tests ?? 0), pass: total.pass + (run.summary.pass ?? 0), fail: total.fail + (run.summary.fail ?? 0),
}), { tests: 0, pass: 0, fail: 0 });

const environment = {
  commit: execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim(),
  uncommittedTrackedChanges: execSync('git status --porcelain --untracked-files=no', {
    cwd: repository, encoding: 'utf8',
  }).trim().length > 0,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cwd: apiCwd,
  database: 'sqljs in-process, single process, synchronize-based fixture; real temporary payload roots',
  tempRoot: process.env.TEMP || process.env.TMP || null,
};
const report = {
  marker: failures.length ? 'OBS_14_05D_FAILED' : 'OBS_14_05D_OK',
  status: failures.length ? 'failed' : 'pass',
  workPackage: 'OBS-14-05D',
  feature: 'Quota state machine and local fault joint acceptance (default-off physical guard)',
  environment,
  jest: jestSummary,
  suites: runs.map(run => run.summary),
  counts: { tapSuites: runs.length, tapTests: tapTotals.tests, tapPass: tapTotals.pass, tapFail: tapTotals.fail,
    jestSuites: jestSummary.suites, jestTests: jestSummary.tests, jestPass: jestSummary.pass, jestFail: jestSummary.fail },
  acceptance: { script: acceptanceRun?.summary.script ?? null, detail, checks },
  failures,
  notCovered: [
    'long-duration soak and sustained pressure volume (bounded local scenarios only)',
    'Linux/PostgreSQL runtime for the new joint state-machine scenarios (Windows SQL.js plus real local filesystem; 05C3 dual-platform evidence is separate)',
    'true multi-process writers for the new joint scenarios (single-process SQL.js)',
    'production enable/rollback, deployment sign-off and raising quotaEnforced above false',
  ],
  notes: [
    'Optional quota stays default-off (API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED) and the OBS-14-05D physical statfs guard is a separate new default-off switch (API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_PHYSICAL_ENABLED).',
    'The physical guard is evaluated from real fs.statfs numbers of the managed payload root; missing, stale (over 15s) or low evidence refuses new optional bodies with declared reasons instead of bypassing the reserve.',
    'No schema or migration change was introduced in OBS-14-05D; the existing ledger configuration carries the physical reserve and observation-age bounds.',
    'quotaEnforced remains false; this runner does not claim full production enforcement.',
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
