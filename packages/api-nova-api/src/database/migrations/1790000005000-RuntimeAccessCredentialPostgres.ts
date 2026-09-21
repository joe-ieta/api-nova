import { MigrationInterface, QueryRunner } from 'typeorm';

/** No legacy credential is silently granted MCP access. */
export class RuntimeAccessCredentialPostgres1790000005000 implements MigrationInterface {
  name = 'RuntimeAccessCredentialPostgres1790000005000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "gateway_consumer_credentials" ADD COLUMN "accessPolicy" jsonb');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "gateway_consumer_credentials" DROP COLUMN "accessPolicy"');
  }
}
