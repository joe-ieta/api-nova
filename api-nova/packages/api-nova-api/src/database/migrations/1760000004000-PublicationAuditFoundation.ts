import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicationAuditFoundation1760000004000
  implements MigrationInterface
{
  name = 'PublicationAuditFoundation1760000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."publication_batch_runs_action_enum" AS ENUM('publish', 'offline')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."publication_batch_runs_status_enum" AS ENUM('pending', 'success', 'partial', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "publication_batch_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action" "public"."publication_batch_runs_action_enum" NOT NULL, "status" "public"."publication_batch_runs_status_enum" NOT NULL DEFAULT 'pending', "runtimeAssetId" character varying(36), "runtimeAssetType" character varying(32), "totalCount" integer NOT NULL DEFAULT '0', "successCount" integer NOT NULL DEFAULT '0', "failedCount" integer NOT NULL DEFAULT '0', "operatorId" character varying(36), "triggerSource" character varying(32) NOT NULL DEFAULT 'publication-ui', "requestPayload" jsonb, "resultSummary" jsonb, "startedAt" TIMESTAMP NOT NULL, "finishedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_64d070bf4a53c2b33f90b41a61b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2d8e38c97778d9092874c0f562" ON "publication_batch_runs" ("runtimeAssetId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ea8da8031d937f838742371de5" ON "publication_batch_runs" ("operatorId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4c26d435bfe9fb0611ef27e308" ON "publication_batch_runs" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d4f53e9dcb55ca219f0efe573f" ON "publication_batch_runs" ("createdAt") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."publication_audit_events_action_enum" AS ENUM('runtime_asset.created', 'memberships.added', 'profile.updated', 'gateway_route.updated', 'membership.published', 'membership.offlined', 'batch.publish', 'batch.offline')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."publication_audit_events_status_enum" AS ENUM('success', 'partial', 'failed', 'info')`,
    );
    await queryRunner.query(
      `CREATE TABLE "publication_audit_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action" "public"."publication_audit_events_action_enum" NOT NULL, "status" "public"."publication_audit_events_status_enum" NOT NULL DEFAULT 'info', "summary" character varying(255) NOT NULL, "details" jsonb, "publicationBatchRunId" character varying(36), "runtimeAssetId" character varying(36), "runtimeAssetEndpointBindingId" character varying(36), "endpointDefinitionId" character varying(36), "sourceServiceAssetId" character varying(36), "operatorId" character varying(36), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f0eaee8c3874f137c0d311521d8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0da88349d0b1884cd1e4d6d4da" ON "publication_audit_events" ("publicationBatchRunId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f3a82c40187bfca063cfe5ae73" ON "publication_audit_events" ("runtimeAssetId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_97c6441c8934ec4e84ef5cc2a8" ON "publication_audit_events" ("runtimeAssetEndpointBindingId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8570c4f54b4cbb63890dfb1ad4" ON "publication_audit_events" ("endpointDefinitionId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b3861e8907f9db367d7257661d" ON "publication_audit_events" ("operatorId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_53e47714af5d63e172f36ec46f" ON "publication_audit_events" ("createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_53e47714af5d63e172f36ec46f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_b3861e8907f9db367d7257661d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8570c4f54b4cbb63890dfb1ad4"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_97c6441c8934ec4e84ef5cc2a8"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f3a82c40187bfca063cfe5ae73"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0da88349d0b1884cd1e4d6d4da"`);
    await queryRunner.query(`DROP TABLE "publication_audit_events"`);
    await queryRunner.query(`DROP TYPE "public"."publication_audit_events_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."publication_audit_events_action_enum"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_d4f53e9dcb55ca219f0efe573f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_4c26d435bfe9fb0611ef27e308"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ea8da8031d937f838742371de5"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2d8e38c97778d9092874c0f562"`);
    await queryRunner.query(`DROP TABLE "publication_batch_runs"`);
    await queryRunner.query(`DROP TYPE "public"."publication_batch_runs_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."publication_batch_runs_action_enum"`);
  }
}
