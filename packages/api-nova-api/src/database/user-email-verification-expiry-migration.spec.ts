import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DataSource } from 'typeorm';

jest.mock('../config/environment', () => ({}));

import { buildDatabaseOptions } from './database-options';
import { User } from './entities/user.entity';
import { UserEmailVerificationExpiryPostgres1790000013000 } from './migrations/1790000013000-UserEmailVerificationExpiryPostgres';

describe('user email verification expiry migration', () => {
  it('PostgreSQL adds a nullable TIMESTAMP column and is reversible', async () => {
    const queries: string[] = [];
    const runner = {
      query: async (sql: string) => {
        queries.push(sql);
      },
    } as any;
    const migration = new UserEmailVerificationExpiryPostgres1790000013000();

    await migration.up(runner);
    expect(queries).toEqual([
      'ALTER TABLE "users" ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP',
    ]);

    await migration.down(runner);
    expect(queries[1]).toBe(
      'ALTER TABLE "users" DROP COLUMN "emailVerificationExpiresAt"',
    );
  });

  it('SQLite upgrades legacy rows, persists expiry, and reverts without schema drift', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'api-nova-user-mail-expiry-'));
    const savedType = process.env.DB_TYPE;
    const savedPath = process.env.DB_SQLITE_PATH;
    let source: DataSource | undefined;
    try {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_SQLITE_PATH = join(directory, 'users.sqlite');
      const options = buildDatabaseOptions();
      const migrationCount = (options.migrations as string[]).length;

      source = await new DataSource(options).initialize();
      expect(await source.runMigrations()).toHaveLength(migrationCount);
      expect(await source.showMigrations()).toBe(false);

      await source.query(
        'INSERT INTO "users" ("id", "username", "email", "password") VALUES (?, ?, ?, ?)',
        ['legacy', 'legacy', 'legacy@example.test', 'existing-hash'],
      );

      const columns = (await source.query('PRAGMA table_info("users")')).map(
        (column: any) => column.name,
      );
      expect(columns).toContain('emailVerificationExpiresAt');
      expect((await source.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);

      const repository = source.getRepository(User);
      const legacy = await repository.findOneByOrFail({ id: 'legacy' });
      expect(legacy.emailVerificationExpiresAt).toBeNull();

      const expiresAt = new Date(Date.now() + 60_000);
      legacy.emailVerificationToken = 'a'.repeat(64);
      legacy.emailVerificationExpiresAt = expiresAt;
      await repository.save(legacy);
      await source.destroy();

      source = await new DataSource(options).initialize();
      expect(await source.runMigrations()).toHaveLength(0);
      const reopened = await source.getRepository(User).findOneByOrFail({ id: 'legacy' });
      expect(reopened.emailVerificationToken).toBe('a'.repeat(64));
      expect(reopened.emailVerificationExpiresAt).toEqual(expiresAt);

      // The mail migration is applied second-to-last; undo it after the last one.
      await source.undoLastMigration();
      await source.undoLastMigration();
      expect(
        (await source.query('PRAGMA table_info("users")')).map(
          (column: any) => column.name,
        ),
      ).not.toContain('emailVerificationExpiresAt');

      expect(await source.runMigrations()).toHaveLength(2);
      expect(
        (await source.getRepository(User).findOneByOrFail({ id: 'legacy' }))
          .emailVerificationExpiresAt,
      ).toBeNull();
      expect((await source.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
    } finally {
      if (source?.isInitialized) await source.destroy();
      if (savedType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = savedType;
      if (savedPath === undefined) delete process.env.DB_SQLITE_PATH;
      else process.env.DB_SQLITE_PATH = savedPath;
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('api-nova-user-mail-expiry-')
      ) {
        throw new Error('Unsafe SQLite test directory');
      }
      rmSync(target, { recursive: true, force: true });
    }
  });
});
