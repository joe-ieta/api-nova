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
function fixture(document = candidate(), missing = false, initial = 'old') {
  const store = createHostCredentialGenerationStore();
  const material = value => ({ providers: { first: { USER: 'user-' + value, TOKEN: 'token-' + value }, second: missing ? { OTHER: 'unused' } : { PASS: 'pass-' + value } }, expiresAt: Date.now() + 60000 });
  const generation = store.activate(store.stage(material(initial)), null), issuer = createRegistryProviderEvidence(store), controller = createGatewayHostCredentialGenerationCapability(issuer);
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
      checks += await registrationChecks(db);
      checks += await facadeChecks(db);
      checks += await bootstrapChecks(db);
      checks += await lifecycleChecks(db);
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
async function registrationChecks(pg) {
  const { assertGatewayHostCredentialRegistry: assertHost } = require('../dist/src/modules/gateway-runtime/services/gateway-host-credential-registry');
  const { createGatewayNetworkRegistrationBundle: assemble, inspectGatewayNetworkRegistrationBundle: inspect, closeGatewayNetworkRegistrationBundle: close } = require('../dist/src/modules/gateway-runtime/services/gateway-network-registration-coordinator');
  const { createNetworkPolicyCompiler } = require('api-nova-parser');
  const { GatewayRouteSnapshotEntity } = require('../dist/src/database/entities/gateway-route-snapshot.entity');
  const { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } = require('../dist/src/database/entities/runtime-asset.entity');
  const { GatewayRouteSnapshotService } = require('../dist/src/modules/gateway-runtime/services/gateway-route-snapshot.service');
  const { GatewayPolicyService } = require('../dist/src/modules/gateway-runtime/services/gateway-policy.service');
  const { GatewayRoutePathMatchMode } = require('../dist/src/database/entities/gateway-route-binding.entity');
  const routesDb = pg;
  const assetId = '00000000-0000-0000-0000-000000000099';
  const runtimeAsset = await routesDb.getRepository(RuntimeAssetEntity).save({ id: assetId, name: 'registration', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
  const service = new GatewayRouteSnapshotService(new GatewayPolicyService(), {}, routesDb.getRepository(GatewayRouteSnapshotEntity), {}, {}, routesDb.getRepository(RuntimeAssetEntity), {}, {}, {});
  const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
  const policy = compiler.compile({ version: 1, id: 'p', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin: 'https://a.example', mode: 'public', connection: 'direct' });
  let count = 0;
  async function commit(revision, upstreamBaseUrl = 'https://a.example') {
    const routeBinding = { id: 'route', authPolicyRef: 'jwt-default', pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamMethod: 'GET', upstreamPath: '/items', createdAt: new Date(), updatedAt: new Date() };
    const entries = [{ runtimeAsset: await routesDb.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: assetId }), routeBinding, membership: { id: 'member', publicationRevision: 1 }, publishBinding: { id: 'pub' }, sourceServiceAsset: { id: sourceA }, endpointDefinition: { id: endpointA }, sourceServiceInstance: { id: 'instance' }, normalizedRoutePath: '/items', routeMethod: 'GET', upstreamBaseUrl, priorityScore: 1, policies: new GatewayPolicyService().compileForRoute(routeBinding) }];
    const fingerprint = service.fingerprintEntries(entries);
    service.candidateSnapshots.set(revision, { runtimeAssetId: assetId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
    await routesDb.transaction(async manager => {
      await service.activateCandidate(revision, manager);
      await manager.update(RuntimeAssetEntity, assetId, { metadata: { activeRevision: revision, activeGatewaySnapshotFingerprint: fingerprint } });
    });
    await service.reload();
  }
  async function restored() {
    let resolve, reject;
    const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
    const subscription = service.observeActiveRouteCatalog(event => {
      if (event.kind === 'reload' && event.snapshot.routes.length === 1) resolve();
    });
    const timeout = setTimeout(() => reject(new Error('fixture deployed reload did not complete')), 5000);
    try {
      service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_deployed', runtimeAssetId: assetId });
      await completed; await service.reload();
    } finally { clearTimeout(timeout); subscription.close(); }
  }
  const makeHost = async () => { const f = fixture(); const host = await boot(f.token(), pg); dispose.push(host.close); return { f, host }; };
  const args = host => ({ routes: service, capture: service.captureActiveRouteCatalog(service.readActiveRouteCatalog()), host, compiler, policies: [{ routeBindingId: 'route', siteId: 'site0', policy }], proofs: [{ sourceServiceAssetId: sourceA, providerEpoch: host.readEpoch(sourceA), proof: host.issueProof(sourceA) }] });
  try {
    await commit('v1');
    const { f, host } = await makeHost(); assertHost(host); assert.throws(() => assertHost({ ...host })); count++;
    for (const failure of ['clone', 'source', 'epoch', 'issuer', 'replay']) {
      const proof = host.issueProof(sourceA), expected = host.readEpoch(sourceA);
      if (failure === 'clone') assert.throws(() => host.consumeProof({ ...proof }, sourceA, expected));
      if (failure === 'source') assert.throws(() => host.consumeProof(proof, sourceB, expected));
      if (failure === 'epoch') assert.throws(() => host.consumeProof(proof, sourceA, 'wrong'));
      if (failure === 'issuer') { const other = await makeHost(); assert.throws(() => other.host.consumeProof(proof, sourceA, other.host.readEpoch(sourceA))); }
      if (failure === 'replay') { assert.ok(host.consumeProof(proof, sourceA, expected)); assert.throws(() => host.consumeProof(proof, sourceA, expected)); }
      count++;
    }
    const input = args(host), bundle = assemble(input); assert.equal(inspect(bundle)[0].snapshot, host.captureSnapshot());
    assert.equal(inspect(bundle)[0].providerEpoch, f.input.expectedGeneration); assert.throws(() => inspect({ ...bundle })); assert.throws(() => assemble(input)); count++;
    let reentered = false; bundle.signal.addEventListener('abort', () => { assert.throws(() => inspect(bundle)); reentered = true; });
    await service.reload(); assert.equal(bundle.signal.aborted, true); assert.equal(reentered, true); assert.throws(() => inspect(bundle)); count++;
    const next = assemble(args(host)); assert.ok(inspect(next)); close(next); assert.equal(next.signal.aborted, true); close(next); count++;
    for (const mode of ['cloneCapture', 'missingPolicy', 'wrongSite', 'clonedPolicy', 'wrongEpoch', 'wrongSource', 'wrongEndpoint']) {
      const bad = args(host);
      if (mode === 'cloneCapture') bad.capture = { ...bad.capture };
      if (mode === 'missingPolicy') bad.policies = [];
      if (mode === 'wrongSite') bad.policies[0].siteId = 'site1';
      if (mode === 'clonedPolicy') bad.policies[0].policy = { ...policy };
      if (mode === 'wrongEpoch') bad.proofs[0].providerEpoch = 'wrong';
      if (mode === 'wrongSource') bad.proofs[0].sourceServiceAssetId = sourceB;
      if (mode === 'wrongEndpoint') {
        const route = service.resolve('localhost', 'GET', '/items'); const original = route.endpointDefinition.id;
        route.endpointDefinition.id = endpointB; assert.throws(() => assemble(bad)); route.endpointDefinition.id = original; count++; continue;
      }
      assert.throws(() => assemble(bad)); count++;
    }
    await commit('origin-mismatch', 'https://other.example');
    const wrongOrigin = args(host), mismatched = compiler.compile({ version: 1, id: 'other', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin: 'https://other.example', mode: 'public', connection: 'direct' });
    wrongOrigin.policies[0].policy = mismatched;
    assert.equal(compiler.authorizeTarget(mismatched, { sourceServiceAssetId: sourceA, siteId: 'site0', url: 'https://other.example' }), true);
    // Both the route and the compiled policy are valid, but Site 0 is bound to a.example.
    let outbound = 0;
    const outboundPorts = [[require('node:http'), 'request'], [require('node:https'), 'request'], [require('node:dns'), 'lookup'], [require('node:dns').promises, 'resolve4'], [require('node:dns').promises, 'resolve6']];
    const originals = outboundPorts.map(([owner, key]) => owner[key]);
    try {
      outboundPorts.forEach(([owner, key]) => { owner[key] = () => { outbound++; throw new Error('unexpected fixture outbound'); }; });
      assert.throws(() => assemble(wrongOrigin)); assert.equal(outbound, 0);
    } finally { outboundPorts.forEach(([owner, key], index) => { owner[key] = originals[index]; }); }
    count++;
    await commit('origin-restored');
    const expired = args(host); expired.proofs[0].proof = host.issueProof(sourceA, 1); await new Promise(resolve => setTimeout(resolve, 5)); assert.throws(() => assemble(expired)); count++;
    const ttl = args(host); ttl.proofs[0].proof = host.issueProof(sourceA, 20); const short = assemble(ttl); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(short.signal.aborted, true); count++;
    const preserved = assemble(args(host));
    await assert.rejects(routesDb.transaction(async manager => {
      await manager.update(RuntimeAssetEntity, assetId, { name: 'rolled-back' });
      throw new Error('fixture rollback');
    }));
    assert.equal(inspect(preserved)[0].snapshot, host.captureSnapshot());
    assert.equal((await routesDb.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: assetId })).name, 'registration'); close(preserved); count++;
    const ordinary = assemble(args(host));
    f.store.activate(f.store.stage(f.material('next')), f.generation);
    assert.equal(ordinary.signal.aborted, false); assert.equal(inspect(ordinary)[0].providerEpoch, f.input.expectedGeneration); close(ordinary); count++;
    const race = args(host); let stopped = false;
    race.compiler = { ...compiler, authorizeTarget(...values) {
      const allowed = compiler.authorizeTarget(...values);
      if (!stopped) { stopped = true; service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: assetId }); }
      return allowed;
    } };
    assert.throws(() => assemble(race)); count++;
    await restored();
    const late = assemble(args(host)), read = service.readCommittedSnapshotRows.bind(service);
    let release, ready; const held = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { ready = resolve; });
    service.readCommittedSnapshotRows = async () => { const rows = await read(); ready(); await held; return rows; };
    const pending = service.reload(); await reading;
    service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: assetId });
    assert.equal(late.signal.aborted, true); release(); await pending;
    assert.equal(service.readActiveRouteCatalog().routes.length, 0); assert.throws(() => inspect(late));
    service.readCommittedSnapshotRows = read;
    await restored(); count++;
    const revoked = assemble(args(host)); f.store.revoke(f.generation); assert.equal(revoked.signal.aborted, true); assert.throws(() => inspect(revoked)); count++;
    const second = await makeHost(), shut = assemble(args(second.host)); second.host.close(); assert.equal(shut.signal.aborted, true); assert.throws(() => assertHost(second.host)); count++;
    for (const reason of ['gateway_stopped', 'gateway_deleted']) {
      // A fresh service reload after stop remains fenced: a new committed revision is required.
      await routesDb.getRepository(RuntimeAssetEntity).update(assetId, { status: RuntimeAssetStatus.ACTIVE });
      await restored();
      await commit('v-' + reason);
      const active = await makeHost(), registered = assemble(args(active.host));
      service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.' + reason, runtimeAssetId: assetId });
      assert.equal(registered.signal.aborted, true); assert.throws(() => inspect(registered)); count++;
    }
    return count;
  } finally { service.onModuleDestroy(); }
}
async function facadeChecks(pg) {
  const { createGatewayNetworkHostProviders } = require('../dist/src/modules/gateway-runtime/services/gateway-network-host.providers');
  const { createGatewayNetworkRegistrationBundle: assemble } = require('../dist/src/modules/gateway-runtime/services/gateway-network-registration-coordinator');
  const { assertGatewayTrustedNetworkProvider } = require('../dist/src/modules/gateway-runtime/services/gateway-trusted-network.provider');
  const { createNetworkPolicyCompiler } = require('api-nova-parser');
  const { GatewayRouteSnapshotEntity } = require('../dist/src/database/entities/gateway-route-snapshot.entity');
  const { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } = require('../dist/src/database/entities/runtime-asset.entity');
  const { GatewayRouteSnapshotService } = require('../dist/src/modules/gateway-runtime/services/gateway-route-snapshot.service');
  const { GatewayPolicyService } = require('../dist/src/modules/gateway-runtime/services/gateway-policy.service');
  const { GatewayRoutePathMatchMode } = require('../dist/src/database/entities/gateway-route-binding.entity');
  let count = 0, facade;
  const document = candidate(); document.sites.forEach(site => { site.headerPolicy = { version: 1 }; });
  const left = fixture(document), right = fixture(document, false, 'next');
  const host = await boot(left.token(), pg), nextHost = await boot(right.token(), pg); dispose.push(host.close, nextHost.close);
  let policyHost = host;
  const policies = new GatewayPolicyService({ captureSnapshot: () => policyHost.captureSnapshot() });
  const runtimeId = '00000000-0000-0000-0000-000000000100';
  const runtimeAsset = await pg.getRepository(RuntimeAssetEntity).save({ id: runtimeId, name: 'facade', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
  const service = new GatewayRouteSnapshotService(policies, {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {});
  const binding = { id: 'facade-route', endpointDefinitionId: endpointA, authPolicyRef: 'jwt-default', pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamMethod: 'GET', upstreamPath: '/items', createdAt: new Date(), updatedAt: new Date(), upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } };
  const entries = [{ runtimeAsset, routeBinding: binding, membership: { id: 'facade-member', publicationRevision: 1 }, publishBinding: { id: 'facade-pub' }, sourceServiceAsset: { id: sourceA }, endpointDefinition: { id: endpointA }, sourceServiceInstance: { id: 'instance' }, normalizedRoutePath: '/facade', routeMethod: 'GET', upstreamBaseUrl: 'https://a.example', priorityScore: 1, policies: policies.compileForRoute(binding) }];
  const fingerprint = service.fingerprintEntries(entries);
  service.candidateSnapshots.set('facade-v1', { runtimeAssetId: runtimeId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
  await pg.transaction(async manager => {
    await service.activateCandidate('facade-v1', manager);
    await manager.update(RuntimeAssetEntity, runtimeId, { metadata: { activeRevision: 'facade-v1', activeGatewaySnapshotFingerprint: fingerprint } });
  });
  // The earlier c2 fixture's independent asset is stopped in persistent state for this read model.
  await pg.getRepository(RuntimeAssetEntity).update('00000000-0000-0000-0000-000000000099', { status: RuntimeAssetStatus.OFFLINE, metadata: {} });
  await service.reload();
  const route = service.resolve('localhost', 'GET', '/facade'); assert.ok(route);
  const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
  const policy = compiler.compile({ version: 1, id: 'facade-policy', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin: 'https://a.example', mode: 'public', connection: 'direct' });
  const installation = (active, ttlMs, routeService = service) => ({ compiler, servers: ['127.0.0.1:1'], bundle: assemble({ routes: routeService, capture: routeService.captureActiveRouteCatalog(routeService.readActiveRouteCatalog()), host: active, compiler, policies: [{ routeBindingId: 'facade-route', siteId: 'site0', policy }], proofs: [{ sourceServiceAssetId: sourceA, providerEpoch: active.readEpoch(sourceA), proof: active.issueProof(sourceA, ttlMs) }] }) });
  let callbacks = 0;
  const prepare = () => facade.provider.prepare(route, 'https://a.example/items', () => { callbacks++; throw new Error('unpaired resolver must not run'); }, { deadline: Date.now() + 5000 });
  try {
    assert.equal(createGatewayNetworkHostProviders(), null);
    const first = installation(host); facade = createGatewayNetworkHostProviders(first); assertGatewayTrustedNetworkProvider(facade.provider); assert.throws(() => assertGatewayTrustedNetworkProvider({ ...facade.provider })); count++;
    const provider = facade.provider, resolver = facade.resolver;
    const oldPending = prepare();
    const replacement = installation(nextHost); facade.install(replacement);
    const old = await oldPending, fresh = await prepare();
    assert.equal(provider, facade.provider); assert.equal(resolver, facade.resolver);
    assert.equal(old.credentials.headers.authorization, 'Basic ' + Buffer.from('user-old:pass-old').toString('base64'));
    assert.equal(fresh.credentials.headers.authorization, 'Basic ' + Buffer.from('user-next:pass-next').toString('base64'));
    assert.equal(callbacks, 0); assert.throws(() => facade.install(replacement)); count++;
    assert.throws(() => facade.install({ ...replacement, bundle: { ...replacement.bundle } }));
    const afterBad = await prepare(); assert.equal(afterBad.credentials.headers.authorization, fresh.credentials.headers.authorization); facade.provider.close(afterBad.lease); count++;
    host.close(); assert.equal(first.bundle.signal.aborted, true); assert.throws(() => policies.compileForRoute(binding));
    await assert.rejects(provider.send(old.lease, {}));
    const afterOldClose = await prepare(); assert.equal(afterOldClose.credentials.headers.authorization, fresh.credentials.headers.authorization); provider.close(afterOldClose.lease); count++;
    right.store.revoke(right.generation); assert.equal(replacement.bundle.signal.aborted, true);
    assert.equal(provider.requires(route), true); await assert.rejects(prepare()); await assert.rejects(provider.send(fresh.lease, {}));
    assert.equal(provider.requires({ ...route, routeBinding: { ...route.routeBinding, id: 'new-id' } }), true); count++;
    const recoveryFixture = fixture(document, false, 'recovered'), recovery = await boot(recoveryFixture.token(), pg); dispose.push(recovery.close); policyHost = recovery;
    const short = installation(recovery, 30); facade.install(short);
    await new Promise(resolve => { if (short.bundle.signal.aborted) resolve(); else short.bundle.signal.addEventListener('abort', resolve, { once: true }); });
    assert.equal(provider.requires(route), true); await assert.rejects(prepare()); assert.throws(() => facade.install(short)); count++;
    facade.install(installation(recovery)); const recovered = await prepare(); assert.match(recovered.credentials.headers.authorization, /^Basic /); provider.close(recovered.lease); count++;
    let bounded; const boundedServices = [];
    try {
      for (let index = 0; index <= 128; index++) {
        const boundedPolicies = new GatewayPolicyService({ captureSnapshot: () => recovery.captureSnapshot() });
        const ownRoutes = new GatewayRouteSnapshotService(boundedPolicies, {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {});
        boundedServices.push(ownRoutes); await ownRoutes.reload();
        const install = installation(recovery, undefined, ownRoutes);
        if (index === 128) { assert.throws(() => bounded.install(install)); break; }
        if (!bounded) bounded = createGatewayNetworkHostProviders(install); else bounded.install(install);
        const ownRoute = ownRoutes.resolve('localhost', 'GET', '/facade');
        const retained = await bounded.provider.prepare(ownRoute, 'https://a.example/items', () => { throw new Error('foreign callback'); }, { deadline: Date.now() + 20000 });
        assert.ok(retained.lease);
      }
      assert.equal(bounded.provider.requires(route), true);
      assert.ok((await bounded.resolver.resolve(boundedServices[127].resolve('localhost', 'GET', '/facade'), 'https://a.example/items', 'GET')).headers.authorization);
      count++;
    } finally { bounded?.close(); boundedServices.forEach(value => value.onModuleDestroy()); }
    const explicit = await prepare(); provider.revoke('facade-route');
    await assert.rejects(provider.send(explicit.lease, {})); assert.equal(provider.requires(route), true); await assert.rejects(prepare()); count++;
    facade.install(installation(recovery));
    // A committed catalog growth cannot evict prior protection when tombstone capacity is exceeded.
    const grown = Array.from({ length: 1024 }, (_, index) => ({ ...entries[0], membership: { ...entries[0].membership, id: 'grown-member' }, routeBinding: { ...binding, id: 'grown-' + String(index).padStart(4, '0') }, normalizedRoutePath: '/grown-' + String(index).padStart(4, '0') }));
    const growthFingerprint = service.fingerprintEntries(grown);
    service.candidateSnapshots.set('facade-growth', { runtimeAssetId: runtimeId, entries: grown, snapshotFingerprint: growthFingerprint, preparedAt: new Date() });
    await pg.transaction(async manager => {
      await service.activateCandidate('facade-growth', manager);
      await manager.update(RuntimeAssetEntity, runtimeId, { metadata: { activeRevision: 'facade-growth', activeGatewaySnapshotFingerprint: growthFingerprint } });
    });
    await service.reload();
    const changedRoute = service.resolve('localhost', 'GET', '/grown-0000');
    assert.ok(changedRoute); assert.notEqual(changedRoute.routeBinding.id, route.routeBinding.id); assert.notEqual(changedRoute.membership.id, route.membership.id);
    assert.equal(provider.requires(changedRoute), true);
    await assert.rejects(provider.prepare(changedRoute, 'https://a.example/items', () => { callbacks++; throw new Error('legacy fallback'); }, { deadline: Date.now() + 1000 }));
    const growthBundle = assemble({ routes: service, capture: service.captureActiveRouteCatalog(service.readActiveRouteCatalog()), host: recovery, compiler,
      policies: grown.map(value => ({ routeBindingId: value.routeBinding.id, siteId: 'site0', policy })),
      proofs: [{ sourceServiceAssetId: sourceA, providerEpoch: recovery.readEpoch(sourceA), proof: recovery.issueProof(sourceA) }] });
    assert.throws(() => facade.install({ compiler, servers: ['127.0.0.1:1'], bundle: growthBundle }));
    assert.equal(provider.requires({ ...route, runtimeAsset: { ...route.runtimeAsset, id: 'unknown-after-capacity' }, routeBinding: { ...route.routeBinding, id: 'unknown' }, membership: { id: 'unknown' } }), true);
    assert.equal(provider.requires(route), true); await assert.rejects(prepare()); count++;

    service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: runtimeId });
    assert.equal(provider.requires(route), true); await assert.rejects(prepare()); count++;
    facade.close(); facade.close(); assert.equal(provider.requires(route), true); assert.equal(callbacks, 0); count++;
    return count;
  } finally { facade?.close(); service.onModuleDestroy(); }
}
async function bootstrapChecks(pg) {
  const http = require('node:http');
  const { ConfigService } = require('@nestjs/config');
  const { Test } = require('@nestjs/testing');
  const { createGatewayHostRuntime, GATEWAY_HOST_RUNTIME } = require('../dist/src/modules/gateway-runtime/services/gateway-host-runtime.providers');
  const { createGatewayNetworkHostSource, GATEWAY_NETWORK_HOST_SOURCE, GATEWAY_NETWORK_HOST_FACADE,
    GatewayNetworkHostBootstrapService } = require('../dist/src/modules/gateway-runtime/services/gateway-network-host-bootstrap.service');
  const { GatewayRouteSnapshotService } = require('../dist/src/modules/gateway-runtime/services/gateway-route-snapshot.service');
  const { GatewayPolicyService } = require('../dist/src/modules/gateway-runtime/services/gateway-policy.service');
  const { GatewayProxyEngineService } = require('../dist/src/modules/gateway-runtime/services/gateway-proxy-engine.service');
  const { GATEWAY_TRUSTED_NETWORK_PROVIDER, createGatewayTrustedNetworkFacade } = require('../dist/src/modules/gateway-runtime/services/gateway-trusted-network.provider');
  const { GatewayRouteSnapshotEntity } = require('../dist/src/database/entities/gateway-route-snapshot.entity');
  const { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } = require('../dist/src/database/entities/runtime-asset.entity');
  const { GatewayRoutePathMatchMode } = require('../dist/src/database/entities/gateway-route-binding.entity');
  const { createNetworkPolicyCompiler } = require('api-nova-parser');
  let count = 0, seen = 0;
  const upstream = http.createServer((_req, res) => { seen++; res.setHeader('content-type', 'text/plain'); res.end('host-network-ok'); });
  const upstreamPort = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
  const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  const getStatus = (port, path) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }).on('error', reject);
  });
  try {
    const document = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'boot-r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: {}, credentials: {},
      sites: [{ id: 'site0', sourceServiceAssetId: sourceA, match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none', headerPolicy: { version: 1, responseHeaders: ['content-type'] }, endpoints: [{ endpointDefinitionId: endpointA }] }] };
    const f = fixture(document), host = await boot(f.token(), pg); dispose.push(host.close);
    for (const id of ['00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000100'])
      await pg.getRepository(RuntimeAssetEntity).update(id, { status: RuntimeAssetStatus.OFFLINE, metadata: {} });
    const runtimeId = '00000000-0000-0000-0000-000000000200';
    const runtimeAsset = await pg.getRepository(RuntimeAssetEntity).save({ id: runtimeId, name: 'host-network', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    const hostRuntime = createGatewayHostRuntime({ captureSnapshot: () => host.captureSnapshot() });
    const policies = new GatewayPolicyService(null, hostRuntime);
    const service = new GatewayRouteSnapshotService(policies, {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {});
    const binding = { id: 'boot-route', endpointDefinitionId: endpointA, authPolicyRef: 'jwt-default', pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamMethod: 'GET', upstreamPath: '/items', createdAt: new Date(), updatedAt: new Date(), upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } };
    const entries = [{ runtimeAsset, routeBinding: binding, membership: { id: 'boot-member', publicationRevision: 1 }, publishBinding: { id: 'boot-pub' }, sourceServiceAsset: { id: sourceA }, endpointDefinition: { id: endpointA }, sourceServiceInstance: { id: 'instance' }, normalizedRoutePath: '/boot', routeMethod: 'GET', upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort, priorityScore: 1, policies: policies.compileForRoute(binding) }];
    const fingerprint = service.fingerprintEntries(entries);
    service.candidateSnapshots.set('boot-v1', { runtimeAssetId: runtimeId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
    await pg.transaction(async manager => {
      await service.activateCandidate('boot-v1', manager);
      await manager.update(RuntimeAssetEntity, runtimeId, { metadata: { activeRevision: 'boot-v1', activeGatewaySnapshotFingerprint: fingerprint } });
    });
    await service.reload();
    const route = service.resolve('localhost', 'GET', '/boot'); assert.ok(route);
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const exception = (siteId, origin) => ({ id: 'boot-exception', revision: '1', sourceServiceAssetId: sourceA, siteId, origin, addresses: ['127.0.0.1'], purpose: 'isolated test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() });
    const policyFor = ({ route: target, siteId }) => compiler.compile({ version: 1, id: 'boot:' + target.routeBinding.id, revision: '1', sourceServiceAssetId: sourceA, siteId, origin: new URL(target.upstreamBaseUrl).origin, mode: 'private-exception', connection: 'direct', privateException: exception(siteId, new URL(target.upstreamBaseUrl).origin) });
    const hostSource = createGatewayNetworkHostSource({ host, compiler, servers: ['127.0.0.1:53'], policyFor });
    const facade = createGatewayTrustedNetworkFacade();
    const makeRoutes = () => new GatewayRouteSnapshotService(new GatewayPolicyService(null, hostRuntime), {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {});
    const bootModule = (config, source = hostSource, routes = makeRoutes()) => Test.createTestingModule({ providers: [
      { provide: GATEWAY_HOST_RUNTIME, useValue: hostRuntime },
      { provide: GATEWAY_NETWORK_HOST_SOURCE, useValue: source },
      { provide: GATEWAY_NETWORK_HOST_FACADE, useValue: facade },
      { provide: GATEWAY_TRUSTED_NETWORK_PROVIDER, useFactory: value => value.provider, inject: [GATEWAY_NETWORK_HOST_FACADE] },
      GatewayNetworkHostBootstrapService,
      { provide: GatewayRouteSnapshotService, useValue: routes },
      { provide: ConfigService, useValue: new ConfigService(config) },
      { provide: GatewayProxyEngineService, useFactory: provider => new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) }, null, undefined, undefined, provider), inject: [GATEWAY_TRUSTED_NETWORK_PROVIDER] },
    ] }).compile();
    const positiveRoutes = makeRoutes();
    const module = await bootModule({}, hostSource, positiveRoutes);
    const app = module.createNestApplication();
    app.use('/boot-gateway', (req, res) => {
      const current = positiveRoutes.resolve('localhost', 'GET', '/boot');
      void module.get(GatewayProxyEngineService).forward(current, req, res).catch(error => { console.error('[BOOT-FIXTURE]', error.stack || error); res.status(error.getStatus?.() ?? 500).json({ code: error.message }); });
    });
    await app.init();
    assert.equal(hostRuntime.state().locked, false);
    await app.listen(0, '127.0.0.1');
    try {
      const result = await getStatus(app.getHttpServer().address().port, '/boot-gateway');
      assert.equal(result.status, 200, result.body); assert.equal(result.body, 'host-network-ok'); assert.equal(seen, 1); count++;
    } finally { await app.close(); }
    const conflictModule = await bootModule({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: 'legacy.json' });
    const conflictApp = conflictModule.createNestApplication();
    try { await conflictApp.init(); throw new Error('conflicting host source was accepted'); }
    catch (error) { assert.match(String(error), /gateway_network_host_installation_conflict/); count++; }
    finally { await conflictApp.close().catch(() => undefined); }
    const badSource = createGatewayNetworkHostSource({ host, compiler, servers: ['127.0.0.1:53'],
      policyFor: () => compiler.compile({ version: 1, id: 'wrong', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin: 'https://wrong.example', mode: 'public', connection: 'direct' }) });
    const failedRoutes = makeRoutes();
    const failedModule = await bootModule({}, badSource, failedRoutes);
    const failedApp = failedModule.createNestApplication();
    const { GatewayRuntimeService } = require('../dist/src/modules/gateway-runtime/services/gateway-runtime.service');
    const lockedRuntime = new GatewayRuntimeService(failedRoutes, {}, {}, {}, failedModule.get(GatewayProxyEngineService), {}, {},
      { assertAllowed: async () => undefined }, hostRuntime);
    failedApp.use('/boot-gateway', (req, res) => { void lockedRuntime.forwardRequest('boot', req, res).catch(error => res.status(error.getStatus?.() ?? 500).json({ code: error.message })); });
    await failedApp.init();
    assert.equal(hostRuntime.state().locked, true);
    await failedApp.listen(0, '127.0.0.1');
    try {
      const result = await getStatus(failedApp.getHttpServer().address().port, '/boot-gateway');
      assert.equal(result.status, 503, result.body); assert.equal(seen, 1); count++;
    } finally { await failedApp.close(); }
    service.onModuleDestroy();
    return count;
  } finally { await closeServer(upstream); }
}
async function lifecycleChecks(pg) {
  const http = require('node:http');
  const { getEventListeners } = require('node:events');
  const { createGatewayHostRuntime } = require('../dist/src/modules/gateway-runtime/services/gateway-host-runtime.providers');
  const { createGatewayTrustedNetworkFacade } = require('../dist/src/modules/gateway-runtime/services/gateway-trusted-network.provider');
  const { createGatewayNetworkRegistrationBundle: assemble, closeGatewayNetworkRegistrationBundle: closeBundle } = require('../dist/src/modules/gateway-runtime/services/gateway-network-registration-coordinator');
  const { GatewayRouteSnapshotEntity } = require('../dist/src/database/entities/gateway-route-snapshot.entity');
  const { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } = require('../dist/src/database/entities/runtime-asset.entity');
  const { GatewayRouteSnapshotService } = require('../dist/src/modules/gateway-runtime/services/gateway-route-snapshot.service');
  const { GatewayPolicyService } = require('../dist/src/modules/gateway-runtime/services/gateway-policy.service');
  const { GatewayRoutePathMatchMode } = require('../dist/src/database/entities/gateway-route-binding.entity');
  const { createNetworkPolicyCompiler } = require('api-nova-parser');
  let count = 0, seen = [], slowRelease = null;
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers['x-retired-host']);
    if (!slowRelease) { res.end('fast'); return; }
    const release = slowRelease; slowRelease = null;
    res.write('partial');
    release.then(() => res.end('tail'));
  });
  const upstreamPort = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
  const waitFor = async (check, ms = 5000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error('fixture wait timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  const origin = 'http://127.0.0.1:' + upstreamPort;
  const document = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'life-r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { first: { type: 'env' } },
    credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Retired-Host' }, secretRef: 'first:TOKEN' } },
    sites: [{ id: 'site0', sourceServiceAssetId: sourceA, match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key', headerPolicy: { version: 1 }, endpoints: [{ endpointDefinitionId: endpointA }] }] };
  try {
    for (const id of ['00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000200'])
      await pg.getRepository(RuntimeAssetEntity).update(id, { status: RuntimeAssetStatus.OFFLINE, metadata: {} });
    const runtimeId = '00000000-0000-0000-0000-000000000300';
    const runtimeAsset = await pg.getRepository(RuntimeAssetEntity).save({ id: runtimeId, name: 'lifecycle', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    const oldFixture = fixture(document, false, 'old'), oldHost = await boot(oldFixture.token(), pg);
    const nextFixture = fixture(document, false, 'next'), nextHost = await boot(nextFixture.token(), pg);
    const expiryFixture = fixture(document, false, 'expiry'), expiryHost = await boot(expiryFixture.token(), pg);
    const hostRuntime = createGatewayHostRuntime({ captureSnapshot: () => oldHost.captureSnapshot() });
    const policies = new GatewayPolicyService(null, hostRuntime);
    const service = new GatewayRouteSnapshotService(policies, {}, pg.getRepository(GatewayRouteSnapshotEntity), {}, {}, pg.getRepository(RuntimeAssetEntity), {}, {}, {});
    const binding = { id: 'life-route', endpointDefinitionId: endpointA, authPolicyRef: 'jwt-default', pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamMethod: 'GET', upstreamPath: '/items', createdAt: new Date(), updatedAt: new Date(), upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } };
    const entries = [{ runtimeAsset, routeBinding: binding, membership: { id: 'life-member', publicationRevision: 1 }, publishBinding: { id: 'life-pub' }, sourceServiceAsset: { id: sourceA }, endpointDefinition: { id: endpointA }, sourceServiceInstance: { id: 'instance' }, normalizedRoutePath: '/life', routeMethod: 'GET', upstreamBaseUrl: origin, priorityScore: 1, policies: policies.compileForRoute(binding) }];
    const fingerprint = service.fingerprintEntries(entries);
    service.candidateSnapshots.set('life-v1', { runtimeAssetId: runtimeId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
    await pg.transaction(async manager => {
      await service.activateCandidate('life-v1', manager);
      await manager.update(RuntimeAssetEntity, runtimeId, { metadata: { activeRevision: 'life-v1', activeGatewaySnapshotFingerprint: fingerprint } });
    });
    await service.reload();
    const route = service.resolve('localhost', 'GET', '/life'); assert.ok(route);
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const policy = compiler.compile({ version: 1, id: 'life-policy', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin, mode: 'private-exception', connection: 'direct',
      privateException: { id: 'life-exception', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin, addresses: ['127.0.0.1'], purpose: 'isolated test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() } });
    const capture = () => service.captureActiveRouteCatalog(service.readActiveRouteCatalog());
    const installation = (active, ttlMs) => ({ compiler, servers: ['127.0.0.1:53'], bundle: assemble({ routes: service, capture: capture(), host: active, compiler,
      policies: [{ routeBindingId: 'life-route', siteId: 'site0', policy }],
      proofs: [{ sourceServiceAssetId: sourceA, providerEpoch: active.readEpoch(sourceA), proof: active.issueProof(sourceA, ttlMs) }] }) });
    const collect = async response => { const chunks = []; for await (const chunk of response.body) chunks.push(Buffer.from(chunk)); await response.completed; return Buffer.concat(chunks).toString(); };
    const facade = createGatewayTrustedNetworkFacade();
    const preparedFor = () => facade.provider.prepare(route, origin + '/items', () => { throw new Error('unpaired resolver'); }, { deadline: Date.now() + 10000 });
    const bundles = [];
    try {
      const first = installation(oldHost); bundles.push(first.bundle); facade.install(first);
      let resolveSlow; slowRelease = new Promise(resolve => { resolveSlow = resolve; });
      const oldPrepared = await preparedFor();
      const oldResponse = await facade.provider.send(oldPrepared.lease, { framing: { mode: 'none' } });
      const readingOld = collect(oldResponse).catch(error => error);
      await waitFor(() => seen.length === 1);
      const replacement = installation(nextHost); bundles.push(replacement.bundle);
      facade.install(replacement);
      resolveSlow();
      assert.equal(await readingOld, 'partialtail'); assert.equal(seen[0], 'token-old'); count++;
      const freshPrepared = await preparedFor();
      assert.equal(await collect(await facade.provider.send(freshPrepared.lease, { framing: { mode: 'none' } })), 'fast');
      assert.equal(seen[1], 'token-next'); count++;
      // A rejected installation keeps the current pair serving over real HTTP.
      const wrongPolicy = compiler.compile({ version: 1, id: 'wrong', revision: '1', sourceServiceAssetId: sourceA, siteId: 'site0', origin: 'https://wrong.example', mode: 'public', connection: 'direct' });
      assert.throws(() => assemble({ routes: service, capture: capture(), host: nextHost, compiler,
        policies: [{ routeBindingId: 'life-route', siteId: 'site0', policy: wrongPolicy }],
        proofs: [{ sourceServiceAssetId: sourceA, providerEpoch: nextHost.readEpoch(sourceA), proof: nextHost.issueProof(sourceA) }] }));
      const keptPrepared = await preparedFor();
      assert.equal(await collect(await facade.provider.send(keptPrepared.lease, { framing: { mode: 'none' } })), 'fast');
      assert.equal(seen[2], 'token-next'); count++;
      // In-flight proof expiry aborts the active stream and releases the lease.
      const expired = installation(expiryHost, 40); bundles.push(expired.bundle); facade.install(expired);
      let releaseExpiry; slowRelease = new Promise(resolve => { releaseExpiry = resolve; });
      const expiryPrepared = await preparedFor();
      const expiryResponse = await facade.provider.send(expiryPrepared.lease, { framing: { mode: 'none' } });
      const pendingExpiry = collect(expiryResponse).catch(error => error);
      await waitFor(() => seen.length === 4);
      const expiredResult = await pendingExpiry;
      assert.ok(expiredResult instanceof Error);
      releaseExpiry(); count++;
      // Shutdown stops every pair and removes abort listeners synchronously.
      const hostSignals = [oldHost, nextHost, expiryHost].map(value => value.readSignal(sourceA));
      for (const bundle of bundles) closeBundle(bundle);
      facade.close();
      for (const value of [oldHost, nextHost, expiryHost]) value.close();
      for (const signal of hostSignals) assert.equal(signal.aborted, true);
      for (const bundle of bundles) assert.equal(getEventListeners(bundle.signal, 'abort').length, 0);
      for (const signal of hostSignals) assert.equal(getEventListeners(signal, 'abort').length, 0);
      count++;
    } finally { facade.close(); service.onModuleDestroy(); }
    return count;
  } finally { await closeServer(upstream); }
}
