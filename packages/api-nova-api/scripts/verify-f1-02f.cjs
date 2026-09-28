'use strict';
// SEC-F1-02F: dual-runtime end-to-end, persistence reopen (SQL.js + isolated PostgreSQL),
// concurrency/late arrivals and same-revision Provider change. Aggregates the F1-02D/G5/G6
// suites plus the new F1-02F specs, then runs the disposable PostgreSQL acceptance.
// Every scenario is loopback-only with synthetic credentials; no external network.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const tempBase = process.env.F1_02F_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'f1-02f');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const reportFile = path.join(tempRoot, 'jest-report.json');
const cacheDirectory = path.join(tempRoot, 'jest-cache');
const pgTemp = path.join(tempRoot, 'pg');
fs.mkdirSync(pgTemp, { recursive: true });
process.env.F1_02F_TEMP = pgTemp;

const specs = [
  'src/modules/publication/services/publication-f1-02f-persistence.spec.ts',
  'src/modules/publication/services/publication-f1-02f-dual-runtime.http.spec.ts',
  'src/modules/publication/services/publication-security-evaluation.spec.ts',
  'src/modules/publication/services/publication-member-transaction-writer.spec.ts',
  'src/modules/publication/services/publication-batch-candidate-executor.spec.ts',
  'src/modules/publication/security/upstream-security-capabilities.spec.ts',
  'src/modules/publication/security/upstream-security-import.spec.ts',
  'src/modules/publication/security/upstream-security-mcp-runtime.spec.ts',
  'src/modules/publication/security/endpoint-upstream-security-readiness.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-security-runtime.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-execution.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-execution.wiring.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-proof-authority.lifecycle.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-request-capability.provider.spec.ts',
  'src/modules/servers/services/managed-mcp-channel.permit.spec.ts',
  'src/modules/servers/services/managed-mcp-channel.authorization.spec.ts',
  'src/modules/servers/services/managed-execution-permit-authority.spec.ts',
  'src/modules/servers/services/managed-child-security-lease-coordinator.spec.ts',
];

const notCovered = [
  'Cross-process publication race: the two-connection race runs on one isolated cluster inside one process; multi-process generation ownership on PostgreSQL is covered by verify:c3-03, not repeated here.',
  'Real external secret providers: the same-revision Provider change uses an injected trusted provider (default-off by design); no external vault/network.',
  'Verified/publication opening: G2 canPublish stays false and no production publication readiness entry point is opened or registered.',
  'Managed MCP child IPC permits: exercised by verify:f1-02c3g6 and verify:f1-02e3b; this runner covers the MCP HTTP handler path with real Streamable HTTP.',
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

// Disposable PostgreSQL acceptance: persisted activation/guard/membership state across
// reopen, revocation persistence, zero drift and a single concurrent revision winner.
let pgReport;
const pg = spawnSync(process.execPath, ['scripts/test-isolated-postgres-f1-02f.cjs'],
  { cwd: apiRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const pgOutput = `${pg.stdout || ''}\n${pg.stderr || ''}`;
if (pg.status !== 0) {
  failures.push(`isolated PostgreSQL acceptance exited with status ${pg.status === null ? 'null' : pg.status}: ${pgOutput.slice(-4000)}`);
} else {
  const line = pgOutput.split(/\r?\n/).find(entry => entry.startsWith('{"marker":"ISOLATED_POSTGRES_F1_02F_OK"'));
  if (!line) {
    failures.push('isolated PostgreSQL acceptance printed no ISOLATED_POSTGRES_F1_02F_OK report');
  } else {
    try { pgReport = JSON.parse(line); } catch (error) { failures.push(`isolated PostgreSQL report unreadable: ${String(error && error.message)}`); }
  }
}
if (pgReport) {
  check('postgres reopen persisted state', pgReport.reopen === true);
  check('postgres zero schema drift', pgReport.schemaDrift === 0, String(pgReport.schemaDrift));
  check('postgres revocation persistence', pgReport.revocations === true);
  check('postgres gateway publication persistence', pgReport.gatewayPublication === true);
  check('postgres MCP publication persistence', pgReport.mcpPublication === true);
  check('postgres zero writes after rejected late publish', pgReport.zeroWritesAfterReject === true);
  check('postgres concurrent revision has exactly one winner', pgReport.concurrency?.winners === 1, JSON.stringify(pgReport.concurrency));
  check('postgres concurrent revision has exactly one loser', pgReport.concurrency?.losers === 1, JSON.stringify(pgReport.concurrency));
  check('postgres concurrent revision advanced once', pgReport.concurrency?.revision === 2, JSON.stringify(pgReport.concurrency));
  check('postgres cluster stopped', pgReport.clusterStopped === true);
  check('postgres cluster removed', pgReport.clusterRemoved === true);
}

if (process.env.F1_02F_FORCE_FAIL === '1') failures.push('injected failure (F1_02F_FORCE_FAIL)');

const counts = report ? {
  suites: { total: report.numTotalTestSuites, passed: report.numPassedTestSuites, failed: report.numFailedTestSuites },
  tests: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests + report.numTodoTests },
} : null;
const checks = {
  jestSpecs: specs.length,
  postgres: pgReport ? { serverVersion: pgReport.serverVersion, entities: pgReport.entities, domainTables: pgReport.domainTables,
    migrations: pgReport.migrations, concurrency: pgReport.concurrency } : null,
};

const output = {
  marker: failures.length ? 'F1_02F_VERIFY_FAILED' : 'F1_02F_VERIFY_OK',
  workPackage: 'SEC-F1-02F',
  purpose: 'dual-runtime end-to-end, SQL.js/PostgreSQL reopen, concurrency/late arrivals and same-revision Provider change',
  platform: process.platform,
  node: process.version,
  tempRoot,
  trustedMode: 'default-off providers are overridden only in explicit test composition; Verified/publication activation stays closed',
  localOnly: 'loopback upstream/MCP and isolated SQL.js/PostgreSQL only; synthetic-only secrets; no external network',
  verifiedOpen: false,
  publicationEntrypointsChanged: false,
  counts,
  checks,
  notCovered,
  failures,
};
console.log(JSON.stringify(output, null, 2));
if (failures.length) {
  console.log(`\nF1_02F_VERIFY_FAILED ${failures.length} failing check(s): ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nF1_02F_VERIFY_OK ${counts.suites.passed}/${counts.suites.total} suites, ${counts.tests.passed}/${counts.tests.total} tests ` +
    `(${counts.tests.skipped} skipped), PostgreSQL ${checks.postgres.serverVersion} concurrency ${JSON.stringify(checks.postgres.concurrency)}, ` +
    `${process.platform} Node ${process.version}`);
}
