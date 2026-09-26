// OBS-06-01 local MCP body/terminal matrix. Runs the real transport scripts plus the
// Parser upstream failure suites and emits one machine-readable matrix. Windows-only
// evidence; Linux/OBS-06-02, production activation and AC-02 retry are not claimed.
const { spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const serverCwd = path.join(repository, 'packages/api-nova-server');
const parserCwd = path.join(repository, 'packages/api-nova-parser');

const prerequisites = [
  'packages/api-nova-parser/dist/index.js',
  'packages/api-nova-server/dist/index.js',
  'packages/api-nova-server/dist/tools/mcp-http-audit.js',
  'packages/api-nova-server/dist/transportUtils/audit.js',
];
for (const file of prerequisites) {
  if (!fs.existsSync(path.join(repository, file))) {
    throw new Error(`Missing ${file}. Run: npm run build --workspace api-nova-parser && npm run build --workspace api-nova-server`);
  }
}

const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const count = (output, name) => Number([...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].pop()?.[1] ?? NaN);

function runTap(script) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(serverCwd, 'scripts', script)], {
    cwd: serverCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
  });
  if (result.error) throw result.error;
  const output = strip(`${result.stdout || ''}\n${result.stderr || ''}`);
  const summary = { script, status: result.status === 0 ? 'pass' : 'fail', tests: count(output, 'tests'), pass: count(output, 'pass'), fail: count(output, 'fail') };
  if (result.status !== 0) {
    console.error(output.slice(-8000));
    throw new Error(`MCP script failed: ${script} (${summary.fail} failing)`);
  }
  const diagnostics = [...output.matchAll(/^\s*# (\{.*\})\s*$/gm)].map(match => JSON.parse(match[1]));
  return { summary, diagnostics };
}

const serverScripts = [
  'test-mcp-http-delivery.cjs',
  'test-mcp-http-observability.cjs',
  'test-mcp-transport-observability.cjs',
  'test-mcp-stdio-observability.cjs',
];
const server = serverScripts.map(runTap);
const abDiagnostics = server.flatMap(entry => entry.diagnostics).filter(value => value && value.variant);
const native = abDiagnostics.find(value => value.variant === 'native');
const audited = abDiagnostics.find(value => value.variant === 'audited');
if (!native || !audited) {
  throw new Error('Windows native/audited comparison diagnostics were not produced');
}

const jest = require.resolve('jest/bin/jest', { paths: [parserCwd] });
const parserSuites = ['runtime-http-agent', 'runtime-upstream-attempt', 'runtime-observability-contract'];
const parserRun = spawnSync(process.execPath, [jest, ...parserSuites, '--runInBand', '--silent'], {
  cwd: parserCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
});
if (parserRun.error) throw parserRun.error;
const parserOutput = strip(`${parserRun.stdout || ''}\n${parserRun.stderr || ''}`);
if (parserRun.status !== 0) {
  console.error(parserOutput.slice(-8000));
  throw new Error('Parser upstream failure suites failed');
}
const parserTests = [...parserOutput.matchAll(/^Tests:\s+(.+)$/gm)].pop()?.[1]?.trim() ?? 'unknown';

const sdkVersion = JSON.parse(fs.readFileSync(require.resolve('@modelcontextprotocol/sdk/package.json', { paths: [serverCwd] }), 'utf8')).version;
const commit = execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim();

console.log(JSON.stringify({
  marker: 'MCP_OBSERVABILITY_MATRIX_OK',
  environment: { commit, platform: process.platform, arch: process.arch, node: process.version, sdk: sdkVersion },
  server: server.map(entry => entry.summary),
  parser: { suites: parserSuites, tests: parserTests },
  transports: {
    streamable: { success: 'covered', cancel: 'covered', disconnect_during_send: 'covered', large_response: 'covered', timeout: 'partial: ingress auth deadline only (MCP_AUTH_EXPIRED)' },
    sse: { success: 'covered', cancel: 'covered', disconnect_during_send: 'covered', large_response: 'covered', timeout: 'not_applicable: no server-side MCP call timeout exists' },
    stdio: { success: 'covered', cancel: 'covered', disconnect_during_send: 'covered', large_response: 'covered (8 MiB, full body captured)', timeout: 'not_applicable: no server-side MCP call timeout exists' },
  },
  windowsNativeComparison: native && audited
    ? { native: { status: native.status, corked: native.state?.corked, buffered: native.state?.buffered, finished: native.state?.finished, needDrain: native.state?.needDrain, bytes: native.bytes, deadlineMs: native.deadlineMs },
        audited: { status: audited.status, corked: audited.state?.corked, buffered: audited.state?.buffered, finished: audited.state?.finished, needDrain: audited.state?.needDrain, bytes: audited.bytes, deadlineMs: audited.deadlineMs },
        match: native.status === audited.status }
    : 'unknown',
  limitations: [
    'no Linux/PostgreSQL/multi-process/load evidence (OBS-06-02 unrun)',
    'no AC-02 upstream retry matrix and no MCP call-timeout implementation (TP06/16)',
    'cork/uncork timeout is a bounded baseline reproduction, not a recovery pass',
  ],
  scope: 'local loopback transports; Windows-only run; no production activation',
}));
