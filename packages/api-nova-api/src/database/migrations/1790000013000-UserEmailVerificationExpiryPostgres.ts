import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time email verification tokens now persist a SHA-256 digest plus a
 * 24-hour expiry. Legacy plaintext tokens stop matching on lookup.
 */
export class UserEmailVerificationExpiryPostgres1790000013000 implements MigrationInterface {
  name = 'UserEmailVerificationExpiryPostgres1790000013000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "users" DROP COLUMN "emailVerificationExpiresAt"');
  }
}
