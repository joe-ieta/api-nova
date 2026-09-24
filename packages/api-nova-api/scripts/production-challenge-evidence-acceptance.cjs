'use strict';
const assert = require('node:assert/strict');
/** Shared acceptance for SQL.js and a separately created disposable PostgreSQL instance. */
exports.acceptProductionEvidence = async function(DataSource, options, rejectsDatabaseProof) {
  let db;
  try {
    db = await new DataSource({ ...options, migrations: options.migrations.slice(0, -1) }).initialize();
    const legacyMigrations = await db.runMigrations();
    const prototype = await db.getRepository('upstream_authentication_evidence').save({ sourceServiceAssetId: 'source', endpointDefinitionId: 'endpoint', contextDigest: 'a'.repeat(64), providerEpoch: 'epoch', runNonce: 'prototype-run', bindingRevision: 'r1', bindingGeneration: 1, actorId: 'actor', result: 'passed' });
    await db.destroy();
    db = await new DataSource(options).initialize(); assert.equal((await db.runMigrations()).length, 1);
    let repo = db.getRepository('upstream_production_challenge_evidence'); assert.equal(await repo.count(), 0);
    const completedAt = new Date(Date.now() - 2000), expiresAt = new Date(Date.now() + 60000);
    const row = await repo.save({ sourceServiceAssetId: 'source', endpointDefinitionId: 'endpoint', contextDigest: 'b'.repeat(64), providerEpoch: 'epoch', runNonce: 'process-run', bindingRevision: 'r2', bindingGeneration: 2, actorId: 'actor', result: 'passed', anonymousBeforeStatus: 401, wrongCredentialStatus: 403, validCredentialStatus: 204, anonymousAfterStatus: 401, completedAt, expiresAt });
    assert.equal(row.evidenceKind, 'production_challenge_v1'); assert.equal(row.challengeVersion, 1);
    for (const changes of [{ evidenceKind: 'challenge_prototype' }, { failureCode: 'sensitive-arbitrary-error' }, { revokedAt: new Date(completedAt.getTime() - 1) }, { result: 'Verified' }, { challengeVersion: 2 }, { wrongCredentialStatus: 200 }, { anonymousAfterStatus: null }, { validCredentialStatus: 302 }, { anonymousBeforeStatus: 999 }, { bindingGeneration: 0 }, { expiresAt: completedAt }]) {
      await assert.rejects(() => repo.update(row.id, changes));
    }
    assert.equal(await rejectsDatabaseProof(row), true);
    assert.equal(await rejectsDatabaseProof(prototype), true);
    await repo.update(row.id, { expiresAt: new Date(Date.now() - 1000), revokedAt: new Date() });
    assert.equal(await repo.createQueryBuilder('e').where('e.expiresAt < :now', { now: new Date() }).andWhere('e.revokedAt IS NOT NULL').getCount(), 1);
    assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
    const metadata = db.getMetadata('upstream_production_challenge_evidence');
    assert.ok(!metadata.columns.some(column => /secret|headers|response|hmac/i.test(column.propertyName)));
    await db.destroy(); db = await new DataSource(options).initialize(); assert.equal((await db.runMigrations()).length, 0);
    repo = db.getRepository('upstream_production_challenge_evidence'); const reopened = await repo.findOneByOrFail({ id: row.id });
    assert.ok(reopened.revokedAt); assert.ok(reopened.expiresAt < new Date()); assert.equal(await rejectsDatabaseProof(reopened), true);
    assert.equal((await db.getRepository('upstream_authentication_evidence').findOneByOrFail({ id: prototype.id })).evidenceKind, 'challenge_prototype');
    assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
    await db.undoLastMigration(); assert.equal(await db.createQueryRunner().hasTable('upstream_production_challenge_evidence'), false);
    assert.equal(await db.getRepository('upstream_authentication_evidence').count(), 1);
    assert.equal((await db.runMigrations()).length, 1); assert.equal(await db.getRepository('upstream_production_challenge_evidence').count(), 0);
    assert.equal((await db.driver.createSchemaBuilder().log()).upQueries.length, 0);
    return { legacyMigrations: legacyMigrations.length, entities: db.entityMetadatas.length, migrations: options.migrations.length, checks: true, reopen: true, expiry: true, revocation: true, prototypeIsolation: true, noProof: true, reversible: true, schemaDrift: 0 };
  } finally { if (db?.isInitialized) await db.destroy(); }
};
