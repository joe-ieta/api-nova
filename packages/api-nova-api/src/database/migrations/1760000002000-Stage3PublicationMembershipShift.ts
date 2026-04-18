import { MigrationInterface, QueryRunner } from 'typeorm';

export class Stage3PublicationMembershipShift1760000002000 implements MigrationInterface {
  name = 'Stage3PublicationMembershipShift1760000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_7796f331f7a3f73b4d4896e2e8"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_7796f331f7a3f73b4d4896e2e8" ON "publication_profiles" ("endpointId", "version") `,
    );
    await queryRunner.query(
      `ALTER TABLE "publication_profiles" ADD "runtimeAssetEndpointBindingId" character varying(36)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9f8e1229dddbf4b4d5662773d4" ON "publication_profiles" ("runtimeAssetEndpointBindingId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_d0a43c928f48d84f0577ccdc43" ON "publication_profiles" ("runtimeAssetEndpointBindingId", "version") `,
    );

    await queryRunner.query(
      `ALTER TABLE "publication_profile_history" ADD "runtimeAssetEndpointBindingId" character varying(36)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_071de4f15510453559b8287598" ON "publication_profile_history" ("runtimeAssetEndpointBindingId") `,
    );

    await queryRunner.query(`DROP INDEX "public"."IDX_3758b0d70392fbfaeabf1853ef"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_3758b0d70392fbfaeabf1853ef" ON "endpoint_publish_bindings" ("endpointId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "endpoint_publish_bindings" ADD "runtimeAssetEndpointBindingId" character varying(36)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_7fcf2fdb9b1b59d8c44ea91469" ON "endpoint_publish_bindings" ("runtimeAssetEndpointBindingId") `,
    );

    await queryRunner.query(
      `ALTER TABLE "gateway_route_bindings" ADD "runtimeAssetEndpointBindingId" character varying(36)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e9604c82743a7f978fb5a724d5" ON "gateway_route_bindings" ("runtimeAssetEndpointBindingId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_e9604c82743a7f978fb5a724d5"`);
    await queryRunner.query(`ALTER TABLE "gateway_route_bindings" DROP COLUMN "runtimeAssetEndpointBindingId"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_7fcf2fdb9b1b59d8c44ea91469"`);
    await queryRunner.query(`ALTER TABLE "endpoint_publish_bindings" DROP COLUMN "runtimeAssetEndpointBindingId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3758b0d70392fbfaeabf1853ef"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3758b0d70392fbfaeabf1853ef" ON "endpoint_publish_bindings" ("endpointId") `,
    );

    await queryRunner.query(`DROP INDEX "public"."IDX_071de4f15510453559b8287598"`);
    await queryRunner.query(`ALTER TABLE "publication_profile_history" DROP COLUMN "runtimeAssetEndpointBindingId"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_d0a43c928f48d84f0577ccdc43"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_9f8e1229dddbf4b4d5662773d4"`);
    await queryRunner.query(`ALTER TABLE "publication_profiles" DROP COLUMN "runtimeAssetEndpointBindingId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7796f331f7a3f73b4d4896e2e8"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_7796f331f7a3f73b4d4896e2e8" ON "publication_profiles" ("endpointId", "version") `,
    );
  }
}
