'use strict';
// H07 diagnostic: observes the current cold-process history gap, NOT an acceptance pass.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { UpstreamCredentialRegistry } = require('api-nova-parser');
function candidate(revision, name) {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } }, credentials: { key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'env:FIXTURE' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'example.invalid', port: 443, basePath: '/' }, allowedHosts: ['example.invalid'], credential: 'key', headerPolicy: { version: 1 }, endpoints: [] }] };
}
async function worker(mode) {
  const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic-only' }) });
  if (mode === 'warm') await registry.reload(candidate('before', 'x-retired-key'));
  await registry.reload(candidate('current', 'x-current-key'));
  console.log(JSON.stringify({ names: registry.captureSnapshot().historicalAuthenticationHeaderNames }));
}
if (process.argv[2] === '--worker') worker(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
else {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE)$/i.test(key)));
  const run = mode => {
    const child = spawnSync(process.execPath, [__filename, '--worker', mode], { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout.trim());
  };
  const warm = run('warm'), cold = run('cold');
  assert.ok(warm.names.includes('x-retired-key'));
  assert.ok(cold.names.includes('x-current-key'));
  assert.equal(cold.names.includes('x-retired-key'), false);
  console.log(JSON.stringify({ marker: 'HEADER_HISTORY_COLD_RESTART_GAP_CONFIRMED', warmRetainsRetiredName: true, coldRetainsRetiredName: false, acceptanceComplete: false, scope: 'two-real-processes-current-registry-config-no-upstream-network' }));
}
