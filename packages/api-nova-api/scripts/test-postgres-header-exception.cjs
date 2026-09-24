'use strict';
// Only launched by the disposable-cluster wrapper with a scrubbed environment.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { GatewayRouteBindingEntity } = require('../dist/src/database/entities/gateway-route-binding.entity');
const { GatewayHeaderLegacyExceptionService } = require('../dist/src/modules/gateway-runtime/services/gateway-header-legacy-exception.service');
async function main() {
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.equal(process.env.DB_USERNAME, 'schema_fixture');
  const options = { type: 'postgres', host: '127.0.0.1', port: Number(process.env.DB_PORT), username: 'schema_fixture', password: '', database: 'postgres', entities: [GatewayRouteBindingEntity], synchronize: true };
  let db = await new DataSource(options).initialize();
  let now = Date.parse('2026-09-24T00:00:00Z');
  const context = { actorId: 'fixture-admin', registryConfigured: true, source: { source: 'registry', providerId: 'fixture-provider', siteId: 'fixture-site', providerFingerprint: 'a'.repeat(64) } };
  try {
    const repo = db.getRepository(GatewayRouteBindingEntity);
    const row = await repo.save(repo.create({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/pg-fixture', routeMethod: 'GET', upstreamPath: '/pg-fixture', upstreamMethod: 'GET', routeVisibility: 'internal', authPolicyRef: 'jwt-default', status: 'draft', upstreamConfig: { cache: { ttlMs: 1000 }, preserveHost: false } }));
    const grant = { version: 1, mode: 'legacy', routeId: row.id, owner: 'operator', reason: 'isolated fixture', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z', rollbackEvidence: 'test:rollback' };
    const svc = () => new GatewayHeaderLegacyExceptionService(db, () => now);
    const attempts = await Promise.allSettled([svc().register(row.id, grant, context), svc().register(row.id, grant, context)]);
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(x => x.status === 'rejected').length, 1);
    const id = attempts.find(x => x.status === 'fulfilled').value;
    await db.destroy(); db = await new DataSource({ ...options, synchronize: false }).initialize();
    await svc().validate(row.id, id, context);
    await assert.rejects(svc().validate(row.id, id, { ...context, registryConfigured: false }));
    now = Date.parse('2026-10-24T00:00:00Z');
    await assert.rejects(svc().validate(row.id, id, context));
    await svc().revoke(row.id, id, 'fixture-revoker');
    await db.destroy(); db = await new DataSource({ ...options, synchronize: false }).initialize();
    await assert.rejects(svc().validate(row.id, id, context));
    await assert.rejects(svc().register(row.id, grant, context));
    const persisted = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: row.id });
    assert.equal(persisted.status, 'draft');
    assert.equal(persisted.upstreamConfig.headerPolicyLegacyException.status, 'revoked');
    assert.deepEqual(persisted.upstreamConfig.headerPolicyMigration, grant);
    console.log(JSON.stringify({ marker: 'POSTGRES_HEADER_EXCEPTION_OK', dialect: 'postgres', concurrentCas: true, reopen: true, providerClosed: true, expiry: true, revocation: true, noActivation: true }));
  } finally { if (db.isInitialized) await db.destroy(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
