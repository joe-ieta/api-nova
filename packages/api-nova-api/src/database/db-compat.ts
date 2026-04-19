import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'fs';
import { dirname, isAbsolute, join, parse, resolve } from 'path';
import { ConfigService } from '@nestjs/config';
import { ColumnOptions } from 'typeorm';

export type SupportedDatabaseType = 'sqlite' | 'postgres';

export function getDatabaseType(value?: string): SupportedDatabaseType {
  return value === 'postgres' ? 'postgres' : 'sqlite';
}

export function isSqliteDatabase(type?: string): boolean {
  return getDatabaseType(type) === 'sqlite';
}

export function getJsonColumnOptions(
  type?: string,
  options: ColumnOptions = {},
): ColumnOptions {
  return {
    type: isSqliteDatabase(type) ? 'simple-json' : 'jsonb',
    ...options,
  };
}

export function getEnumColumnOptions<T extends Record<string, string>>(
  dbType: string | undefined,
  enumObject: T,
  options: ColumnOptions = {},
): ColumnOptions {
  const normalizedOptions = isSqliteDatabase(dbType)
    ? options
    : Object.fromEntries(
        Object.entries(options).filter(([key]) => key !== 'length'),
      );

  return {
    type: isSqliteDatabase(dbType) ? 'simple-enum' : 'enum',
    enum: enumObject,
    ...normalizedOptions,
  };
}

export function getIpColumnOptions(
  type?: string,
  options: ColumnOptions = {},
): ColumnOptions {
  return {
    type: isSqliteDatabase(type) ? 'varchar' : 'inet',
    ...(isSqliteDatabase(type) ? { length: 45 } : {}),
    ...options,
  };
}

export function getUuidColumnOptions(
  type?: string,
  options: ColumnOptions = {},
): ColumnOptions {
  return {
    type: isSqliteDatabase(type) ? 'varchar' : 'uuid',
    ...(isSqliteDatabase(type) ? { length: 36 } : {}),
    ...options,
  };
}

export function getTimestampTzColumnOptions(
  type?: string,
  options: ColumnOptions = {},
): ColumnOptions {
  return {
    type: isSqliteDatabase(type) ? 'datetime' : 'timestamp with time zone',
    ...options,
  };
}

export function getTimestampColumnOptions(
  type?: string,
  options: ColumnOptions = {},
): ColumnOptions {
  return {
    type: isSqliteDatabase(type) ? 'datetime' : 'timestamp',
    ...options,
  };
}

export function resolveSqliteDatabasePath(configService?: ConfigService): string {
  const configuredPath =
    configService?.get<string>('DB_SQLITE_PATH') ??
    process.env.DB_SQLITE_PATH ??
    'data/api-nova.db';

  const workspaceRoot = findWorkspaceRoot();
  const absolutePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workspaceRoot, configuredPath);

  mkdirSync(dirname(absolutePath), { recursive: true });
  return absolutePath;
}

function findWorkspaceRoot(): string {
  const candidates = [process.cwd(), __dirname].map((value) => resolve(value));

  for (const candidate of candidates) {
    const root = findWorkspaceRootFrom(candidate);
    if (root) {
      return root;
    }
  }

  return resolve(process.cwd());
}

function findWorkspaceRootFrom(startPath: string): string | null {
  let current = startPath;
  let packageJsonCandidate: string | null = null;

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, '.git'))) {
      return current;
    }
    if (existsSync(join(current, 'package.json'))) {
      packageJsonCandidate = current;
    }

    const parent = dirname(current);
    if (parent === current || parent === parse(current).root) {
      return packageJsonCandidate;
    }
    current = parent;
  }
}

export function verifySqliteDatabasePath(configService?: ConfigService): string {
  const absolutePath = resolveSqliteDatabasePath(configService);
  const directoryPath = dirname(absolutePath);

  accessSync(directoryPath, constants.R_OK | constants.W_OK);

  const handle = openSync(absolutePath, 'a');
  closeSync(handle);

  return absolutePath;
}
