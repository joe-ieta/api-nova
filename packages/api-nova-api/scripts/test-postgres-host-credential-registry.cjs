'use strict';
// Invoked only by the dedicated disposable-cluster launcher; all credentials are synthetic.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { buildDatabaseOptions } = require('../dist/src/database/database-options');
const { createHostCredentialGenerationStore, createRegistryProviderEvidence, resolveUpstreamCredential } = require('api-nova-parser');
const { createGatewayHostCredentialGenerationCapability } = require('../dist/src/modules/gateway-runtime/services/gateway-host-credential-generation.capability');
const { attestGatewayHostCredentialCandidate: attest, createGatewayHostCredentialRegistry: boot } = require('../dist/src/modules/gateway-runtime/services/gateway-host-credential-registry');
const { GatewayHeaderHistoryLedgerService: Ledger } = require('../dist/src/database/gateway-header-history-ledger.service');
const { GATEWAY_HEADER_HISTORY_NAMESPACE: namespace, GATEWAY_HEADER_HISTORY_PROVENANCE: provenance } = require('../dist/src/modules/gateway-runtime/services/gateway-upstream-credential.providers');
const sourceA = '00000000-0000-0000-0000-000000000001', sourceB = '00000000-0000-0000-0000-000000000002';
const endpointA = '00000000-0000-0000-0000-000000000003', endpointB = '00000000-0000-0000-0000-000000000004';
const dispose = [];
function candidate(name = 'X-Retired-Host', none = false) {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'host-r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: none ? {} : { first: { type: 'env' }, second: { type: 'env' } },
    credentials: none ? {} : { basic: { type: 'basic', usernameRef: 'first:USER', passwordRef: 'second:PASS' }, key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'first:TOKEN' } },
    sites: [[sourceA, endpointA, 'a.example', 'basic'], [sourceB, endpointB, 'b.example', 'key']].map(([source, endpoint, host, credential], i) => ({ id: 'site' + i, sourceServiceAssetId: source, match: { scheme: 'https', host, port: 443, basePath: '/' }, allowedHosts: [host], credential: none ? 'none' : credential, endpoints: [{ endpointDefinitionId: endpoint }] })) };
}
function fixture(document = candidate(), missing = false) {
  const store = createHostCredentialGenerationStore();
  const material = value => ({ providers: { first: { USER: 'user-' + value, TOKEN: 'token-' + value }, second: missing ? { OTHER: 'unused' } : { PASS: 'pass-' + value } }, expiresAt: Date.now() + 60000 });
  const generation = store.activate(store.stage(material('old')), null), issuer = createRegistryProviderEvidence(store), controller = createGatewayHostCredentialGenerationCapability(issuer);
  dispose.push(() => { controller.close(); store.close(); });
  const input = { capability: controller.capability, text: JSON.stringify(document), format: 'json', environment: 'test', expectedGeneration: store.describe(generation).generationId };
  return { store, generation, issuer, controller, input, material, token: () => attest(input) };
}
async function main() {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_USERNAME, 'host_registry_fixture'); assert.notEqual(Number(process.env.DB_PORT), 5432);
  assert.match(process.env.API_NOVA_ISOLATED_HOST_REGISTRY || '', /^[a-f0-9]{48}$/); assert.equal(process.env.DATABASE_URL, undefined);
  const expectedData = await fs.realpath(process.env.API_NOVA_ISOLATED_PG_DATA);
  assert.match(path.basename(path.dirname(expectedData)), /^pg-host-registry-/);
  const options = buildDatabaseOptions(), db = await new DataSource(options).initialize();
  let checks = 0;
  try {
    assert.equal(await fs.realpath((await db.query('SHOW data_directory'))[0].data_directory), expectedData);
    await db.runMigrations(); const ledger = new Ledger(db);
    if (process.argv[2] === 'warm') {
      await db.getRepository('SourceServiceAssetEntity').save([{ id: sourceA, sourceKey: 'host-a' }, { id: sourceB, sourceKey: 'host-b' }]);
      await db.getRepository('EndpointDefinitionEntity').save([{ id: endpointA, sourceServiceAssetId: sourceA, method: 'GET', path: '/items' }, { id: endpointB, sourceServiceAssetId: sourceB, method: 'GET', path: '/items' }]);
      const f = fixture(), module = await Test.createTestingModule({ providers: [{ provide: 'host', useFactory: () => boot(f.token(), db) }] }).compile();
      const host = module.get('host'); dispose.push(() => host.close()); const snapshot = host.captureSnapshot();
      assert.equal(host.readEpoch(sourceA), f.input.expectedGeneration); assert.equal(host.readEpoch(sourceB), f.input.expectedGeneration);
      const basic = await resolveUpstreamCredential(snapshot, { sourceServiceAssetId: sourceA, endpointDefinitionId: endpointA, url: 'https://a.example/items' });
      assert.equal(basic.headers.authorization, 'Basic ' + Buffer.from('user-old:pass-old').toString('base64'));
      const key = await resolveUpstreamCredential(snapshot, { sourceServiceAssetId: sourceB, endpointDefinitionId: endpointB, url: 'https://b.example/items' }); assert.equal(key.headers['X-Retired-Host'] || key.headers['x-retired-host'], 'token-old');
      const proof = host.issueProof(sourceA); assert.ok(f.issuer.consume(proof, { snapshot, sourceServiceAssetId: sourceA, providerEpoch: f.input.expectedGeneration })); assert.equal(f.issuer.consume(proof, { snapshot, sourceServiceAssetId: sourceA, providerEpoch: f.input.expectedGeneration }), undefined); checks++;
      f.store.activate(f.store.stage(f.material('new')), f.generation); assert.equal((await resolveUpstreamCredential(snapshot, { sourceServiceAssetId: sourceA, endpointDefinitionId: endpointA, url: 'https://a.example/items' })).headers.authorization, basic.headers.authorization); checks++;
      const signal = host.readSignal(sourceA); f.store.revoke(f.generation); assert.equal(signal.aborted, true); assert.throws(() => host.captureSnapshot()); await module.close(); checks++;
      const closed = fixture(), closeHost = await boot(closed.token(), db), closeSignal = closeHost.readSignal(sourceA); closeHost.close(); assert.equal(closeSignal.aborted, true); assert.throws(() => closeHost.issueProof(sourceA)); checks++;
      for (const mode of ['missing', 'json', 'epoch', 'environment', 'ownership']) {
        const broken = fixture(candidate('X-Failed-' + mode), mode === 'missing');
        if (mode === 'json') broken.input.text = '{'; if (mode === 'epoch') broken.input.expectedGeneration = 'wrong'; if (mode === 'environment') broken.input.environment = 'wrong';
        if (mode === 'ownership') { const value = candidate(); value.sites[0].sourceServiceAssetId = sourceB; broken.input.text = JSON.stringify(value); }
        await assert.rejects(boot(broken.token(), db), /gateway_host_credential_registry_unavailable/); checks++;
      }
      const forged = fixture(), token = forged.token(); await assert.rejects(boot({ ...token }, db)); const valid = await boot(token, db); dispose.push(valid.close); await assert.rejects(boot(token, db)); checks++;
      // A transaction pinned to another PG connection cannot own the boot's ledger commit.
      const runner = db.createQueryRunner(); await runner.startTransaction();
      try {
        await runner.manager.getRepository('GatewayHeaderHistoryLedgerEntity').insert({ namespace: 'fixture:external', provenanceDigest: 'a'.repeat(64), sourceKind: 'registry', version: 1, revision: 1, headerNames: '[]' });
        const independent = fixture(candidate('X-Independent')), active = await boot(independent.token(), db); dispose.push(active.close); assert.ok(active.captureSnapshot());
        await runner.rollbackTransaction(); assert.equal(await db.getRepository('GatewayHeaderHistoryLedgerEntity').countBy({ namespace: 'fixture:external' }), 0); assert.ok((await ledger.load(namespace, provenance)).headerNames.includes('x-independent')); checks++;
      } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
      const other = await new DataSource(options).initialize();
      try {
        const a = ledger.asStore('fixture:cas', 'b'.repeat(64)), b = new Ledger(other).asStore('fixture:cas', 'b'.repeat(64));
        const race = await Promise.all([a.commit('fixture:cas', 0, ['X-Cas-A']), b.commit('fixture:cas', 0, ['X-Cas-B'])]); assert.equal(race.filter(Boolean).length, 1);
        const state = await a.load('fixture:cas'); assert.equal(state.version, 1); assert.equal(await b.commit('fixture:cas', 1, ['X-Cas-Next']), true); assert.ok((await a.load('fixture:cas')).names.includes(state.names[0])); checks++;
        const left = fixture(candidate('X-Parallel-A')), right = fixture(candidate('X-Parallel-B'));
        const both = await Promise.all([boot(left.token(), db), boot(right.token(), other)]); both.forEach(value => { assert.ok(value.captureSnapshot()); dispose.push(value.close); });
        const names = (await ledger.load(namespace, provenance)).headerNames; assert.ok(names.includes('x-parallel-a')); assert.ok(names.includes('x-parallel-b')); checks++;
      } finally { await other.destroy(); }
    } else {
      assert.equal(process.argv[2], 'cold');
      const names = (await ledger.load(namespace, provenance)).headerNames;
      for (const name of ['x-retired-host', 'x-independent', 'x-parallel-a', 'x-parallel-b']) assert.ok(names.includes(name));
      const f = fixture(candidate('unused', true)), host = await boot(f.token(), db); dispose.push(host.close);
      for (const name of names) assert.ok(host.captureSnapshot().historicalAuthenticationHeaderNames.includes(name)); checks++;
      const bad = candidate('unused', true); bad.sites[0].headerPolicy = { version: 1, requestHeaders: ['x-retired-host'] }; const unsafe = fixture(bad); await assert.rejects(boot(unsafe.token(), db)); checks++;
      assert.ok(host.issueProof(sourceA)); assert.equal((await ledger.load(namespace, provenance)).headerNames.includes('x-retired-host'), true); checks++;
    }
    assert.deepEqual((await db.driver.createSchemaBuilder().log()).upQueries, []); checks++;
    console.log(JSON.stringify({ marker: 'POSTGRES_HOST_REGISTRY_OK', mode: process.argv[2], checks, zeroDrift: true, noProductionActivation: true }));
  } finally { for (const close of dispose.reverse()) close(); await db.destroy(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
