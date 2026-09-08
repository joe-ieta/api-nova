import { dirname, join } from 'path';
import { existsSync, rmSync } from 'fs';
import {
  getDatabaseType,
  getEnumColumnOptions,
  resolveSqliteDatabasePath,
  verifySqliteDatabasePath,
} from './database-dialect';

describe('database-dialect', () => {
  const runtimeDir = join(process.cwd(), 'tmp', 'database-dialect-spec');

  afterEach(() => {
    delete process.env.DB_SQLITE_PATH;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('should reject unsupported database types', () => {
    expect(getDatabaseType(undefined)).toBe('sqlite');
    expect(() => getDatabaseType('mysql')).toThrow('Unsupported DB_TYPE');
    expect(() => getDatabaseType('')).toThrow('Unsupported DB_TYPE');
    expect(getDatabaseType('postgres')).toBe('postgres');
  });

  it('should resolve and create sqlite parent directory', () => {
    process.env.DB_SQLITE_PATH = 'tmp/database-dialect-spec/test.sqlite';

    const resolvedPath = resolveSqliteDatabasePath();

    expect(resolvedPath.endsWith('tmp\\database-dialect-spec\\test.sqlite') || resolvedPath.endsWith('tmp/database-dialect-spec/test.sqlite')).toBe(true);
    expect(existsSync(dirname(resolvedPath))).toBe(true);
    expect(resolvedPath.includes(`${join('packages', 'data')}${resolvedPath.includes('\\') ? '\\' : '/'}`)).toBe(false);
  });

  it('should verify sqlite path and create the database file when missing', () => {
    process.env.DB_SQLITE_PATH = 'tmp/database-dialect-spec/verified.sqlite';

    const verifiedPath = verifySqliteDatabasePath();

    expect(existsSync(verifiedPath)).toBe(true);
  });

  it('should strip enum length for postgres', () => {
    const options = getEnumColumnOptions(
      'postgres',
      { STOPPED: 'stopped', RUNNING: 'running' },
      { length: 20, default: 'stopped' },
    );

    expect(options.type).toBe('enum');
    expect(options.default).toBe('stopped');
    expect(options.length).toBeUndefined();
  });

  it('should strip enum length for sqlite to prevent schema drift', () => {
    const options = getEnumColumnOptions(
      'sqlite',
      { STOPPED: 'stopped', RUNNING: 'running' },
      { length: 20, default: 'stopped' },
    );

    expect(options.type).toBe('simple-enum');
    expect(options.default).toBe('stopped');
    expect(options.length).toBeUndefined();
  });
});
