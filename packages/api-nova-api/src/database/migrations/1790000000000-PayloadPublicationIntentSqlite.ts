import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward-only schema addition. Existing reservations receive no intent row. */
export class PayloadPublicationIntentSqlite1790000000000 implements MigrationInterface {
  name = 'PayloadPublicationIntentSqlite1790000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE "runtime_payload_publication_intents" ("reservationId" varchar(64) NOT NULL, "ownerId" varchar(120) NOT NULL, "epoch" varchar(36) NOT NULL, "generation" varchar(20) NOT NULL, "sourceInstanceId" varchar(500) NOT NULL, "sourceEventId" varchar(500) NOT NULL, "payloadId" varchar(64) NOT NULL, "fileKey" varchar(72) NOT NULL, "temporaryKey" varchar(113) NOT NULL, "digest" varchar(64) NOT NULL, "storedBytes" varchar(20) NOT NULL, "intentHash" varchar(64) NOT NULL, "createdAt" varchar(24) NOT NULL, CONSTRAINT "PK_obs_payload_publication_intents" PRIMARY KEY ("reservationId"), CONSTRAINT "FK_obs_publication_intent_reservation" FOREIGN KEY ("reservationId") REFERENCES "runtime_payload_quota_reservations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)');
    await queryRunner.query('CREATE INDEX "IDX_obs_publication_intent_scope" ON "runtime_payload_publication_intents" ("ownerId", "epoch", "generation")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_obs_publication_intent_scope"');
    await queryRunner.query('DROP TABLE "runtime_payload_publication_intents"');
  }
}