import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppConfigService } from './app-config.service';
import { ConfigOverrideEntity } from '../database/entities/config-override.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ConfigBackupEntity } from '../database/entities/config-backup.entity';

describe('AppConfigService', () => {
  let service: AppConfigService;
  const configValues = new Map<string, unknown>();
  const overrideRepository = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (entity) => entity),
    create: jest.fn((entity) => entity),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const auditRepository = {
    save: jest.fn(async (entity) => entity),
    create: jest.fn((entity) => entity),
  };
  const backupRepository = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (entity) => ({
      id: 'backup-1',
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
      updatedAt: new Date('2026-04-23T00:00:00.000Z'),
      ...entity,
    })),
    create: jest.fn((entity) => entity),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    configValues.clear();
    overrideRepository.find.mockResolvedValue([]);
    overrideRepository.save.mockClear();
    overrideRepository.create.mockClear();
    overrideRepository.delete.mockClear();
    auditRepository.save.mockClear();
    auditRepository.create.mockClear();
    backupRepository.find.mockResolvedValue([]);
    backupRepository.findOne.mockResolvedValue(null);
    backupRepository.save.mockClear();
    backupRepository.create.mockClear();
    backupRepository.delete.mockClear();

    (overrideRepository as any).manager = {
      transaction: jest.fn(async (callback) => callback({
        getRepository: (entity: unknown) => entity === ConfigOverrideEntity ? overrideRepository : auditRepository,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, defaultValue?: T) =>
              (configValues.has(key) ? configValues.get(key) : defaultValue) as T,
          },
        },
        {
          provide: getRepositoryToken(ConfigOverrideEntity),
          useValue: overrideRepository,
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: auditRepository,
        },
        {
          provide: getRepositoryToken(ConfigBackupEntity),
          useValue: backupRepository,
        },
      ],
    }).compile();

    service = module.get<AppConfigService>(AppConfigService);
    await service.onModuleInit();
  });

  it('should expose governed defaults', () => {
    expect(service.port).toBe(9001);
    expect(service.mcpPort).toBe(9022);
    expect(service.processTimeout).toBe(30000);
    expect(service.healthCheckInterval).toBe(30000);
  });

  it('should mark editable metadata and override sources', async () => {
    configValues.set('LOG_LEVEL', 'info');
    overrideRepository.find.mockResolvedValue([
      {
        envKey: 'LOG_LEVEL',
        value: 'debug',
      },
    ]);

    await service.reloadOverrides();
    const config = service.getAllConfig();

    expect(config.logging.level).toBe('debug');
    expect(config.metadata.logging.level).toMatchObject({
      source: 'override',
      editable: true,
      restartRequired: false,
    });
    expect(config.metadata.app.port.editable).toBe(false);
  });

  it('should persist editable runtime overrides', async () => {
    const result = await service.updateConfig({
      logging: {
        level: 'warn',
      },
      monitoring: {
        healthCheckTimeout: 9000,
      },
    });

    expect(overrideRepository.save).toHaveBeenCalledTimes(2);
    expect(auditRepository.save).toHaveBeenCalledTimes(1);
    expect(result.updatedKeys).toEqual(
      expect.arrayContaining(['logging.level', 'monitoring.healthCheckTimeout']),
    );
    expect(result.config.logging.level).toBe('warn');
    expect(result.config.monitoring.healthCheckTimeout).toBe(9000);
  });

  it('should export current overrides', async () => {
    overrideRepository.find.mockResolvedValue([
      {
        envKey: 'LOG_LEVEL',
        value: 'debug',
      },
    ]);

    await service.reloadOverrides();
    const exported = service.exportConfig();

    expect(exported.formatVersion).toBe('config-overrides/v1');
    expect(exported.overrideCount).toBe(1);
    expect(exported.overrides[0]).toMatchObject({
      envKey: 'LOG_LEVEL',
      section: 'logging',
      field: 'level',
      value: 'debug',
    });
  });

  it('should create and restore backups', async () => {
    const created = await service.createBackup({
      name: 'Nightly',
    });

    expect(created.name).toBe('Nightly');
    expect(backupRepository.save).toHaveBeenCalledTimes(1);

    backupRepository.findOne.mockResolvedValue({
      id: 'backup-1',
      name: 'Nightly',
      snapshot: {
        formatVersion: 'config-overrides/v1',
        overrides: [
          {
            envKey: 'LOG_LEVEL',
            section: 'logging',
            field: 'level',
            valueType: 'string',
            value: 'warn',
            restartRequired: false,
          },
        ],
      },
    });

    const restored = await service.restoreBackup('backup-1');
    expect(restored.importedCount).toBe(1);
    expect(restored.config.logging.level).toBe('warn');
  });

  it('should preview import conflicts and restart plan', async () => {
    overrideRepository.find.mockResolvedValue([
      {
        envKey: 'DEFAULT_OPENAPI_BASE_URL',
        value: 'https://old.example.com',
      },
    ]);

    await service.reloadOverrides();

    const preview = service.previewImportConfig({
      formatVersion: 'config-overrides/v1',
      overrides: [
        {
          envKey: 'DEFAULT_OPENAPI_BASE_URL',
          section: 'openapi',
          field: 'defaultBaseUrl',
          valueType: 'string',
          value: 'https://new.example.com',
          restartRequired: false,
        },
      ],
    });

    expect(preview.formatVersion).toBe('config-overrides/v1');
    expect(preview.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'openapi.defaultBaseUrl',
          kind: 'change',
        }),
      ]),
    );
  });
  it('rejects historical formats without touching persistent overrides', async () => {
    await expect(service.importConfig({ formatVersion: '1.0.0', overrides: [] }))
      .rejects.toThrow('Only config-overrides/v1');
    expect(overrideRepository.delete).not.toHaveBeenCalled();
  });

  it('rejects malformed and duplicate records before any delete', async () => {
    const record = { envKey: 'LOG_LEVEL', section: 'logging', field: 'level',
      valueType: 'string' as const, value: 'warn', restartRequired: false };
    await expect(service.importConfig({ formatVersion: 'config-overrides/v1',
      overrides: [record, record] })).rejects.toThrow('Duplicate');
    await expect(service.importConfig({ formatVersion: 'config-overrides/v1',
      overrides: [{ ...record, value: 1 }] })).rejects.toThrow('Invalid');
    expect(overrideRepository.delete).not.toHaveBeenCalled();
  });

  it('keeps the effective cache unchanged when a transaction fails', async () => {
    overrideRepository.find.mockResolvedValue([{ envKey: 'LOG_LEVEL', value: 'debug' }]);
    await service.reloadOverrides();
    overrideRepository.save.mockRejectedValueOnce(new Error('write failed'));
    await expect(service.importConfig({ formatVersion: 'config-overrides/v1', overrides: [{
      envKey: 'LOG_LEVEL', section: 'logging', field: 'level', valueType: 'string',
      value: 'warn', restartRequired: false,
    }] })).rejects.toThrow('write failed');
    expect(service.getAllConfig().logging.level).toBe('debug');
  });
});
