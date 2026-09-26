// SEC-F3-02D local N01-N17 matrix: real isolated DNS/HTTP/TLS/proxy servers on
// loopback. Local Windows evidence only; production default-on, cross-platform
// and external network acceptance remain environment items.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const parserCwd = path.join(repo, 'packages', 'api-nova-parser');
const apiCwd = path.join(repo, 'packages', 'api-nova-api');
const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const parserSuites = [
  'controlled-dns.spec.ts',
  'host-security-epoch-authority.spec.ts',
  'network-denial-audit.spec.ts',
  'network-failure-adapter.spec.ts',
  'network-failure-contract.spec.ts',
  'network-operation-authority.spec.ts',
  'network-policy.spec.ts',
  'parser-host-network-bridge.spec.ts',
  'parser-host-safe-read-transformer.spec.ts',
  'pinned-http-stream.spec.ts',
  'pinned-http-transport.spec.ts',
  'redirect-chain-state.spec.ts',
  'redirect-location-evidence.spec.ts',
  'trusted-network-operation-execution.spec.ts',
  'trusted-redirect-network-execution.spec.ts',
  'trusted-redirect-target.spec.ts',
  'trusted-single-hop-network-execution.spec.ts',
];
const gatewaySuite = 'src/modules/gateway-runtime/services/gateway-network-stream.http.spec.ts';

function runJest(cwd, patterns, label, describe) {
  const jest = require.resolve('jest/bin/jest', { paths: [cwd] });
  const output = path.join(os.tmpdir(), `api-nova-f3n-${label}-${process.pid}.json`);
  const result = spawnSync(process.execPath,
    [jest, '--runInBand', '--silent', '--json', `--outputFile=${output}`, ...patterns],
    { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(strip(`${result.stdout || ''}\n${result.stderr || ''}`).slice(-8000));
    throw new Error(`${label} jest run failed`);
  }
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  fs.rmSync(output, { force: true });
  const names = new Map();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) names.set(test.fullName ?? test.title, test.status);
  }
  return { describe, suites: report.numTotalTestSuites, tests: report.numTotalTests, pass: report.numPassedTests, names };
}

const parser = runJest(parserCwd, parserSuites.map(name => `src/network/${name}`), 'parser', 'parser real network suites');
const gateway = runJest(apiCwd, [gatewaySuite], 'gateway', 'gateway network stream suite');
const names = new Map([...parser.names, ...gateway.names]);

const matrix = {
  N01: { suites: ['gateway-network-stream.http.spec.ts', 'trusted-single-hop-network-execution.spec.ts'], required: ['N01 returns the first-hop redirect status and never follows or repeats the request'] },
  N02: { suites: ['trusted-redirect-network-execution.spec.ts', 'parser-host-safe-read-transformer.spec.ts'], required: ['five authorized follows use separate verified connections', 'sixth follow is rejected before a seventh connection', 'unconfigured trusted network branch ignores tool and OpenAPI switches'] },
  N03: { suites: ['trusted-single-hop-network-execution.spec.ts', 'pinned-http-transport.spec.ts'], required: ['ignores Axios ambient credentials', 'rejects an untrusted TLS certificate without HTTP bytes', 'success with literal pin, Host, raw bytes and verified TLS=true'] },
  N04: { suites: ['trusted-redirect-target.spec.ts', 'redirect-chain-state.spec.ts'], required: ['resolves relative Location by real method/path and reselects the more specific Site', 'rejects unsafe or unknown target'] },
  N05: { suites: ['trusted-redirect-target.spec.ts', 'redirect-location-evidence.spec.ts'], required: ['allows explicitly registered cross-origin within one asset and rebuilds authentication', 'None suppresses prior Endpoint credentials including durable historical names'] },
  N06: { suites: ['trusted-redirect-network-execution.spec.ts', 'redirect-chain-state.spec.ts'], required: ['rejects missing Location with zero next request', 'rejects duplicate Location with zero next request', 'rejects loop Location with zero next request', 'rejects unknown Location with zero next request', 'rejects foreign Location with zero next request', 'rejects HTTPS downgrade before an HTTP connection'] },
  N07: { suites: ['parser-host-safe-read-transformer.spec.ts', 'trusted-redirect-network-execution.spec.ts'], required: ['real tool follows host target and strips credentials TLS=true', 'HEAD stays HEAD', 'missing or forged explicit proof sends nothing'] },
  N08: { suites: ['controlled-dns.spec.ts', 'network-failure-adapter.spec.ts'], required: ['fails closed on empty', 'fails closed on nxdomain', 'fails closed on servfail', 'does not authorize a result when the exception expires while DNS is pending'] },
  N09: { suites: ['controlled-dns.spec.ts', 'trusted-redirect-network-execution.spec.ts'], required: ['rejects DNS rebinding on the next attempt rather than reusing an approved answer', 'changed next-hop DNS answer is reauthorized and denied before another HTTP request'] },
  N10: { suites: ['controlled-dns.spec.ts'], required: ['caps silent DNS at five seconds even with a longer operation deadline', 'pre-aborted and elapsed-deadline requests emit zero DNS packets'] },
  N11: { suites: ['controlled-dns.spec.ts', 'network-policy.spec.ts'], required: ['rejects the entire final set: mixed4', 'rejects the entire final set: mixed6', 'rejects the entire final set: cname-private', 'accepts CNAME final address records, not the alias as an IP authorization'] },
  N12: { suites: ['controlled-dns.spec.ts', 'trusted-single-hop-network-execution.spec.ts'], required: ['authorizes complete A/AAAA results without opening any target connection', 'redirect is single hop and rebinding cannot reach another peer'] },
  N13: { suites: ['network-policy.spec.ts', 'controlled-dns.spec.ts'], required: ['normalizes direct mapped IP without DNS and requires exact exception', 'canonical exception 10.0.0.0/8', 'canonical exception fd01::/64', 'rejects unsafe CIDR 0.0.0.0/0'] },
  N14: { suites: ['trusted-single-hop-network-execution.spec.ts', 'network-policy.spec.ts', 'controlled-dns.spec.ts', 'pinned-http-transport.spec.ts'], required: ['explicit host mode ignores proxy environment and never forwards consumer auth', '"connection":"proxy"', 'scrubs DNS/native errors and rejects externally supplied lookup/transport configuration'] },
  N15: { suites: ['trusted-redirect-network-execution.spec.ts', 'parser-host-safe-read-transformer.spec.ts'], required: ['303 preserves GET through the chain', '303 preserves HEAD through the chain', 'keeps POST single-hop and returns original body', 'keeps body single-hop and returns original body', 'keeps default single-hop and returns original body', 'HEAD stays HEAD'] },
  N16: { suites: ['trusted-network-operation-execution.spec.ts', 'parser-host-network-bridge.spec.ts', 'host-security-epoch-authority.spec.ts'], required: ['normal reload pins old credentials while a newly registered operation uses new Snapshot, TLS=false', 'revocation during DNS aborts before connection, TLS=false', 'ordinary reload preserves prepared version and requires new proof, TLS=false', 'Provider epoch changed before send fails with zero DNS'] },
  N17: { suites: ['trusted-single-hop-network-execution.spec.ts', 'trusted-network-operation-execution.spec.ts', 'parser-host-network-bridge.spec.ts', 'network-denial-audit.spec.ts'], required: ['ignores Axios ambient credentials, context=false', 'ignores Axios ambient credentials, context=true', 'None Transformer uses host lifecycle with context=false and ignores args Signal/Verified', 'None Transformer uses host lifecycle with context=true and ignores args Signal/Verified', 'None works through Transformer without leaking a credential'] },
};

const failures = [];
const coverage = {};
for (const [clause, entry] of Object.entries(matrix)) {
  const missing = entry.required.filter(name => ![...names.entries()].some(([fullName, status]) => fullName.includes(name) && status === 'passed'));
  coverage[clause] = { suites: entry.suites, required: entry.required.length, passed: entry.required.length - missing.length, status: missing.length === 0 ? 'covered' : 'missing' };
  if (missing.length) failures.push({ clause, missing });
}
if (failures.length) {
  console.error(JSON.stringify({ marker: 'F3_N_MATRIX_FAILED', failures, coverage }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  marker: 'F3_N_MATRIX_OK',
  workPackage: 'SEC-F3-02D',
  environment: {
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    platform: process.platform, arch: process.arch, node: process.version,
  },
  runtime: { parser: { ...parser, names: undefined }, gateway: { ...gateway, names: undefined } },
  coverage,
  notCovered: [
    'production default-on enablement and managed configuration',
    'Linux/macOS platform matrix and cross-deployment behaviour',
    'real public network, real DNS/TLS infrastructure and external receivers',
    'long-duration soak/adversarial load beyond isolated loopback',
  ],
  scope: 'local isolated loopback DNS/HTTP/TLS/proxy; policy unchanged by observation failures',
}, null, 2));
