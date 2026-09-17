import { MigrationInterface, QueryRunner } from 'typeorm';

/** Legacy MCP rows remain NULL: no previous environment mode is inferred. */
export class McpInboundAuthModeSqlite1790000002000 implements MigrationInterface {
  name = 'McpInboundAuthModeSqlite1790000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "mcp_servers" ADD COLUMN "inboundAuthMode" varchar(32) CONSTRAINT "CHK_mcp_servers_inbound_auth_mode" CHECK ("inboundAuthMode" IN (\'private_jwt\', \'private_api_key\', \'anonymous\'))');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "mcp_servers" DROP COLUMN "inboundAuthMode"');
  }
}
