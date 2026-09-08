import '../config/environment';
import { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { DATABASE_ENTITIES } from './database.entities';
import { getDatabaseType, verifySqliteDatabasePath } from './database-dialect';

export function buildDatabaseOptions(): DataSourceOptions {
  const type = getDatabaseType(process.env.DB_TYPE);
  const extension = __filename.endsWith('.ts') ? 'ts' : 'js';
  const migration = type === 'sqlite' ? '*-InitialSqliteSchema' : '*-InitialPostgresSchema';
  const common = {
    entities: DATABASE_ENTITIES,
    migrations: [join(__dirname, 'migrations', `${migration}.${extension}`)],
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
  };
  if (type === 'sqlite') {
    return { ...common, type: 'sqljs', location: verifySqliteDatabasePath(), autoSave: true };
  }
  const ssl = process.env.DB_SSL === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.DB_SSL === 'true';
  return {
    ...common,
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || 'api_nova_api',
    ssl: ssl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  };
}
