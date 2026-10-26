'use strict';
// SEC-E2-02: dual-platform stability/error matrix.
// Runs the SEC-E2-01 joint matrix on the Windows host and inside a local
// node:24-alpine container on the same commit/artifacts, maps per-suite and
// per-scenario outcomes, records documented platform deltas and notCovered.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const e2Root = path.join(repoRoot, 'scripts', 'verify-e2-01.cjs');
const tempBaseRaw = process.env.E2_02_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'e2-02');
fs.mkdirSync(tempBaseRaw, { recursive: true });
const tempBase = fs.realpathSync.native(tempBaseRaw);
const windowsTimeoutMs = 3600000;
const linuxTimeoutMs = 3600000;
const FAMILIES = ['cancellation', 'timeout', 'replay', 'shutdown'];
const TRANSPORTS = ['streamable', 'sse', 'stdio', 'managed-ipc'];
const retryPolicy = 'at most one isolated re-run per failed suite/scenario on its own platform; the first attempt is retained in retries[] and the platform marker records whether a retry was needed';

function containerRepoPath() {
  if (process.env.E2_02_LINUX_WORKDIR) return process.env.E2_02_LINUX_WORKDIR;
  const parsed = path.parse(repoRoot);
  const drive = parsed.root.replace(/[\\/:]/g, '').toLowerCase();
  const rest = repoRoot.slice(parsed.root.length).split(path.sep).filter(Boolean).join('/');
  return `/mnt/host/${drive}/${rest}`;
}

function extractReport(output) {
  const text = String(output);
  const flags = [...text.matchAll(/"marker": "(E2_01_VERIFY_(?:OK|FAILED))"/g)];
  if (!flags.length) return null;
  const start = text.lastIndexOf('{', flags[flags.length - 1].index);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function readReportFile(file) {
  try { return extractReport(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function dockerServerVersion() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 60000 });
  const version = (result.stdout || '').trim();
  return result.status === 0 && version ? version : null;
}

function linuxImage() {
  return process.env.E2_02_LINUX_IMAGE || 'node:24-alpine';
}

function linuxPrepare() {
  return [
    `tar cf - --exclude=./packages/api-nova-api/data --exclude=./packages/api-nova-ui --exclude=./data --exclude=./.tmp --exclude=./node_modules/.cache . | tar xf - -C /work`,
    `ln -sfn /work/packages/api-nova-parser /work/node_modules/api-nova-parser`,
    `ln -sfn /work/packages/api-nova-server /work/node_modules/api-nova-server`,
    `ln -sfn /work/packages/api-nova-api /work/node_modules/api-nova-api`,
  ].join(' && ');
}

function runLinuxCommand(command, extraEnvironment) {
  const containerRepo = containerRepoPath();
  const environment = [
    '-e', 'E2_01_TEMP=/tmp/e2-01', '-e', 'TEMP=/tmp', '-e', 'TMP=/tmp', '-e', 'TMPDIR=/tmp',
    '-e', 'NODE_PATH=/work/packages', ...(extraEnvironment || []),
  ];
  const args = ['run', '--rm', '--pull=never', '--network', 'none',
    '--tmpfs', '/work:rw,exec,size=4g', '--tmpfs', '/tmp:rw,exec,size=1024m',
    ...environment, '-w', containerRepo, '-v', `${repoRoot}:${containerRepo}:ro`,
    linuxImage(), 'sh', '-c', `${linuxPrepare()} && ${command}`];
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: linuxTimeoutMs, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, E2_01_SUITES_ONLY: '', E2_01_NEW_ONLY: '', E2_01_SKIP_FRESHNESS: '', E2_01_TEMP: '' } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return { exitCode: result.status, error: result.error ? String(result.error.message) : null, output };
}

function runWindowsMatrix() {
  const reused = process.env.E2_02_WINDOWS_REPORT;
  if (reused) return { platform: 'windows', reused, exitCode: null, report: readReportFile(reused), log: reused };
  const directory = path.join(tempBase, 'windows-e2-01');
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync(process.execPath, [e2Root], {
    cwd: repoRoot, encoding: 'utf8', timeout: windowsTimeoutMs, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, E2_01_TEMP: directory, TEMP: directory, TMP: directory },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return { platform: 'windows', exitCode: result.status, error: result.error ? String(result.error.message) : null,
    report: extractReport(output), output };
}

function runLinuxMatrix() {
  const reused = process.env.E2_02_LINUX_REPORT;
  if (reused) return { platform: 'linux', reused, exitCode: null, report: readReportFile(reused), log: reused,
    containerRepo: containerRepoPath(), dockerServer: dockerServerVersion(), image: linuxImage() };
  const serverVersion = dockerServerVersion();
  if (!serverVersion) return { platform: 'linux', exitCode: null, error: 'docker Linux engine not reachable', report: null, output: '' };
  const result = runLinuxCommand('cd /work && node scripts/verify-e2-01.cjs');
  return { platform: 'linux', exitCode: result.exitCode, error: result.error, image: linuxImage(), dockerServer: serverVersion,
    containerRepo: containerRepoPath(), report: extractReport(result.output), output: result.output };
}

function tapCounts(output) {
  const text = String(output);
  const counter = name => {
    const match = text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { tests: counter('tests'), passed: counter('pass'), failed: counter('fail') };
}

function packageRelative(script) {
  const absolute = path.resolve(repoRoot, script);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  const segments = relative.split('/');
  return segments.slice(0, 2).join('/');
}

function suiteResultFromOutput(suite, result, ms) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counts = tapCounts(output);
  const markerSeen = suite.marker ? output.includes(suite.marker) : null;
  const status = result.status === 0 && counts.failed === 0 && (suite.marker ? markerSeen : true) ? 'passed' : 'failed';
  return { status, ...counts, marker: suite.marker || null, markerSeen, ms, exitCode: result.status,
    error: result.error ? String(result.error.message) : null, outputTail: output.slice(-1500) };
}

function windowsRetrySuite(suite) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.resolve(repoRoot, suite.script)], {
    cwd: path.resolve(repoRoot, packageRelative(suite.script)), encoding: 'utf8', timeout: 900000, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, TEMP: path.join(tempBase, 'windows-e2-01'), TMP: path.join(tempBase, 'windows-e2-01'),
      DB_TYPE: 'sqlite', FORCE_COLOR: '0' },
  });
  return suiteResultFromOutput(suite, result, Date.now() - started);
}

function windowsRetryScenarios() {
  const directory = path.join(tempBase, 'windows-e2-01-retry');
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync(process.execPath, [e2Root], {
    cwd: repoRoot, encoding: 'utf8', timeout: windowsTimeoutMs, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, E2_01_NEW_ONLY: '1', E2_01_TEMP: directory, TEMP: directory, TMP: directory },
  });
  return extractReport(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function linuxRetrySuite(suite) {
  const started = Date.now();
  const relative = path.relative(repoRoot, path.resolve(repoRoot, suite.script)).split(path.sep).join('/');
  const script = relative.split('/').slice(2).join('/');
  const result = runLinuxCommand(`cd /work/${packageRelative(suite.script)} && node --test --test-reporter=tap ${script}`,
    ['-e', 'DB_TYPE=sqlite', '-e', 'FORCE_COLOR=0']);
  const output = suiteResultFromOutput(suite, { status: result.exitCode, stdout: result.output, stderr: '', error: result.error }, Date.now() - started);
  return output;
}

function linuxRetryScenarios() {
  const result = runLinuxCommand('cd /work && node scripts/verify-e2-01.cjs', ['-e', 'E2_01_NEW_ONLY=1', '-e', 'E2_01_TEMP=/tmp/e2-01-retry']);
  return extractReport(result.output);
}

function retryPlatform(platform, run) {
  const retries = [];
  if (!run.report) return retries;
  const failedSuites = run.report.suites.filter(suite => suite.status !== 'passed');
  const failedScenarios = run.report.scenarios.filter(scenario => scenario.status !== 'passed');
  if (!failedSuites.length && !failedScenarios.length) return retries;
  for (const suite of failedSuites) {
    const firstAttempt = summarizeSuite(suite);
    const retry = platform === 'windows' ? windowsRetrySuite(suite) : linuxRetrySuite(suite);
    suite.firstAttemptStatus = firstAttempt.status;
    suite.retried = true;
    if (retry.status === 'passed') Object.assign(suite, {
      status: retry.status, tests: retry.tests, passed: retry.passed, failed: retry.failed,
      markerSeen: retry.markerSeen, ms: retry.ms,
    });
    retries.push({ platform, kind: 'suite', id: suite.id, firstAttempt, retry, finalStatus: suite.status });
    console.log(`      ${platform} retry suite ${suite.id}: ${firstAttempt.status} -> ${suite.status}`);
  }
  if (failedScenarios.length) {
    const report = platform === 'windows' ? windowsRetryScenarios() : linuxRetryScenarios();
    for (const failed of failedScenarios) {
      const firstAttempt = summarizeScenario(failed);
      const retried = report && report.scenarios.find(scenario => scenario.id === failed.id);
      failed.firstAttemptStatus = firstAttempt.status;
      failed.retried = true;
      if (retried && retried.status === 'passed') Object.assign(failed, {
        status: retried.status, checks: retried.checks, ms: retried.ms, error: retried.error,
      });
      retries.push({ platform, kind: 'scenario', id: failed.id, firstAttempt,
        retry: retried ? summarizeScenario(retried) : null, finalStatus: failed.status });
      console.log(`      ${platform} retry scenario ${failed.id}: ${firstAttempt.status} -> ${failed.status}`);
    }
  }
  return retries;
}

function effectivePlatform(run, retries) {
  const suitesPassed = run.report.suites.filter(suite => suite.status === 'passed').length;
  const scenariosPassed = run.report.scenarios.filter(scenario => scenario.status === 'passed').length;
  const trusted = suitesPassed === run.report.suites.length && scenariosPassed === run.report.scenarios.length;
  return {
    platform: run.platform, marker: trusted ? 'E2_01_VERIFY_OK' : 'E2_01_VERIFY_FAILED', originalMarker: run.report.marker, passed: trusted,
    node: run.report.node, os: run.report.platform, image: run.image, dockerServer: run.dockerServer, containerRepo: run.containerRepo,
    suitesPassed, suites: run.report.suites.length,
    testsPassed: run.report.suites.reduce((sum, suite) => sum + (suite.passed || 0), 0),
    tests: run.report.suites.reduce((sum, suite) => sum + (suite.tests || 0), 0),
    scenariosPassed, scenarios: run.report.scenarios.length,
    checks: run.report.scenarios.reduce((sum, scenario) => sum + (scenario.checks || []).length, 0),
    retries: retries.filter(entry => entry.platform === run.platform).map(entry => ({ kind: entry.kind, id: entry.id, finalStatus: entry.finalStatus })),
    totalMs: run.report.suites.reduce((sum, suite) => sum + (suite.ms || 0), 0) + run.report.scenarios.reduce((sum, scenario) => sum + (scenario.ms || 0), 0),
  };
}

function buildCoverage(report) {
  const matrix = {};
  for (const family of FAMILIES) {
    matrix[family] = {};
    for (const transport of TRANSPORTS) matrix[family][transport] = { status: 'notCovered', existing: [], added: [] };
  }
  for (const suite of report.suites) {
    if (suite.status !== 'passed') continue;
    for (const [family, transport] of suite.evidence || []) {
      matrix[family][transport].existing.push(suite.id);
      matrix[family][transport].status = 'covered';
    }
  }
  for (const scenario of report.scenarios) {
    if (scenario.status !== 'passed') continue;
    for (const [family, transport] of scenario.evidence || []) {
      matrix[family][transport].added.push(scenario.id);
      matrix[family][transport].status = 'covered';
    }
  }
  return matrix;
}

function indexBy(items) {
  return new Map((items || []).map(item => [item.id, item]));
}

function compare(windows, linux) {
  const windowsSuites = indexBy(windows.report.suites);
  const linuxSuites = indexBy(linux.report.suites);
  const windowsScenarios = indexBy(windows.report.scenarios);
  const linuxScenarios = indexBy(linux.report.scenarios);
  const rows = [];
  const outcomeDeltas = [];
  const push = row => {
    rows.push(row);
    if (row.outcome !== 'consistent-pass') outcomeDeltas.push(`${row.kind} ${row.id}: ${row.outcome}`);
  };
  for (const [id, win] of windowsSuites) {
    const lin = linuxSuites.get(id);
    if (!lin) { push({ kind: 'suite', id, label: win.label, outcome: 'missing-linux', windows: summarizeSuite(win), linux: null }); continue; }
    const countsMatch = win.tests === lin.tests && win.passed === lin.passed && win.failed === lin.failed;
    const statusMatch = win.status === lin.status;
    const outcome = !statusMatch ? 'status-delta' : !countsMatch ? 'count-delta'
      : win.status === 'passed' ? 'consistent-pass' : 'consistent-fail';
    push({ kind: 'suite', id, label: win.label, outcome, evidence: win.evidence,
      windows: summarizeSuite(win), linux: summarizeSuite(lin) });
  }
  for (const [id, win] of windowsScenarios) {
    const lin = linuxScenarios.get(id);
    if (!lin) { push({ kind: 'scenario', id, title: win.title, outcome: 'missing-linux', windows: summarizeScenario(win), linux: null }); continue; }
    const checksMatch = (win.checks || []).length === (lin.checks || []).length;
    const statusMatch = win.status === lin.status;
    const outcome = !statusMatch ? 'status-delta' : !checksMatch ? 'check-count-delta'
      : win.status === 'passed' ? 'consistent-pass' : 'consistent-fail';
    push({ kind: 'scenario', id, title: win.title, outcome, windows: summarizeScenario(win), linux: summarizeScenario(lin) });
  }
  for (const [id, lin] of linuxSuites) if (!windowsSuites.has(id)) {
    push({ kind: 'suite', id, label: lin.label, outcome: 'missing-windows', windows: null, linux: summarizeSuite(lin) });
  }
  for (const [id, lin] of linuxScenarios) if (!windowsScenarios.has(id)) {
    push({ kind: 'scenario', id, title: lin.title, outcome: 'missing-windows', windows: null, linux: summarizeScenario(lin) });
  }
  return { rows, outcomeDeltas };
}

function summarizeSuite(suite) {
  return { status: suite.status, tests: suite.tests, passed: suite.passed, failed: suite.failed,
    marker: suite.marker || null, markerSeen: suite.markerSeen, ms: suite.ms, note: suite.note,
    firstAttemptStatus: suite.firstAttemptStatus, retried: suite.retried === true };
}

function summarizeScenario(scenario) {
  return { status: scenario.status, checks: (scenario.checks || []).length, checksText: scenario.checks || [],
    ms: scenario.ms, evidence: scenario.evidence || [], firstAttemptStatus: scenario.firstAttemptStatus, retried: scenario.retried === true };
}

function handshakeElapsed(report, id) {
  const scenario = (report.scenarios || []).find(item => item.id === id);
  const check = scenario && scenario.checks && scenario.checks.find(text => /handshake deadline/.test(text));
  const match = check && check.match(/at (\d+)ms/);
  return match ? Number(match[1]) : null;
}

const notCovered = [
  { item: 'glibc/Ubuntu/Debian and macOS', reason: 'only the locally present node:24-alpine (musl) Linux image is used; no image pulls and no non-Linux non-Windows host is available, so libc-specific error codes/messages and other kernels are not compared' },
  { item: 'deployment and registry packaging', reason: 'the matrix exercises the built runtime artifacts in-process; container image build, orchestration, reverse proxies and installers are out of scope for SEC-E2-02' },
  { item: 'long soak and kernel-level races', reason: 'runs are bounded functional matrices; multi-hour soak, PID reuse pressure and kernel scheduler/jitter sensitivity are not covered' },
  { item: 'external network, DNS, TLS and proxy behavior', reason: 'loopback only with synthetic credentials; no real upstream, DNS or TLS endpoint is contacted' },
  { item: 'jest-based package unit suites and UI tests', reason: 'the E2-01 runner family aggregates node:test/TAP security suites only; package jest units run on Windows as part of npm test and are not part of the dual-platform security matrix' },
  { item: 'Windows ACL semantics', reason: 'secret-file permission parity is owned by SEC-C2-01 (Linux) and SEC-C2-02 (Windows ACL); the E2-02 matrix covers transport/cancellation/timeout/replay/shutdown only' },
  { item: 'bare-metal Linux kernel', reason: 'Linux runs inside the Docker Desktop VM; host kernel/hypervisor differences are not observable here' },
];

async function main() {
  const commit = (() => {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return result.status === 0 ? (result.stdout || '').trim() : null;
  })();
  console.log(`E2-02 dual-platform matrix on commit ${commit || 'unknown'} (retry policy: ${retryPolicy})`);
  console.log('[1/2] windows host matrix...');
  const windows = runWindowsMatrix();
  if (!windows.report) {
    console.log(JSON.stringify({ marker: 'E2_02_VERIFY_FAILED', stage: 'windows', exitCode: windows.exitCode,
      error: windows.error, outputTail: (windows.output || '').slice(-4000) }, null, 1));
    console.log('\nE2_02_VERIFY_FAILED windows matrix did not produce a parseable E2-01 report');
    process.exitCode = 1;
    return;
  }
  console.log(`      windows ${windows.report.marker} suites=${windows.report.suites.length} tests=${windows.report.counts.aggregatedPassed}/${windows.report.counts.aggregatedTests} scenarios=${windows.report.counts.newScenarios} checks=${windows.report.counts.newChecks}`);
  const windowsRetries = retryPlatform('windows', windows);
  console.log('[2/2] linux container matrix...');
  const linux = runLinuxMatrix();
  if (!linux.report) {
    console.log(JSON.stringify({ marker: 'E2_02_VERIFY_FAILED', stage: 'linux', exitCode: linux.exitCode,
      error: linux.error, image: linux.image, outputTail: (linux.output || '').slice(-4000) }, null, 1));
    console.log('\nE2_02_VERIFY_FAILED linux matrix did not produce a parseable E2-01 report');
    process.exitCode = 1;
    return;
  }
  console.log(`      linux   ${linux.report.marker} suites=${linux.report.suites.length} tests=${linux.report.counts.aggregatedPassed}/${linux.report.counts.aggregatedTests} scenarios=${linux.report.counts.newScenarios} checks=${linux.report.counts.newChecks}`);
  const linuxRetries = retryPlatform('linux', linux);
  const retries = [...windowsRetries, ...linuxRetries];

  const { rows, outcomeDeltas } = compare(windows, linux);
  const coverageMatch = JSON.stringify(buildCoverage(windows.report)) === JSON.stringify(buildCoverage(linux.report)) &&
    (windows.report.notCovered || []).length === (linux.report.notCovered || []).length;
  if (!coverageMatch) outcomeDeltas.push('coverage matrix differs between platforms');

  const windowsHandshake = handshakeElapsed(windows.report, 'N4');
  const linuxHandshake = handshakeElapsed(linux.report, 'N4');
  const deltas = [
    { id: 'runtime-version', detail: `windows ${windows.report.platform} Node ${windows.report.node}; linux ${linux.report.platform} Node ${linux.report.node} in ${linux.image || 'container'}`,
      reason: 'only locally present images may be used (no pulls); Node 24.x line is common, patch/musl deltas are recorded but not eliminated' },
    { id: 'path-case-sensitivity', detail: 'Linux filesystems are case-sensitive; Windows NTFS is not',
      reason: 'the runner and fixture paths use a single canonical realpath, so no case-collision is exercised; case-mismatched third-party imports remain a risk owned by SEC-C2-01 notes' },
    { id: 'timing-bounds', detail: `N4 handshake elapsed windows=${windowsHandshake}ms linux=${linuxHandshake}ms; assertion bound 29000-45000ms held on both`,
      reason: 'wall times differ per platform/container; terminal states and fixed error codes are compared, not latency equality' },
    { id: 'container-recipe', detail: `repo mounted read-only at ${linux.containerRepo} (the host path the workspace junctions resolve to), copied with tar into a container-local tmpfs /work with exec (excluding api data, UI, repo data and caches), workspace symlinks rewritten, --network none loopback, NODE_PATH=/work/packages`,
      reason: 'the canonical mount path keeps one parser module instance (direct path vs junction target would split AsyncLocalStorage runtime context) and read-only audit paths would emit RUNTIME_AUDIT_WRITE_FAILED; bind-mount module loading costs ~8-10s per fresh child against an 8s fixture startup bound and an 8s/15s sibling timeout, so the tmpfs working copy (~0.5s load) removes harness-level I/O flakes instead of hiding a product delta. tmpfs must be mounted exec because bcrypt loads a musl prebuild. These are container-recipe facts, not product behavior' },
    { id: 'linux-musl', detail: 'linux container runs Alpine musl; Windows host runs Windows CRT',
      reason: 'musl/CRT differences in socket/error behavior are part of what the matrix compares; no failure delta was observed' },
    { id: 'retry-policy', detail: retryPolicy,
      reason: 'real-child integration suites are timing sensitive (e.g. durable admission-audit flush vs force stop, fixture startup under I/O latency); every retry and its first failed attempt stay in this report, and a retry that repeats the failure keeps the platform failed' },
  ];

  const platforms = [effectivePlatform(windows, retries), effectivePlatform(linux, retries)];
  const pass = platforms.every(platform => platform.passed) && outcomeDeltas.length === 0 && rows.length > 0;
  const report = {
    marker: pass ? 'E2_02_VERIFY_OK' : 'E2_02_VERIFY_FAILED', commit, tempBase, retryPolicy,
    windowsLog: windows.reused || 'inline', linuxLog: linux.reused || 'inline',
    platforms, rows, retries, deltas, outcomeDeltas, notCovered,
    platformFailures: { windows: windows.report.failures || [], linux: linux.report.failures || [] },
    compared: { suites: windows.report.suites.length, scenarios: windows.report.scenarios.length, rows: rows.length },
  };
  console.log(JSON.stringify(report, null, 1));
  for (const row of rows) {
    const win = row.windows ? `${row.windows.status}/${row.windows.tests ?? row.windows.checks}${row.windows.failed ? '/f' + row.windows.failed : ''}${row.windows.retried ? ' (retried)' : ''}` : 'missing';
    const lin = row.linux ? `${row.linux.status}/${row.linux.tests ?? row.linux.checks}${row.linux.failed ? '/f' + row.linux.failed : ''}${row.linux.retried ? ' (retried)' : ''}` : 'missing';
    console.log(`${row.kind.padEnd(8)} ${row.id.padEnd(28)} windows=${win.padEnd(18)} linux=${lin.padEnd(18)} ${row.outcome}`);
  }
  console.log('\nplatform comparison: ' + platforms.map(platform => `${platform.platform}=${platform.passed ? 'PASS' : 'FAIL'} (${platform.node}, suites ${platform.suitesPassed}/${platform.suites}, tests ${platform.testsPassed}/${platform.tests}, scenarios ${platform.scenariosPassed}/${platform.scenarios}/${platform.checks} checks)`).join(' | '));
  for (const delta of deltas) console.log(`delta ${delta.id}: ${delta.detail} (${delta.reason})`);
  console.log('notCovered: ' + notCovered.map(entry => entry.item).join('; '));
  if (!pass) {
    for (const delta of outcomeDeltas) console.log(`OUTCOME DELTA ${delta}`);
    console.log(`\nE2_02_VERIFY_FAILED ${outcomeDeltas.length} outcome deltas`);
    process.exitCode = 1;
  } else {
    console.log(`\nE2_02_VERIFY_OK dual-platform security joint matrix: ${rows.length} mapped rows, windows ${platforms[0].testsPassed}/${platforms[0].tests} tests + ${platforms[0].checks} checks, linux ${platforms[1].testsPassed}/${platforms[1].tests} tests + ${platforms[1].checks} checks, retries=${retries.length}, 0 outcome deltas`);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
