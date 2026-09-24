import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DataSource } from 'typeorm';

jest.mock('../config/environment', () => ({}));

import { buildDatabaseOptions } from './database-options';
import { GatewayConsumerCredentialEntity } from './entities/gateway-consumer-credential.entity';
import { RuntimeAccessCredentialPostgres1790000005000 } from './migrations/1790000005000-RuntimeAccessCredentialPostgres';

describe('runtime access credential forward migration', () => {
  it('PostgreSQL adds nullable JSON without granting defaults and declares a reversible column', async () => {
    const queries: string[] = [];
    const runner = { query: async (sql: string) => { queries.push(sql); } } as any;
    const migration = new RuntimeAccessCredentialPostgres1790000005000();
    await migration.up(runner);
    expect(queries).toEqual(['ALTER TABLE "gateway_consumer_credentials" ADD COLUMN "accessPolicy" jsonb']);
    await migration.down(runner);
    expect(queries[1]).toBe('ALTER TABLE "gateway_consumer_credentials" DROP COLUMN "accessPolicy"');
  });

  it('upgrades legacy SQLite rows without grants, persists explicit policy, and supports down/up without schema drift', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'api-nova-runtime-credential-'));
    const savedType = process.env.DB_TYPE;
    const savedPath = process.env.DB_SQLITE_PATH;
    let source: DataSource | undefined;
    try {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_SQLITE_PATH = join(directory, 'credentials.sqlite');
      const options = buildDatabaseOptions();
      source = await new DataSource({ ...options, migrations: (options.migrations as string[]).slice(0, 3) } as any).initialize();
      expect(await source.runMigrations()).toHaveLength(3);
      await source.query(
        'INSERT INTO "gateway_consumer_credentials" ("id", "name", "keyId", "secretHash", "runtimeAssetId", "routeBindingId", "metadata") VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['legacy', 'legacy', 'legacy-key', 'existing-hash', 'gateway', 'route', JSON.stringify({ label: 'preserved' })],
      );
      await source.destroy();

      source = await new DataSource(options).initialize();
      expect(await source.runMigrations()).toHaveLength((options.migrations as string[]).length - 3);
      const repository = source.getRepository(GatewayConsumerCredentialEntity);
      const legacy = await repository.findOneByOrFail({ id: 'legacy' });
      expect(legacy).toMatchObject({ accessPolicy: null, secretHash: 'existing-hash', status: 'active',
        runtimeAssetId: 'gateway', routeBindingId: 'route', metadata: { label: 'preserved' } });
      const policy = { version: 1, transports: ['gateway', 'mcp'], runtimeAssetIds: ['runtime'] };
      await repository.save({ id: 'explicit', name: 'explicit', keyId: 'explicit-key', secretHash: 'synthetic-hash', accessPolicy: policy });
      expect((await source.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
      await source.destroy();

      source = await new DataSource(options).initialize();
      expect(await source.runMigrations()).toHaveLength(0);
      expect((await source.getRepository(GatewayConsumerCredentialEntity).findOneByOrFail({ id: 'explicit' })).accessPolicy).toEqual(policy);
      expect((await source.getRepository(GatewayConsumerCredentialEntity).findOneByOrFail({ id: 'legacy' })).accessPolicy).toBeNull();
      for (let n = 3; n < (options.migrations as string[]).length; n++) await source.undoLastMigration();
      expect((await source.query('PRAGMA table_info("gateway_consumer_credentials")')).map((column: any) => column.name)).not.toContain('accessPolicy');
      const preserved = await source.query('SELECT "keyId", "secretHash", "runtimeAssetId", "routeBindingId" FROM "gateway_consumer_credentials" WHERE "id" = ?', ['legacy']);
      expect(preserved).toEqual([{ keyId: 'legacy-key', secretHash: 'existing-hash', runtimeAssetId: 'gateway', routeBindingId: 'route' }]);
      expect(await source.runMigrations()).toHaveLength((options.migrations as string[]).length - 3);
      // Rollback removes policies; re-upgrade must not recreate access grants implicitly.
      expect((await source.getRepository(GatewayConsumerCredentialEntity).findOneByOrFail({ id: 'explicit' })).accessPolicy).toBeNull();
      expect((await source.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
      expect(await source.showMigrations()).toBe(false);
    } finally {
      if (source?.isInitialized) await source.destroy();
      if (savedType === undefined) delete process.env.DB_TYPE; else process.env.DB_TYPE = savedType;
      if (savedPath === undefined) delete process.env.DB_SQLITE_PATH; else process.env.DB_SQLITE_PATH = savedPath;
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('api-nova-runtime-credential-')) throw new Error('Unsafe SQLite test directory');
      rmSync(target, { recursive: true, force: true });
    }
  });
});
