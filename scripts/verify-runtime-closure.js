const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [];

function run(name, args) {
  console.log(`\n[runtime-closure] ${name}`);
  const result = spawnSync(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status}`);
  checks.push(name);
}

function assertRemovedRoute() {
  const roots = [
    path.join(root, 'packages', 'api-nova-api', 'src'),
    path.join(root, 'packages', 'api-nova-ui', 'src'),
    path.join(root, 'docs'),
  ];
  const extensions = new Set(['.ts', '.vue', '.md']);
  const matches = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (extensions.has(path.extname(entry.name))) {
        const content = fs.readFileSync(target, 'utf8');
        if (content.includes('quick-publish-mcp')) matches.push(path.relative(root, target));
      }
    }
  };
  roots.forEach(visit);
  if (matches.length) throw new Error(`Removed quick-publish route still referenced: ${matches.join(', ')}`);
  checks.push('removed quick-publish route scan');
}

const apiSuites = [
  'src/modules/asset-catalog/services/asset-catalog.service.spec.ts',
  'src/modules/source-service-instances/services/source-service-instances.service.spec.ts',
  'src/modules/endpoint-testing/services/endpoint-testing.service.spec.ts',
  'src/modules/runtime-upstream-bindings/services/runtime-upstream-bindings.service.spec.ts',
  'src/modules/publication/services/publication.service.spec.ts',
  'src/modules/gateway-runtime/services/gateway-route-snapshot.service.spec.ts',
  'src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts',
  'src/modules/runtime-assets/services/runtime-assets.service.spec.ts',
  'src/modules/servers/services/server-manager.runtime-asset-guard.spec.ts',
  'src/modules/runtime-verification/services/gateway-candidate-replay.service.spec.ts',
  'src/modules/runtime-verification/services/mcp-candidate-replay.service.spec.ts',
  'src/modules/runtime-verification/services/runtime-response-assertion.service.spec.ts',
  'src/modules/runtime-verification/services/runtime-verification.service.spec.ts',
];

try {
  assertRemovedRoute();
  run('parser build', ['run', 'build', '--workspace', 'api-nova-parser']);
  run('parser runtime credential tests', [
    'run', 'test', '--workspace', 'api-nova-parser', '--', '--runInBand',
    'src/headers/RuntimeCredentialRef.test.ts',
    'src/headers/RuntimeCredentialRef.integration.test.ts',
  ]);
  run('API build', ['run', 'build', '--workspace', 'api-nova-api']);
  run('UI type check', ['run', 'type-check', '--workspace', 'api-nova-ui']);
  run('runtime closure API tests', [
    'run', 'test', '--workspace', 'api-nova-api', '--', '--runInBand', ...apiSuites,
  ]);
  run('isolated SQLite baseline', ['run', 'db:verify-isolated-sqlite', '--workspace', 'api-nova-api']);
  run('isolated PostgreSQL baseline', ['run', 'db:verify-isolated-postgres', '--workspace', 'api-nova-api']);
  console.log(`\n${JSON.stringify({ passed: true, checkCount: checks.length, checks })}`);
} catch (error) {
  console.error(`\n[runtime-closure] ${error.message || error}`);
  process.exitCode = 1;
}
