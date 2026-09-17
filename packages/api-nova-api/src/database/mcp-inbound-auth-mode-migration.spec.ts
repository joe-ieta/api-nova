import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

jest.mock('../config/environment', () => ({}));

import { buildDatabaseOptions } from './database-options';
import {
  configuredMcpInboundAuthMode,
  MCPServerEntity,
  McpInboundAuthMode,
} from './entities/mcp-server.entity';
import { ServerMapper } from '../modules/servers/utils/server-mapper.util';
import { McpInboundAuthModePostgres1790000003000 } from './migrations/1790000003000-McpInboundAuthModePostgres';

describe('MCP inbound mode SQLite forward migration', () => {
  it('declares a nullable PostgreSQL column with the same three allowed modes', async () => {
    const queries: string[] = [];
    await new McpInboundAuthModePostgres1790000003000().up({
      query: async (sql: string) => { queries.push(sql); },
    } as any);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('ADD COLUMN "inboundAuthMode" varchar(32)');
    expect(queries.join(' ')).toContain('private_jwt');
    expect(queries.join(' ')).toContain('private_api_key');
    expect(queries.join(' ')).toContain('anonymous');
    expect(queries.join(' ')).not.toContain('DEFAULT');
    expect(getMetadataArgsStorage().checks.find(check =>
      check.target === MCPServerEntity && check.name === 'CHK_mcp_servers_inbound_auth_mode',
    )?.expression).toContain('private_api_key');
  });


  it('keeps legacy auth unknown and persists each explicit mode across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'api-nova-mcp-inbound-mode-'));
    const savedType = process.env.DB_TYPE;
    const savedPath = process.env.DB_SQLITE_PATH;
    let source: DataSource | undefined;
    try {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_SQLITE_PATH = join(directory, 'mcp.sqlite');
      const options = buildDatabaseOptions();
      const migrations = options.migrations as string[];

      source = new DataSource({ ...options, migrations: migrations.slice(0, 2) } as any);
      await source.initialize();
      expect(await source.runMigrations()).toHaveLength(2);
      await source.query(
        'INSERT INTO "mcp_servers" ("id", "name", "openApiData", "authConfig") VALUES (?, ?, ?, ?)',
        ['legacy-server', 'legacy', '{}', JSON.stringify({ type: 'bearer', config: {} })],
      );
      await source.destroy();

      source = new DataSource(options);
      await source.initialize();
      expect(await source.runMigrations()).toHaveLength(1);
      const repository = source.getRepository(MCPServerEntity);
      const legacy = await repository.findOneByOrFail({ id: 'legacy-server' });
      expect(legacy.inboundAuthMode).toBeNull();
      expect(legacy.authConfig?.type).toBe('bearer');
      expect(configuredMcpInboundAuthMode(legacy.inboundAuthMode)).toBeNull();
      expect(ServerMapper.toResponseDto(legacy)).toMatchObject({
        inboundAuthMode: 'unknown', effectiveInboundAuthMode: 'unknown',
      });

      for (const mode of Object.values(McpInboundAuthMode)) {
        const saved = await repository.save(repository.create({
          name: 'mode-' + mode, openApiData: {}, inboundAuthMode: mode,
        }));
        expect((await repository.findOneByOrFail({ id: saved.id })).inboundAuthMode).toBe(mode);
        expect(ServerMapper.toResponseDto(saved)).toMatchObject({
          inboundAuthMode: mode, effectiveInboundAuthMode: 'unknown',
        });
      }
      await expect(source.query(
        'UPDATE "mcp_servers" SET "inboundAuthMode" = ? WHERE "id" = ?',
        ['oauth2', 'legacy-server'],
      )).rejects.toThrow();
      expect(await source.showMigrations()).toBe(false);
      expect((await source.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
      await source.destroy();

      source = new DataSource(options);
      await source.initialize();
      expect(await source.runMigrations()).toHaveLength(0);
      expect((await source.getRepository(MCPServerEntity).findOneByOrFail({
        id: 'legacy-server',
      })).inboundAuthMode).toBeNull();
    } finally {
      if (source?.isInitialized) await source.destroy();
      if (savedType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = savedType;
      if (savedPath === undefined) delete process.env.DB_SQLITE_PATH;
      else process.env.DB_SQLITE_PATH = savedPath;
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('api-nova-mcp-inbound-mode-')) {
        throw new Error('Unsafe SQLite test directory');
      }
      rmSync(target, { recursive: true, force: true });
    }
  });
});
