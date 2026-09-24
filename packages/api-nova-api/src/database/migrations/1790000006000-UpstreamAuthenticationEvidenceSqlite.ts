import { MigrationInterface, QueryRunner } from 'typeorm';

/** Challenge observations; not trusted publication authorization. */
export class UpstreamAuthenticationEvidenceSqlite1790000006000 implements MigrationInterface {
  name = 'UpstreamAuthenticationEvidenceSqlite1790000006000';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of [
  "CREATE TABLE \"upstream_authentication_evidence\" (\"evidenceKind\" varchar(32) NOT NULL DEFAULT ('challenge_prototype'), \"id\" varchar PRIMARY KEY NOT NULL, \"sourceServiceAssetId\" varchar(36) NOT NULL, \"endpointDefinitionId\" varchar(36) NOT NULL, \"contextDigest\" varchar(64) NOT NULL, \"providerEpoch\" varchar(36) NOT NULL, \"runNonce\" varchar(36) NOT NULL, \"bindingRevision\" varchar(128) NOT NULL, \"bindingGeneration\" integer NOT NULL, \"actorId\" varchar(128) NOT NULL, \"result\" varchar(16) NOT NULL, \"failureCode\" varchar(64), \"anonymousBeforeStatus\" integer, \"wrongCredentialStatus\" integer, \"validCredentialStatus\" integer, \"anonymousAfterStatus\" integer, \"createdAt\" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT \"CHK_upstream_auth_evidence_result\" CHECK (\"result\" IN ('passed', 'failed')), CONSTRAINT \"CHK_upstream_auth_evidence_kind\" CHECK (\"evidenceKind\" IN ('challenge_prototype')))",
  "CREATE INDEX \"IDX_upstream_auth_evidence_endpoint_created\" ON \"upstream_authentication_evidence\" (\"endpointDefinitionId\", \"createdAt\") "
]) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "upstream_authentication_evidence"');
  }
}
