// OBS-15-02 local full-chain identity and switchover validation runner.
// Runs a bounded, locally runnable subset of the real call-observability TAP scripts
// (SQL.js / loopback only), statically checks that the retired legacy caller entry has
// no alias or fallback, and emits one OBS_15_FULL_CHAIN_OK JSON line.
// PostgreSQL, Linux-only and real external receiver suites are listed as skipped with
// explicit reasons and are NOT claimed as verified by this runner.
'use strict';
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages/api-nova-api');
const scriptsDir = path.join(apiCwd, 'scripts');
const buildCommand = 'npm run build --workspace api-nova-parser && npm run build --workspace api-nova-api';
const scriptTimeoutMs = 180000;

// The Nest build in this workspace emits dist/src/main.js (sourceRoot "src");
// packages/api-nova-api/dist/index.js is accepted if a future layout ever produces it.
const apiBuildEntries = [
  'packages/api-nova-api/dist/src/main.js',
  'packages/api-nova-api/dist/index.js',
];
const requiredBuiltFiles = [
  'packages/api-nova-parser/dist/index.js',
  'packages/api-nova-api/dist/src/common/http-api-paths.js',
  'packages/api-nova-api/dist/src/database/entities/runtime-call-observability.entity.js',
  'packages/api-nova-api/dist/src/database/entities/runtime-observability-event.entity.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability.store.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability-command.store.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability-cursor.service.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability-deliveries.service.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability-events.service.js',
  'packages/api-nova-api/dist/src/modules/call-observability/call-observability-invocations.service.js',
];

const executedScripts = [
  'test-gateway-call-observability.cjs',
  'test-call-observability-events.cjs',
  'test-call-observability-deliveries.cjs',
  'test-call-observability-invocations.cjs',
  'test-call-observability-realtime.cjs',
  'test-call-observability-overview.cjs',
];
const skippedScripts = [
  {
    script: 'test-call-observability-postgres.cjs',
    reason: 'requires a live PostgreSQL server (DB_TYPE=postgres, pg client); this runner is SQL.js/loopback only',
  },
  {
    script: 'test-call-observability-payload-pg-multiwriter.cjs',
    reason: 'requires a live PostgreSQL cluster for multi-writer payload fencing; this runner is SQL.js/loopback only',
  },
];

const monitoringControllerPath = 'packages/api-nova-api/src/modules/monitoring/monitoring.controller.ts';
const parserRuntimeAuditPath = 'packages/api-nova-parser/src/audit/runtime-call-audit.ts';
const visitorsControllerPath = 'packages/api-nova-api/src/modules/call-observability/call-observability-visitors.controller.ts';

const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const count = (output, name) => Number([...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].pop()?.[1] ?? 0);

function fail(message, extra) {
  console.error(`[verify-obs-15-full-chain] ${message}`);
  const payload = { marker: 'OBS_15_FULL_CHAIN_FAIL', workPackage: 'OBS-15-02', message };
  if (extra !== undefined) payload.details = extra;
  console.error(JSON.stringify(payload));
  process.exit(1);
}

function requireFile(relative, hint) {
  const absolute = path.join(repository, relative);
  if (!fs.existsSync(absolute)) fail(`Missing prerequisite ${relative}. ${hint}`);
  return absolute;
}

function assertAbsent(relative, token) {
  const content = fs.readFileSync(path.join(repository, relative), 'utf8');
  if (content.includes(token)) fail(`Static removal check failed: ${relative} still contains "${token}"`);
  return content;
}

function assertPresent(relative, token) {
  const content = fs.readFileSync(path.join(repository, relative), 'utf8');
  if (!content.includes(token)) fail(`Static replacement check failed: ${relative} does not contain "${token}"`);
}

function runTap(script) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', path.join(scriptsDir, script)],
    {
      cwd: apiCwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: scriptTimeoutMs,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    },
  );
  const output = strip(`${result.stdout || ''}\n${result.stderr || ''}`);
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const summary = {
    script,
    status: result.status === 0 ? 'pass' : (timedOut ? 'timeout' : 'fail'),
    tests: count(output, 'tests'),
    pass: count(output, 'pass'),
    fail: count(output, 'fail'),
    skipped: count(output, 'skipped'),
    durationMs: Date.now() - startedAt,
  };
  return { summary, output, ok: result.status === 0 };
}

function main() {
  const prerequisites = [
    ...apiBuildEntries,
    ...requiredBuiltFiles,
    ...executedScripts.map(script => path.join('packages/api-nova-api/scripts', script)),
  ];
  const apiBuilt = apiBuildEntries.some(relative => fs.existsSync(path.join(repository, relative)));
  if (!apiBuilt) fail(`Missing built API entry (${apiBuildEntries.join(' or ')}). Run: ${buildCommand}`);
  for (const relative of prerequisites) {
    if (relative === apiBuildEntries[0] || relative === apiBuildEntries[1]) continue;
    requireFile(relative, `Run: ${buildCommand}`);
  }

  assertAbsent(monitoringControllerPath, 'external-callers');
  assertAbsent(monitoringControllerPath, 'getExternalCallers');
  assertAbsent(parserRuntimeAuditPath, 'listObservedRuntimeCallers');
  assertPresent(visitorsControllerPath, "@Get('callers')");

  const results = [];
  const failures = [];
  for (const script of executedScripts) {
    const { summary, output, ok } = runTap(script);
    results.push(summary);
    if (!ok) failures.push({ script, output });
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[verify-obs-15-full-chain] ${failure.script} failed; last output follows`);
      console.error(failure.output.slice(-8000));
    }
    fail(`Executed TAP scripts failed: ${failures.map(failure => failure.script).join(', ')}`);
  }

  const commit = execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim();
  console.log(JSON.stringify({
    marker: 'OBS_15_FULL_CHAIN_OK',
    workPackage: 'OBS-15-02',
    environment: { commit, platform: process.platform, arch: process.arch, node: process.version },
    scripts: results,
    skipped: skippedScripts,
    staticRemoval: {
      monitoringController: { path: monitoringControllerPath, legacyRoute: 'management/external-callers', absent: true },
      parserRuntimeCallAudit: { path: parserRuntimeAuditPath, symbol: 'listObservedRuntimeCallers', absent: true },
      unifiedCallersEndpointPresent: visitorsControllerPath,
    },
    identityChain: {
      claim: 'The covered scripts assert external-origin call identity coherence through the unified chain: '
        + 'origin=external is preserved and callerId/requestId/traceId/invocationId/eventId/deliveryId stay linked and scoped '
        + 'from source records through invocation queries, events, deliveries, realtime pages and overview aggregates.',
      edges: [
        { edge: 'real external HTTP request -> Gateway invocation identity (caller, API key, route, origin, audit correlation)', script: 'test-gateway-call-observability.cjs' },
        { edge: 'source record -> invocation detail/trace identity (invocationId, requestId, traceId, callerId, sourceId, scope)', script: 'test-call-observability-invocations.cjs' },
        { edge: 'event -> caller/endpoint/tool dimension identity and visibility scope', script: 'test-call-observability-events.cjs' },
        { edge: 'event -> subscription -> delivery identity (one event, one controlled delivery, idempotent replay)', script: 'test-call-observability-deliveries.cjs' },
        { edge: 'event sequence -> realtime page identity (high watermark, no gap/duplicate after concurrent commit)', script: 'test-call-observability-realtime.cjs' },
        { edge: 'normalized audit record -> invocation projection -> overview aggregate identity (single snapshot, honest watermarks)', script: 'test-call-observability-overview.cjs' },
      ],
      limitations: [
        'the chain is exercised per edge across real loopback/SQL.js suites; no single end-to-end process stitches every edge at once',
      ],
    },
    rejectionAudit: {
      scripts: ['test-gateway-call-observability.cjs', 'test-call-observability-invocations.cjs',
        'test-call-observability-events.cjs', 'test-call-observability-overview.cjs',
        'test-call-observability-deliveries.cjs'],
      detail: 'gateway asserts runtime request-level authentication/identity audit rows; invocations/events/overview assert '
        + '401 (missing or invalid identity) and 403 (authorized but out-of-scope) rejections and that denied readers receive '
        + 'no hidden totals or resource identifiers; deliveries asserts FORBIDDEN retry paths and records audit entries '
        + 'through the injected audit sink (reasonProvided).',
      notCovered: 'real external receiver delivery and cross-platform identity switching (environment work).',
    },
    oldEndpoints: {
      retired: 'GET /api/v1/monitoring/management/external-callers',
      replacement: 'GET /api/monitoring/observability/callers',
      aliasOrFallback: 'none (OBS-15-01); legacy route, getExternalCallers handler and parser listObservedRuntimeCallers file-scan helper stay removed',
    },
    rollback: [
      'Stop onboarding new consumers to the unified callers API and freeze the current build.',
      'Keep the unified observability API (GET /api/monitoring/observability/callers) in service; do not disable monitoring:read or asset scoping.',
      'Do not restore the retired GET /api/v1/monitoring/management/external-callers route, the getExternalCallers handler, the parser listObservedRuntimeCallers helper, or any alias/fallback.',
      'If a rollback deployment is unavoidable, redeploy the last verified build that still excludes the legacy route and helper; do not patch source in place.',
      'Re-run npm run verify:obs-15-full-chain after any change and attach the OBS_15_FULL_CHAIN_OK line to the change record.',
    ],
    scope: 'local SQL.js/loopback execution on Windows; no PostgreSQL, Linux, real external receiver throughput, or deployment sign-off claimed',
  }));
}

main();
