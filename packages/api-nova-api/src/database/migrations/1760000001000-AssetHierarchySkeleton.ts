import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetHierarchySkeleton1760000001000 implements MigrationInterface {
  name = 'AssetHierarchySkeleton1760000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."endpoint_definitions_status_enum" AS ENUM('draft', 'verified', 'published', 'degraded', 'offline', 'retired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."runtime_assets_type_enum" AS ENUM('mcp_server', 'gateway_service')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."runtime_assets_status_enum" AS ENUM('draft', 'active', 'degraded', 'offline')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."runtime_asset_endpoint_bindings_status_enum" AS ENUM('draft', 'active', 'offline')`,
    );

    await queryRunner.query(
      `CREATE TABLE "source_service_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sourceKey" character varying(255) NOT NULL, "scheme" character varying(16) NOT NULL, "host" character varying(255) NOT NULL, "port" integer NOT NULL, "normalizedBasePath" character varying(255) NOT NULL DEFAULT '/', "displayName" character varying(255), "description" text, "owner" character varying(255), "tags" jsonb, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b730b4dd867577f2f776f86a44e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_0dbf938c6120f491f3cbb16c3d" ON "source_service_assets" ("scheme", "host", "port", "normalizedBasePath") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_14c75d38dcda96d6a0d2ba6e75" ON "source_service_assets" ("sourceKey") `,
    );

    await queryRunner.query(
      `CREATE TABLE "endpoint_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sourceServiceAssetId" character varying(36) NOT NULL, "method" character varying(16) NOT NULL, "path" character varying(1024) NOT NULL, "operationId" character varying(255), "summary" character varying(255), "description" text, "status" "public"."endpoint_definitions_status_enum" NOT NULL DEFAULT 'draft', "publishEnabled" boolean NOT NULL DEFAULT false, "rawOperation" jsonb, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_99c4ce1c2089ff3afef0c7ad7e8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f159791f13f1a5d1b98a6d4412" ON "endpoint_definitions" ("status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_8790f4c3e839184ef4636704d8" ON "endpoint_definitions" ("sourceServiceAssetId", "method", "path") `,
    );

    await queryRunner.query(
      `CREATE TABLE "runtime_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "type" "public"."runtime_assets_type_enum" NOT NULL, "status" "public"."runtime_assets_status_enum" NOT NULL DEFAULT 'draft', "displayName" character varying(255), "description" text, "policyBindingRef" character varying(100), "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_a338d5ed2859093b5f3fc81689e" UNIQUE ("name"), CONSTRAINT "PK_41b050ac476bf73ddf34d1524a9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_52e88ad28c6336251c79dcb70c" ON "runtime_assets" ("type", "status") `,
    );

    await queryRunner.query(
      `CREATE TABLE "runtime_asset_endpoint_bindings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "runtimeAssetId" character varying(36) NOT NULL, "endpointDefinitionId" character varying(36) NOT NULL, "status" "public"."runtime_asset_endpoint_bindings_status_enum" NOT NULL DEFAULT 'draft', "publicationRevision" integer NOT NULL DEFAULT '0', "enabled" boolean NOT NULL DEFAULT true, "bindingConfig" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8477777f16f5484c3f9660c2d7f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_06a53d10d59c5c42f5c431ff95" ON "runtime_asset_endpoint_bindings" ("status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_0d9e87fbd16dd9b48cbb2429f7" ON "runtime_asset_endpoint_bindings" ("runtimeAssetId", "endpointDefinitionId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_0d9e87fbd16dd9b48cbb2429f7"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_06a53d10d59c5c42f5c431ff95"`);
    await queryRunner.query(`DROP TABLE "runtime_asset_endpoint_bindings"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_52e88ad28c6336251c79dcb70c"`);
    await queryRunner.query(`DROP TABLE "runtime_assets"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_8790f4c3e839184ef4636704d8"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f159791f13f1a5d1b98a6d4412"`);
    await queryRunner.query(`DROP TABLE "endpoint_definitions"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_14c75d38dcda96d6a0d2ba6e75"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0dbf938c6120f491f3cbb16c3d"`);
    await queryRunner.query(`DROP TABLE "source_service_assets"`);

    await queryRunner.query(`DROP TYPE "public"."runtime_asset_endpoint_bindings_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."runtime_assets_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."runtime_assets_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."endpoint_definitions_status_enum"`);
  }
}
