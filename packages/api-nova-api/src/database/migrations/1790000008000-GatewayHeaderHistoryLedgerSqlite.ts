import { MigrationInterface, QueryRunner } from 'typeorm';

export class GatewayHeaderHistoryLedgerSqlite1790000008000 implements MigrationInterface {
  name = 'GatewayHeaderHistoryLedgerSqlite1790000008000';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of [
  "CREATE TABLE \"gateway_header_history_ledger\" (\"namespace\" varchar(200) PRIMARY KEY NOT NULL, \"sourceKind\" varchar(16) NOT NULL, \"provenanceDigest\" varchar(64) NOT NULL, \"version\" integer NOT NULL, \"revision\" integer NOT NULL, \"headerNames\" text NOT NULL, CONSTRAINT \"CHK_gateway_header_history_revision\" CHECK (\"revision\" > 0), CONSTRAINT \"CHK_gateway_header_history_version\" CHECK (\"version\" = 1), CONSTRAINT \"CHK_gateway_header_history_source\" CHECK (\"sourceKind\" = 'registry'))"
]) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "gateway_header_history_ledger"');
  }
}
