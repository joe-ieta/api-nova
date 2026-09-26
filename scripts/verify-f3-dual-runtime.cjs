// Local dual-runtime (Parser + Gateway) real-network matrix. Aggregates and re-runs
// the real DNS/HTTP/TLS suites that prove each C6 clause; no production activation,
// no PostgreSQL and no platform matrix is claimed.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const parserCwd = path.join(repository, 'packages/api-nova-parser');
const apiCwd = path.join(repository, 'packages/api-nova-api');

const matrix = {
  'parser://operation-epoch-and-credential-rebuild': ['trusted-network-operation-execution'],
  'parser://multi-hop-reselection-and-per-hop-credentials': ['trusted-redirect-network-execution'],
  'parser://host-safe-read-multi-hop': ['parser-host-safe-read-transformer'],
  'parser://failure-audit-classification': ['network-failure-adapter'],
  'gateway://operation-lifecycle-single-attempt-cache-off': ['gateway-network-stream.http'],
  'gateway://host-assembly-and-conflict-rejection': ['gateway-network-host-bootstrap'],
  'gateway://registration-coordinator-and-revocation': ['gateway-network-registration-coordinator'],
};

const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');

function run(cwd, suites, label) {
  const jest = require.resolve('jest/bin/jest', { paths: [cwd] });
  const result = spawnSync(process.execPath, [jest, ...suites, '--runInBand', '--silent'], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = strip(`${result.stdout || ''}\n${result.stderr || ''}`);
  if (result.status !== 0) {
    console.error(output.slice(-8000));
    throw new Error(`${label} suites failed: ${suites.join(', ')}`);
  }
  const suitesLine = [...output.matchAll(/^Test Suites:\s+(.+)$/gm)].pop()?.[1]?.trim() ?? 'unknown';
  const testsLine = [...output.matchAll(/^Tests:\s+(.+)$/gm)].pop()?.[1]?.trim() ?? 'unknown';
  return { suites, suitesLine, testsLine };
}

const parser = run(parserCwd, [...new Set(Object.values(matrix).flat().filter(name => !name.startsWith('gateway-')))], 'parser');
const gateway = run(apiCwd, [...new Set(Object.values(matrix).flat().filter(name => name.startsWith('gateway-')))], 'gateway');

console.log(JSON.stringify({
  marker: 'F3_DUAL_RUNTIME_MATRIX_OK',
  parser,
  gateway,
  clauses: matrix,
  scope: 'local loopback DNS/HTTP/TLS only; real Registry/credential and failure-audit fixtures',
  noProductionActivation: true,
  noPostgresOrPlatformMatrix: true,
}));
