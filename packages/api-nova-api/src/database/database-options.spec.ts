import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildDatabaseOptions } from './database-options';
import { DATABASE_ENTITIES } from './database.entities';
import { ProcessInfoEntity } from '../modules/servers/entities/process-info.entity';
import { ProcessLogEntity } from '../modules/servers/entities/process-log.entity';
import { HealthCheckResultEntity } from '../modules/servers/entities/health-check-result.entity';

describe('database options', () => {
  it('uses one complete entity registry and dialect-specific initial and forward migrations', () => {
    const saved = { ...process.env };
    const directory = mkdtempSync(join(tmpdir(), 'api-nova-schema-options-'));
    try {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_SQLITE_PATH = join(directory, 'empty.sqlite');
      const options = buildDatabaseOptions();
      expect(options.synchronize).toBe(false);
      expect(options.entities).toBe(DATABASE_ENTITIES);
      expect(DATABASE_ENTITIES).toEqual(expect.arrayContaining([
        ProcessInfoEntity, ProcessLogEntity, HealthCheckResultEntity,
      ]));
      expect(options.migrations).toHaveLength(2);
      expect(options.migrations[0]).toContain('InitialSqliteSchema');
      expect(options.migrations[1]).toContain('PayloadPublicationIntentSqlite');
      process.env.DB_TYPE = 'postgres';
      const postgres = buildDatabaseOptions();
      expect(postgres.migrations).toHaveLength(2);
      expect(postgres.migrations[0]).toContain('InitialPostgresSchema');
      expect(postgres.migrations[1]).toContain('PayloadPublicationIntentPostgres');
    } finally {
      process.env = saved;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
