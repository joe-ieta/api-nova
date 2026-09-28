'use strict';
// SEC-F1-02C3G5: Gateway proof guard completion and registration. Runs the
// changed/new Gateway Runtime specs, then reports a failure-gated marker. Every
// scenario is local loopback/SQL.js with synthetic credentials; no external
// network and no production Verified/Publication activation is exercised.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const tempBase = process.env.F1_02C3G5_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'f1-02c3g5');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const reportFile = path.join(tempRoot, 'jest-report.json');
const cacheDirectory = path.join(tempRoot, 'jest-cache');

const specs = [
  'src/modules/gateway-runtime/services/gateway-upstream-proof-execution.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-request-capability.provider.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-authority.lifecycle.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-execution.wiring.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-execution.wiring.http.spec.ts',
];

const notCovered = [
  'PostgreSQL: the same-process authority lifecycle persistence is verified on SQL.js only; the production PostgreSQL evidence store is not exercised by this runner.',
  'Production host installation: the default-off module provider is overridden only by an explicit test/host composition; no real host challenge/session issuer event source or management HTTP proof-request endpoint is wired.',
  'Publication activation and Verified readiness remain closed: canPublish stays false and no publication entry point is invoked.',
  'MCP/child real-time revocation and cross-process proof transport are SEC-F1-02C3G6 scope and are not exercised.',
  'Cross-process/multi-instance authority lifecycle: same-process only (single Node instance).',
  'Windows Node only in this runner.',
];

const failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push(name + (detail ? ` (${detail})` : ''));
}

let jestBin;
try {
  jestBin = require.resolve('jest/bin/jest');
} catch {
  try { jestBin = require.resolve('jest/bin/jest', { paths: [apiRoot] }); } catch { jestBin = undefined; }
}

let status = 1;
if (!jestBin) {
  failures.push('jest binary could not be resolved');
} else {
  const result = spawnSync(process.execPath, [jestBin, '--runInBand', '--json', '--outputFile', reportFile,
    '--cacheDirectory', cacheDirectory, ...specs], { cwd: apiRoot, env: process.env, stdio: 'inherit' });
  status = result.status === null ? 1 : result.status;
}

let report;
if (status === 0) {
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (error) {
    failures.push(`jest report unreadable: ${String((error && error.message) || error)}`);
  }
}

if (report) {
  check('no failed test suites', report.numFailedTestSuites === 0, String(report.numFailedTestSuites));
  check('no failed tests', report.numFailedTests === 0, String(report.numFailedTests));
  check('tests executed', report.numPassedTests > 0, String(report.numPassedTests));
  const executed = new Set((report.testResults || []).map(item => path.resolve(item.name || '')));
  for (const spec of specs) check(`spec executed: ${spec}`, executed.has(path.resolve(apiRoot, spec)));
  for (const item of report.testResults || []) {
    check(`suite passed: ${path.basename(item.name || '')}`, item.status === 'passed', item.message);
  }
} else if (status === 0) {
  failures.push('jest succeeded without a parseable report');
} else {
  failures.push(`jest exited with status ${status}`);
}

const counts = report ? {
  suites: { total: report.numTotalTestSuites, passed: report.numPassedTestSuites, failed: report.numFailedTestSuites },
  tests: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests + report.numTodoTests },
} : null;

const output = {
  marker: failures.length ? 'F1_02C3G5_VERIFY_FAILED' : 'F1_02C3G5_VERIFY_OK',
  workPackage: 'SEC-F1-02C3G5',
  purpose: 'Gateway proof consumer guard registration with same-process host authority lifecycle and request-bound capability provider',
  platform: process.platform,
  node: process.version,
  tempRoot,
  trustedMode: 'default-off; the production Gateway module keeps a null proof execution provider; this runner overrides it only in explicit test composition',
  localOnly: 'loopback upstream and SQL.js persistence only; synthetic-only secrets; no external network',
  verifiedOpen: false,
  publicationEntrypointsChanged: false,
  counts,
  notCovered,
  failures,
};
console.log(JSON.stringify(output, null, 2));
if (failures.length) {
  console.log(`\nF1_02C3G5_VERIFY_FAILED ${failures.length} failing check(s): ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nF1_02C3G5_VERIFY_OK ${counts.suites.passed}/${counts.suites.total} suites, ${counts.tests.passed}/${counts.tests.total} tests ` +
    `(${counts.tests.skipped} skipped), ${process.platform} Node ${process.version}`);
}
