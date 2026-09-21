import { MigrationInterface, QueryRunner } from 'typeorm';

/** No legacy credential is silently granted MCP access. */
export class RuntimeAccessCredentialSqlite1790000004000 implements MigrationInterface {
  name = 'RuntimeAccessCredentialSqlite1790000004000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "gateway_consumer_credentials" ADD COLUMN "accessPolicy" text');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "gateway_consumer_credentials" DROP COLUMN "accessPolicy"');
  }
}
