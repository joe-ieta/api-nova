'use strict';
// SEC-F1-02F: F1 publication/activation/guard state persistence, reopen and the
// concurrent single-winner revision claim on a disposable PostgreSQL cluster.
// Requires migrations from the built API and runs only against the invocation's DB.
process.env.DB_TYPE = 'postgres';
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { buildDatabaseOptions } = require('../dist/src/database/database-options');
const { PublicationMemberTransactionWriter } = require('../dist/src/modules/publication/services/publication-member-transaction-writer');

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const contextDigest = 'a'.repeat(64);
const evidenceRow = (number, endpoint) => ({
  id: id(number), sourceServiceAssetId: id(1), endpointDefinitionId: endpoint, contextDigest,
  providerEpoch: id(90), runNonce: id(number), bindingRevision: 'r1', bindingGeneration: 1, actorId: 'actor',
  evidenceKind: 'production_challenge_v1', challengeVersion: 1, result: 'passed',
  anonymousBeforeStatus: 401, wrongCredentialStatus: 401, validCredentialStatus: 200, anonymousAfterStatus: 401,
  completedAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 3600000),
});

async function seed(db) {
  await db.getRepository('SourceServiceAssetEntity').save({ id: id(1), sourceKey: 'f1-02f-fixture' });
  await db.getRepository('EndpointDefinitionEntity').save({ id: id(2), sourceServiceAssetId: id(1), method: 'GET', path: '/target',
    rawOperation: { security: [{ Key: [] }], components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } } });
  await db.getRepository('EndpointDefinitionEntity').save({ id: id(3), sourceServiceAssetId: id(1), method: 'GET', path: '/open', rawOperation: {} });
  await db.getRepository('EndpointDefinitionEntity').save({ id: id(14), sourceServiceAssetId: id(1), method: 'GET', path: '/race-target', rawOperation: {} });
  await db.getRepository('RuntimeAssetEntity').save({ id: id(4), name: 'gw-fixture', type: 'gateway_service' });
  await db.getRepository('RuntimeAssetEntity').save({ id: id(5), name: 'mcp-fixture', type: 'mcp_server' });
  await db.getRepository('RuntimeAssetEndpointBindingEntity').save({ id: id(6), runtimeAssetId: id(4), endpointDefinitionId: id(2), publicationRevision: 0, enabled: true });
  await db.getRepository('RuntimeAssetEndpointBindingEntity').save({ id: id(7), runtimeAssetId: id(5), endpointDefinitionId: id(3), publicationRevision: 0, enabled: true });
  await db.getRepository('RuntimeAssetEndpointBindingEntity').save({ id: id(9), runtimeAssetId: id(4), endpointDefinitionId: id(14), publicationRevision: 0, enabled: true });
  await db.getRepository('GatewayRouteBindingEntity').save({ id: id(8), endpointDefinitionId: id(2), runtimeAssetEndpointBindingId: id(6),
    routePath: '/target', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET' });
  await db.getRepository('GatewayRouteBindingEntity').save({ id: id(10), endpointDefinitionId: id(14), runtimeAssetEndpointBindingId: id(9),
    routePath: '/race', routeMethod: 'GET', upstreamPath: '/race-target', upstreamMethod: 'GET' });
  await db.getRepository('UpstreamProductionChallengeEvidenceEntity').save(evidenceRow(11, id(2)));
  await db.getRepository('UpstreamProductionChallengeEvidenceEntity').save(evidenceRow(12, id(3)));
  await db.getRepository('UpstreamProductionChallengeEvidenceEntity').save(evidenceRow(13, id(14)));
}

async function publish(db, membershipId, evidenceId, revision) {
  const writer = new PublicationMemberTransactionWriter(db, async () => 'ctx-v1');
  const ticket = await writer.prepare({ membershipId, evidenceId });
  const committed = await writer.commit(ticket);
  assert.equal(committed.publicationRevision, revision);
  return committed;
}

async function main() {
  const options = buildDatabaseOptions();
  let db = await new DataSource(options).initialize();
  const applied = await db.runMigrations({ transaction: 'all' });
  assert.equal(applied.length, db.migrations.length, 'every migration must apply once on the empty isolated database');
  const entityCount = db.entityMetadatas.length;
  const tables = db.entityMetadatas.map(metadata => metadata.tableName).sort();
  for (const table of tables) {
    const rows = await db.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    assert.equal(rows[0].count, 0, `${table} must start empty`);
  }
  const version = (await db.query('SHOW server_version'))[0].server_version;
  await seed(db);
  await publish(db, id(6), id(11), 1);
  await publish(db, id(7), id(12), 1);

  const state = async source => ({
    memberships: await source.getRepository('RuntimeAssetEndpointBindingEntity').find({ order: { id: 'ASC' } }),
    bindings: await source.getRepository('EndpointPublishBindingEntity').find({ order: { id: 'ASC' } }),
    profiles: await source.getRepository('PublicationProfileEntity').find({ order: { id: 'ASC' } }),
    routes: await source.getRepository('GatewayRouteBindingEntity').find({ order: { id: 'ASC' } }),
    runtimes: await source.getRepository('RuntimeAssetEntity').find({ order: { id: 'ASC' } }),
    evidence: await source.getRepository('UpstreamProductionChallengeEvidenceEntity').find({ order: { id: 'ASC' } }),
  });
  const before = await state(db);
  await db.destroy();

  // 1) Reopen: every activation/guard/membership value must survive with zero drift.
  db = await new DataSource(options).initialize();
  assert.equal((await db.runMigrations({ transaction: 'all' })).length, 0, 'reopen must not replay migrations');
  assert.equal(db.entityMetadatas.length, entityCount, 'entity registry must not change across reopen');
  assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0, 'reopen schema drift');
  assert.deepEqual(await state(db), before, 'persisted activation/guard/membership rows changed across reopen');
  const gatewayMembership = await db.getRepository('RuntimeAssetEndpointBindingEntity').findOneByOrFail({ id: id(6) });
  assert.equal(gatewayMembership.status, 'active');
  assert.equal(gatewayMembership.publicationRevision, 1);
  const gatewayBinding = await db.getRepository('EndpointPublishBindingEntity').findOneByOrFail({ runtimeAssetEndpointBindingId: id(6) });
  assert.equal(gatewayBinding.publishedToHttp, true);
  assert.equal(gatewayBinding.publishedToMcp, false);
  assert.equal(gatewayBinding.publicationRevision, 1);
  const mcpMembership = await db.getRepository('RuntimeAssetEndpointBindingEntity').findOneByOrFail({ id: id(7) });
  assert.equal(mcpMembership.publicationRevision, 1);
  const mcpBinding = await db.getRepository('EndpointPublishBindingEntity').findOneByOrFail({ runtimeAssetEndpointBindingId: id(7) });
  assert.equal(mcpBinding.publishedToMcp, true);
  assert.equal(mcpBinding.publishedToHttp, false);
  assert.match((await db.getRepository('UpstreamProductionChallengeEvidenceEntity').findOneByOrFail({ id: id(11) })).contextDigest, /^[a-f0-9]{64}$/);

  // 2) Revocation persists across another reopen and blocks any late publish with zero writes.
  const revokedAt = new Date();
  await db.getRepository('UpstreamProductionChallengeEvidenceEntity').update({ id: id(11) }, { revokedAt });
  await db.destroy();
  db = await new DataSource(options).initialize();
  assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0, 'revoked reopen schema drift');
  assert.ok((await db.getRepository('UpstreamProductionChallengeEvidenceEntity').findOneByOrFail({ id: id(11) })).revokedAt);
  const frozen = await state(db);
  await assert.rejects(() => publish(db, id(6), id(11), 2), /publication_transaction_validation_failed/);
  assert.deepEqual(await state(db), frozen, 'late publish after persisted revocation must write nothing');

  // 3) Optimistic CAS: a ticket prepared before a concurrent revision move loses without writes.
  const stale = new PublicationMemberTransactionWriter(db, async () => 'ctx-v1');
  const staleTicket = await stale.prepare({ membershipId: id(9), evidenceId: id(13) });
  await publish(db, id(9), id(13), 1);
  const afterWinner = await state(db);
  await assert.rejects(() => stale.commit(staleTicket), /publication_transaction_(context_changed|revision_conflict|revision_mismatch)/);
  assert.deepEqual(await state(db), afterWinner, 'losing stale ticket must write nothing');

  // 4) Two real connections race the same revision: exactly one durable winner.
  const first = await new DataSource({ ...options, migrations: [] }).initialize();
  const second = await new DataSource({ ...options, migrations: [] }).initialize();
  let concurrency;
  try {
    const evidence = await first.getRepository('UpstreamProductionChallengeEvidenceEntity').findOneByOrFail({ id: id(13) });
    assert.equal(evidence.result, 'passed');
    const firstWriter = new PublicationMemberTransactionWriter(first, async () => 'ctx-v1');
    const secondWriter = new PublicationMemberTransactionWriter(second, async () => 'ctx-v1');
    const firstTicket = await firstWriter.prepare({ membershipId: id(9), evidenceId: id(13) });
    const secondTicket = await secondWriter.prepare({ membershipId: id(9), evidenceId: id(13) });
    const settled = await Promise.allSettled([firstWriter.commit(firstTicket), secondWriter.commit(secondTicket)]);
    const fulfilled = settled.filter(entry => entry.status === 'fulfilled');
    const rejected = settled.filter(entry => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one connection may win the revision claim');
    assert.equal(rejected.length, 1, 'exactly one connection must lose the revision claim');
    const loserMessage = String(rejected[0].reason && rejected[0].reason.message);
    assert.match(loserMessage, /publication_transaction_(context_changed|revision_conflict|revision_mismatch)|could not serialize/i,
      `loser must fail closed, got: ${loserMessage}`);
    concurrency = { winners: fulfilled.length, losers: rejected.length, loserMessage };
  } finally {
    await first.destroy(); await second.destroy();
  }
  const finalMembership = await db.getRepository('RuntimeAssetEndpointBindingEntity').findOneByOrFail({ id: id(9) });
  assert.equal(finalMembership.publicationRevision, 2, 'the race must advance the revision exactly once');
  assert.equal((await db.getRepository('EndpointPublishBindingEntity').count({ where: { runtimeAssetEndpointBindingId: id(9) } })), 1);
  assert.equal((await db.getRepository('PublicationProfileEntity').count({ where: { runtimeAssetEndpointBindingId: id(9) } })), 1);
  assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0, 'final schema drift');
  await db.destroy();
  return { serverVersion: version, entities: entityCount, domainTables: tables.length, migrations: applied.length,
    reopen: true, schemaDrift: 0, revocations: true, gatewayPublication: true, mcpPublication: true,
    concurrency: { ...concurrency, revision: finalMembership.publicationRevision },
    zeroWritesAfterReject: true };
}

main().then(report => console.log(JSON.stringify({ marker: 'POSTGRES_F1_02F_OK', dialect: 'postgres', ...report })))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
