import { MigrationInterface, QueryRunner } from 'typeorm';

export class GatewayHeaderHistoryLedgerPostgres1790000009000 implements MigrationInterface {
  name = 'GatewayHeaderHistoryLedgerPostgres1790000009000';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of [
  "CREATE TABLE \"gateway_header_history_ledger\" (\"namespace\" character varying(200) NOT NULL, \"sourceKind\" character varying(16) NOT NULL, \"provenanceDigest\" character varying(64) NOT NULL, \"version\" integer NOT NULL, \"revision\" integer NOT NULL, \"headerNames\" text NOT NULL, CONSTRAINT \"CHK_gateway_header_history_revision\" CHECK (\"revision\" > 0), CONSTRAINT \"CHK_gateway_header_history_version\" CHECK (\"version\" = 1), CONSTRAINT \"CHK_gateway_header_history_source\" CHECK (\"sourceKind\" = 'registry'), CONSTRAINT \"PK_a5a96b72d7021f5f2ec778b3ce0\" PRIMARY KEY (\"namespace\"))"
]) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "gateway_header_history_ledger"');
  }
}
