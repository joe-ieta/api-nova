import { MigrationInterface, QueryRunner } from 'typeorm';

/** Challenge observations; not trusted publication authorization. */
export class UpstreamAuthenticationEvidencePostgres1790000007000 implements MigrationInterface {
  name = 'UpstreamAuthenticationEvidencePostgres1790000007000';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of [
  "CREATE TABLE \"upstream_authentication_evidence\" (\"evidenceKind\" character varying(32) NOT NULL DEFAULT 'challenge_prototype', \"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"sourceServiceAssetId\" character varying(36) NOT NULL, \"endpointDefinitionId\" character varying(36) NOT NULL, \"contextDigest\" character varying(64) NOT NULL, \"providerEpoch\" character varying(36) NOT NULL, \"runNonce\" character varying(36) NOT NULL, \"bindingRevision\" character varying(128) NOT NULL, \"bindingGeneration\" integer NOT NULL, \"actorId\" character varying(128) NOT NULL, \"result\" character varying(16) NOT NULL, \"failureCode\" character varying(64), \"anonymousBeforeStatus\" integer, \"wrongCredentialStatus\" integer, \"validCredentialStatus\" integer, \"anonymousAfterStatus\" integer, \"createdAt\" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT \"CHK_upstream_auth_evidence_result\" CHECK (\"result\" IN ('passed', 'failed')), CONSTRAINT \"CHK_upstream_auth_evidence_kind\" CHECK (\"evidenceKind\" IN ('challenge_prototype')), CONSTRAINT \"PK_6af1b4740d6b3cfd577f27fa7ef\" PRIMARY KEY (\"id\"))",
  "CREATE INDEX \"IDX_upstream_auth_evidence_endpoint_created\" ON \"upstream_authentication_evidence\" (\"endpointDefinitionId\", \"createdAt\") "
]) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "upstream_authentication_evidence"');
  }
}
