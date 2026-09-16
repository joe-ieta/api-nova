// Bounded local publication-state validation. No production database or upstream is used.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '../packages/api-nova-api');
const jest = require.resolve('jest/bin/jest', { paths: [cwd] });
const suites = ['publication-cycle.spec.ts', 'runtime-verification.service.spec.ts',
  'gateway-route-snapshot.service.spec.ts', 'mcp-activation-stale.spec.ts',
  'runtime-upstream-bindings.service.spec.ts', 'runtime-governance-invalidation.service.spec.ts',
  'runtime-assets.service.spec.ts'];
console.log('PROD-03 local: SQL.js lifecycle orchestration plus isolated service regressions. Registration is seeded; Gateway replay is injected; no HTTP or managed-process acceptance is claimed.');
const result = spawnSync(process.execPath, [jest, ...suites, '--runInBand'], { cwd, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
