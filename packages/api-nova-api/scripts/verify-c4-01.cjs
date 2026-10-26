'use strict';
// SEC-C4-01: runtime Resolver execution semantics joint validation. Aggregates
// the authoritative Resolver/Gateway/MCP suites, the managed handoff scripts and
// the real-child E1-03 matrix, and adds the C4-01 joint Gateway/MCP scenarios.
// All traffic is loopback-only with synthetic secrets; no external network.
process.env.DB_TYPE = 'sqlite';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const parserRoot = path.resolve(apiRoot, '..', 'api-nova-parser');
const tempBase = process.env.C4_01_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'c4-01');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;

const apiSpecs = [
  'src/modules/gateway-runtime/services/credential-execution-semantics.c4-01.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.spec.ts',
  'src/modules/gateway-runtime/services/gateway-credential-types.http.spec.ts',
  'src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts',
  'src/modules/gateway-runtime/services/gateway-upstream-security-runtime.http.spec.ts',
  'src/modules/publication/services/publication-f1-02f-dual-runtime.http.spec.ts',
  'src/modules/publication/security/upstream-security-mcp-runtime.spec.ts',
  'src/modules/publication/security/upstream-security-binding-evaluator.spec.ts',
];

const parserSpecs = [
  'src/credentials/resolver.spec.ts',
  'src/credentials/credential-types.spec.ts',
  'src/credentials/single-hop-execution.test.ts',
  'src/credentials/trusted-operation-bindings.test.ts',
  'src/security/upstream-security-runtime.test.ts',
];

const managedSuites = [
  { label: 'managed handoff preparation', script: path.join(apiRoot, 'scripts', 'test-managed-mcp-handoff-preparation.cjs') },
  { label: 'managed mcp channel', script: path.join(apiRoot, 'scripts', 'test-managed-mcp-channel.cjs') },
];
const managedMatrix = path.join(apiRoot, 'scripts', 'verify-e1-03.cjs');

const notCovered = [
  'Real external secret providers/vaults: only the env provider with synthetic values is exercised; no external network.',
  'Managed child IPC permits and running revocation: covered by verify:f1-02c3g6 and verify:f1-02e3b; this runner aggregates the E1-03 real-child matrix for the managed MCP runtime path.',
  'PostgreSQL persistence: this runner is SQL.js/loopback only; the isolated PostgreSQL reopen/concurrency acceptance is verify:f1-02f scope.',
  'Verified/Publication activation stays closed: canPublish stays false and no production publication entry point is registered or invoked.',
  'The aggregated E1-03 real-child matrix requires fresh api-nova-server/api-nova-parser dist and fails closed on stale artifacts; this runner does not build them.',
  'Windows Node only in this runner.',
];

function check(name, condition, detail) {
  if (!condition) failures.push(name + (detail ? ` (${detail})` : ''));
}

const failures = [];

function resolveJest(root) {
  try { return require.resolve('jest/bin/jest', { paths: [root] }); } catch { return undefined; }
}

function runJest(label, root, specs, tag) {
  const jestBin = resolveJest(root);
  if (!jestBin) { failures.push(`${label}: jest binary could not be resolved`); return null; }
  const reportFile = path.join(tempRoot, `${tag}-jest-report.json`);
  const cacheDirectory = path.join(tempRoot, `${tag}-jest-cache`);
  const result = spawnSync(process.execPath, [jestBin, '--runInBand', '--json', '--outputFile', reportFile,
    '--cacheDirectory', cacheDirectory, ...specs], { cwd: root, env: process.env, stdio: 'inherit' });
  const status = result.status === null ? 1 : result.status;
  let report;
  if (status === 0) {
    try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (error) {
      failures.push(`${label}: jest report unreadable: ${String((error && error.message) || error)}`);
    }
  }
  if (report) {
    check(`${label}: no failed test suites`, report.numFailedTestSuites === 0, String(report.numFailedTestSuites));
    check(`${label}: no failed tests`, report.numFailedTests === 0, String(report.numFailedTests));
    check(`${label}: tests executed`, report.numPassedTests > 0, String(report.numPassedTests));
    const executed = new Set((report.testResults || []).map(item => path.resolve(item.name || '')));
    for (const spec of specs) check(`${label}: spec executed ${spec}`, executed.has(path.resolve(root, spec)));
    for (const item of report.testResults || []) {
      check(`${label}: suite passed ${path.basename(item.name || '')}`, item.status === 'passed', item.message);
    }
  } else if (status === 0) {
    failures.push(`${label}: jest succeeded without a parseable report`);
  } else {
    failures.push(`${label}: jest exited with status ${status}`);
  }
  return report ? {
    suites: { total: report.numTotalTestSuites, passed: report.numPassedTestSuites, failed: report.numFailedTestSuites },
    tests: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
      skipped: report.numPendingTests + report.numTodoTests },
    specs: specs.length,
  } : null;
}

function runTapSuite(label, script, timeout) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', script],
    { cwd: apiRoot, env: process.env, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counter = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = counter('tests'), passed = counter('pass'), failed = counter('fail');
  check(`${label}: exit 0`, result.status === 0, `status ${result.status === null ? 'null' : result.status}`);
  check(`${label}: tests executed`, Number.isInteger(tests) && tests > 0, String(tests));
  check(`${label}: zero failures`, failed === 0, String(failed));
  return { label, script: path.relative(repoRoot, script).replace(/\\/g, '/'), tests, passed, failed };
}

function runManagedMatrix() {
  const result = spawnSync(process.execPath, ['scripts/verify-e1-03.cjs'],
    { cwd: apiRoot, env: process.env, encoding: 'utf8', timeout: 900000, maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const markerSeen = output.includes('E1_03_VERIFY_OK');
  const counter = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  check('managed child matrix: E1_03_VERIFY_OK', result.status === 0 && markerSeen,
    `status ${result.status === null ? 'null' : result.status} marker ${markerSeen}`);
  return { markerSeen, marker: 'E1_03_VERIFY_OK', exitStatus: result.status,
    tests: counter('tests'), passed: counter('pass'), failed: counter('fail') };
}

const apiReport = runJest('api', apiRoot, apiSpecs, 'api');
const parserReport = runJest('parser', parserRoot, parserSpecs, 'parser');
const nodeSuites = managedSuites.map(suite => runTapSuite(suite.label, suite.script, 300000));
const childMatrix = runManagedMatrix();

if (process.env.C4_01_FORCE_FAIL === '1') failures.push('injected failure (C4_01_FORCE_FAIL)');

const counts = {
  apiJest: apiReport,
  parserJest: parserReport,
  managedNodeSuites: nodeSuites,
  managedChildMatrix: childMatrix,
};

const output = {
  marker: failures.length ? 'C4_01_VERIFY_FAILED' : 'C4_01_VERIFY_OK',
  workPackage: 'SEC-C4-01',
  purpose: 'runtime Resolver execution semantics joint validation: Site/Endpoint inheritance, override, None and Unresolved pre-network rejection across Gateway and MCP',
  platform: process.platform,
  node: process.version,
  tempRoot,
  localOnly: 'loopback upstream/Gateway/MCP only; synthetic-only secrets; SQL.js; no external network',
  resolverRewritten: false,
  productionSourceChanged: false,
  verifiedOpen: false,
  publicationEntrypointsChanged: false,
  jointScenarios: [
    'Site/Endpoint inheritance applied identically on Gateway and MCP for the same binding',
    'Endpoint override wins and the inherited secret never reaches the upstream on either runtime',
    'None sends no credential and never falls back to consumer/ambient/legacy/custom values on either runtime',
    'Removed provider row denied before secret read, network and cache on both runtimes with fixed codes and no partial state',
    'Policy-unresolved, scope-mismatch and site-not-found denied before secret read, network and cache on both runtimes',
    'Unsupported provider reference rejected at activation with the active snapshot preserved',
    'Default-off parity keeps legacy paths unchanged and trusted semantics opt-in',
  ],
  counts,
  notCovered,
  failures,
};
console.log(JSON.stringify(output, null, 2));
if (failures.length) {
  console.log(`\nC4_01_VERIFY_FAILED ${failures.length} failing check(s): ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nC4_01_VERIFY_OK api ${counts.apiJest.suites.passed}/${counts.apiJest.suites.total} suites ` +
    `${counts.apiJest.tests.passed}/${counts.apiJest.tests.total} tests; parser ${counts.parserJest.suites.passed}/${counts.parserJest.suites.total} suites ` +
    `${counts.parserJest.tests.passed}/${counts.parserJest.tests.total} tests; managed suites ${nodeSuites.map(suite => `${suite.passed}/${suite.tests}`).join(' + ')}; ` +
    `E1-03 real-child matrix ${childMatrix.markerSeen ? 'OK' : 'MISSING'}; ${process.platform} Node ${process.version}`);
}
