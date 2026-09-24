'use strict';
// Worker for disposable SQL.js/PostgreSQL fixtures; never accepts a business database.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const { buildDatabaseOptions } = require('../dist/src/database/database-options');
const { createConfiguredGatewayCredentialRegistry: boot, GATEWAY_UPSTREAM_CREDENTIAL_CONFIG: keys, GATEWAY_HEADER_HISTORY_NAMESPACE: namespace, GATEWAY_HEADER_HISTORY_PROVENANCE: provenance } = require('../dist/src/modules/gateway-runtime/services/gateway-upstream-credential.providers');
const { gatewayUpstreamCredentialResolverProvider } = require('../dist/src/modules/gateway-runtime/services/gateway-upstream-credential.providers');
const { GatewayProxyEngineService: Proxy } = require('../dist/src/modules/gateway-runtime/services/gateway-proxy-engine.service');
const { GatewayHeaderHistoryLedgerService: Ledger } = require('../dist/src/database/gateway-header-history-ledger.service');
const asset = '00000000-0000-0000-0000-000000000001', endpoint = '00000000-0000-0000-0000-000000000002';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function candidate(revision, name, port) { return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: name ? { env: { type: 'env' } } : {}, credentials: name ? { key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'env:API_NOVA_HISTORY_FIXTURE' } } : {}, sites: [{ id: 'site', sourceServiceAssetId: asset, match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: name ? 'key' : 'none', endpoints: [{ endpointDefinitionId: endpoint }] }] }; }
async function worker(mode) {
  if (process.env.DB_TYPE === 'postgres') { assert.equal(process.env.DB_USERNAME, 'schema_fixture'); assert.equal(process.env.DB_HOST, '127.0.0.1'); }
  else { assert.equal(process.env.DB_TYPE, 'sqlite'); assert.ok(process.env.DB_SQLITE_PATH.includes('history-bootstrap-')); }
  const db = await new DataSource(buildDatabaseOptions()).initialize(); let upstream, gateway;
  const directory = process.env.API_NOVA_AUDIT_DIR; await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, mode + '-bindings.json');
  process.env.API_NOVA_HISTORY_FIXTURE = 'synthetic-only';
  try {
    await db.runMigrations();
    if (mode === 'warm') {
      await db.getRepository('SourceServiceAssetEntity').save({ id: asset, sourceKey: 'fixture' });
      await db.getRepository('EndpointDefinitionEntity').save({ id: endpoint, sourceServiceAssetId: asset, method: 'GET', path: '/items' });
      await fs.writeFile(file, JSON.stringify(candidate('old', 'x-retired-key', 12345)));
      const registry = await boot(new ConfigService({ [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test' }), db);
      await registry.reload(candidate('rotated', 'x-current-key', 12345)); await registry.reload(candidate('cleared', undefined, 12345));
      assert.deepEqual((await new Ledger(db).load(namespace, provenance)).headerNames, ['x-current-key', 'x-retired-key']);
    } else {
      const seen = []; upstream = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); }); const upstreamPort = await listen(upstream);
      const current = candidate('cold-cleared', undefined, upstreamPort); await fs.writeFile(file, JSON.stringify(current));
      const registry = await boot(new ConfigService({ [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test' }), db);
      for (const name of ['x-current-key', 'x-retired-key']) assert.ok(registry.captureSnapshot().historicalAuthenticationHeaderNames.includes(name));
      const bad = candidate('unsafe', undefined, upstreamPort); bad.sites[0].headerPolicy = { version: 1, requestHeaders: ['x-retired-key'] };
      await assert.rejects(registry.reload(bad)); assert.equal(registry.captureSnapshot().candidate.metadata.revision, 'cold-cleared');
      const proxy = new Proxy({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) }, gatewayUpstreamCredentialResolverProvider.useFactory(registry));
      const app = require('express')(); app.use((req, res) => {
        const route = { upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort, params: {}, runtimeAsset: { id: 'runtime' }, membership: { id: 'member' }, endpointDefinition: { id: endpoint }, sourceServiceAsset: { id: asset }, routeBinding: { id: 'route', upstreamPath: '/items', upstreamMethod: 'GET' }, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: {} } };
        proxy.forward(route, req, res).catch(error => res.status(error.getStatus?.() ?? 500).end());
      }); gateway = http.createServer(app); const port = await listen(gateway);
      const status = await new Promise((resolve, reject) => http.get({ hostname: '127.0.0.1', port, path: '/items', headers: { 'x-retired-key': 'forged', 'x-current-key': 'forged' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
      assert.equal(status, 200); assert.equal(seen.length, 1); assert.equal(seen[0]['x-retired-key'], undefined); assert.equal(seen[0]['x-current-key'], undefined);
      assert.deepEqual((await db.driver.createSchemaBuilder().log()).upQueries, []);
    }
  } finally { if (gateway) await close(gateway); if (upstream) await close(upstream); await db.destroy(); }
  console.log(JSON.stringify({ marker: 'HISTORY_BOOTSTRAP_WORKER_OK', mode }));
}
if (process.argv[2] === '--worker') worker(process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1; });
else {
  for (const mode of ['warm', 'cold']) { const result = spawnSync(process.execPath, [__filename, '--worker', mode], { env: process.env, windowsHide: true, encoding: 'utf8', timeout: 45000 }); assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes('HISTORY_BOOTSTRAP_WORKER_OK')); }
  console.log(JSON.stringify({ marker: 'POSTGRES_HEADER_HISTORY_BOOTSTRAP_OK', dialect: process.env.DB_TYPE === 'postgres' ? 'postgres' : 'sqljs', coldProcesses: true, realHttp: true, clearedRetained: true, policyRejected: true, zeroDrift: true, noActivation: true }));
}
