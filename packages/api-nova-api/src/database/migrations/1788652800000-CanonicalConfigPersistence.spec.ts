import { DataSource } from 'typeorm';
import { CanonicalConfigPersistence1788652800000 } from './1788652800000-CanonicalConfigPersistence';
import { ConfigOverrideEntity } from '../entities/config-override.entity';
import { ConfigBackupEntity } from '../entities/config-backup.entity';

describe('Canonical configuration persistence', () => {
  it('supports config reads/writes on migrated SQLite without synchronization', async () => {
    const db = new DataSource({ type: 'sqljs', synchronize: false,
      entities: [ConfigOverrideEntity, ConfigBackupEntity], migrations: [CanonicalConfigPersistence1788652800000] });
    await db.initialize();
    try {
      await db.runMigrations();
      expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
      const overrides = db.getRepository(ConfigOverrideEntity);
      expect(await overrides.find()).toEqual([]);
      await overrides.save({ envKey: 'THROTTLE_LIMIT', section: 'security', field: 'throttleLimit', valueType: 'number', value: 100 });
      expect((await overrides.find())[0].value).toBe(100);
      await db.getRepository(ConfigBackupEntity).save({ name: 'fixture', overrideCount: 1, snapshot: { value: 100 } });
      expect((await db.getRepository(ConfigBackupEntity).find())[0].snapshot).toEqual({ value: 100 });
      await db.undoLastMigration();
      expect(await db.createQueryRunner().hasTable('config_overrides')).toBe(false);
    } finally { await db.destroy(); }
  });

  it('uses PostgreSQL JSONB and UUID definitions', async () => {
    const runner = { connection: { options: { type: 'postgres' } }, createTable: jest.fn() };
    await new CanonicalConfigPersistence1788652800000().up(runner as any);
    const tables = runner.createTable.mock.calls.map(call => call[0]);
    expect(tables[0].columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', type: 'uuid' }), expect.objectContaining({ name: 'value', type: 'jsonb' })]));
    expect(tables[1].columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'snapshot', type: 'jsonb' })]));
  });
});
