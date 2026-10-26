import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time email verification tokens now persist a SHA-256 digest plus a
 * 24-hour expiry. Legacy plaintext tokens stop matching on lookup.
 */
export class UserEmailVerificationExpirySqlite1790000012000 implements MigrationInterface {
  name = 'UserEmailVerificationExpirySqlite1790000012000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" ADD COLUMN "emailVerificationExpiresAt" datetime');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" DROP COLUMN "emailVerificationExpiresAt"');
  }
}
