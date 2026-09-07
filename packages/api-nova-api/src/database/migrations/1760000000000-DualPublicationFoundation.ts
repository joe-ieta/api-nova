import { MigrationInterface, QueryRunner } from 'typeorm';

export class DualPublicationFoundation1760000000000 implements MigrationInterface {
  name = 'DualPublicationFoundation1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."publication_profiles_status_enum" AS ENUM('draft', 'reviewed', 'published', 'offline')`,
    );
    await queryRunner.query(
      `CREATE TABLE "publication_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "endpointDefinitionId" character varying(36) NOT NULL, "version" integer NOT NULL DEFAULT '1', "intentName" character varying(255), "descriptionForLlm" text, "operatorNotes" text, "inputAliases" jsonb, "constraints" jsonb, "examples" jsonb, "visibility" character varying(32) NOT NULL DEFAULT 'internal', "status" "public"."publication_profiles_status_enum" NOT NULL DEFAULT 'draft', "draftSource" character varying(32), "createdBy" character varying(36), "updatedBy" character varying(36), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9fe456f7f44633ac89b7eaef420" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_31876d51ef77b629d1a4f8ca79" ON "publication_profiles" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3228aa03bcb06a0b8d55a17893" ON "publication_profiles" ("endpointDefinitionId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_7796f331f7a3f73b4d4896e2e8" ON "publication_profiles" ("endpointDefinitionId", "version") `,
    );

    await queryRunner.query(
      `CREATE TABLE "publication_profile_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "endpointDefinitionId" character varying(36) NOT NULL, "publicationProfileId" character varying(36) NOT NULL, "version" integer NOT NULL, "snapshot" jsonb NOT NULL, "action" character varying(64) NOT NULL, "actorId" character varying(36), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2c5ab38dc62055212651e213cc4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_23df5b5d3a59b74df696be0cbf" ON "publication_profile_history" ("endpointDefinitionId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_757c1d0be3342f419f2e6ee258" ON "publication_profile_history" ("publicationProfileId") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."endpoint_publish_bindings_reviewstatus_enum" AS ENUM('pending', 'reviewed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."endpoint_publish_bindings_publishstatus_enum" AS ENUM('draft', 'active', 'offline')`,
    );
    await queryRunner.query(
      `CREATE TABLE "endpoint_publish_bindings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "endpointDefinitionId" character varying(36) NOT NULL, "publicationProfileId" character varying(36), "publicationRevision" integer NOT NULL DEFAULT '0', "reviewStatus" "public"."endpoint_publish_bindings_reviewstatus_enum" NOT NULL DEFAULT 'pending', "publishStatus" "public"."endpoint_publish_bindings_publishstatus_enum" NOT NULL DEFAULT 'draft', "publishedToMcp" boolean NOT NULL DEFAULT false, "publishedToHttp" boolean NOT NULL DEFAULT false, "publishedAt" TIMESTAMP, "publishedBy" character varying(36), "offlineAt" TIMESTAMP, "offlineBy" character varying(36), "lastSnapshotId" character varying(36), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a6b86e0eb1e8fcc71581f15ecab" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1bfc83358a7f2598370d95a4a3" ON "endpoint_publish_bindings" ("publishStatus") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3758b0d70392fbfaeabf1853ef" ON "endpoint_publish_bindings" ("endpointDefinitionId") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."gateway_route_bindings_status_enum" AS ENUM('draft', 'active', 'offline')`,
    );
    await queryRunner.query(
      `CREATE TABLE "gateway_route_bindings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "endpointDefinitionId" character varying(36) NOT NULL, "publishBindingId" character varying(36), "routePath" character varying(255) NOT NULL, "upstreamPath" character varying(255) NOT NULL, "routeMethod" character varying(16) NOT NULL, "upstreamMethod" character varying(16) NOT NULL, "routeVisibility" character varying(32) NOT NULL DEFAULT 'internal', "authPolicyRef" character varying(100), "trafficPolicyRef" character varying(100), "timeoutMs" integer, "retryPolicy" jsonb, "status" "public"."gateway_route_bindings_status_enum" NOT NULL DEFAULT 'draft', "lastPublishedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_65fd7ad0f4b19cb4076dbf60c1a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_12e44b4c1efdf75480ed33dd1f" ON "gateway_route_bindings" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2f392dca8d08b632d707fdafff" ON "gateway_route_bindings" ("endpointDefinitionId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f89f1743f0f62ce88244b1e6d2" ON "gateway_route_bindings" ("routePath", "routeMethod") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_f89f1743f0f62ce88244b1e6d2"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2f392dca8d08b632d707fdafff"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_12e44b4c1efdf75480ed33dd1f"`);
    await queryRunner.query(`DROP TABLE "gateway_route_bindings"`);
    await queryRunner.query(`DROP TYPE "public"."gateway_route_bindings_status_enum"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_3758b0d70392fbfaeabf1853ef"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1bfc83358a7f2598370d95a4a3"`);
    await queryRunner.query(`DROP TABLE "endpoint_publish_bindings"`);
    await queryRunner.query(`DROP TYPE "public"."endpoint_publish_bindings_publishstatus_enum"`);
    await queryRunner.query(`DROP TYPE "public"."endpoint_publish_bindings_reviewstatus_enum"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_757c1d0be3342f419f2e6ee258"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_23df5b5d3a59b74df696be0cbf"`);
    await queryRunner.query(`DROP TABLE "publication_profile_history"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_7796f331f7a3f73b4d4896e2e8"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3228aa03bcb06a0b8d55a17893"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_31876d51ef77b629d1a4f8ca79"`);
    await queryRunner.query(`DROP TABLE "publication_profiles"`);
    await queryRunner.query(`DROP TYPE "public"."publication_profiles_status_enum"`);
  }
}
