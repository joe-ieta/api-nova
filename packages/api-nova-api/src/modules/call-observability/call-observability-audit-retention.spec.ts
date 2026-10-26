import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  AuditAction,
  AuditLevel,
  AuditLog,
  AuditStatus,
} from '../../database/entities/audit-log.entity';
import {
  CALL_OBSERVABILITY_ENTITIES,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { Permission } from '../../database/entities/permission.entity';
import { Role } from '../../database/entities/role.entity';
import { User } from '../../database/entities/user.entity';
import {
  AUDIT_RETENTION_MIN_DAYS,
  CallObservabilityAuditRetentionService,
  OBSERVABILITY_AUDIT_RETENTION_STATE_ID,
} from './call-observability-audit-retention.service';
import {
  CallObservabilityAuditRetentionWorker,
  auditRetentionWorkerConfiguration,
} from './call-observability-audit-retention.worker';
import { CallObservabilityStore } from './call-observability.store';
import { DAY_MS } from './call-observability-storage';

describe('call observability management audit retention (OBS-14-06A)', () => {
  let db: DataSource;
  let store: CallObservabilityStore;
  let service: CallObservabilityAuditRetentionService;
  const NOW = new Date('2026-09-26T12:00:00.000Z');
  const at = (days: number, offsetMs = 0) => new Date(NOW.getTime() - days * DAY_MS + offsetMs);
  const repository = () => db.getRepository(AuditLog);
  const rows = () => repository().find();
  const state = async () =>
    (await db.getRepository(RuntimePipelineStateEntity).findOneBy({
      id: OBSERVABILITY_AUDIT_RETENTION_STATE_ID,
    }))?.value;

  const seed = async (resource: string | null, createdAt: Date) => {
    const row = repository().create({
      action: AuditAction.CONFIG_UPDATED,
      level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS,
      ...(resource === null ? {} : { resource }),
    });
    await repository().save(row);
    await repository().update({ id: row.id }, { createdAt });
    return row.id;
  };

  beforeEach(async () => {
    db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, AuditLog, User, Role, Permission],
    }).initialize();
    store = new CallObservabilityStore(db, {} as any);
    service = new CallObservabilityAuditRetentionService(store);
  });

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  test('defaults off and rejects retention windows below the 30-day minimum', async () => {
    const configuration = auditRetentionWorkerConfiguration(new ConfigService({}));
    expect(configuration).toMatchObject({
      enabled: false,
      retentionDays: AUDIT_RETENTION_MIN_DAYS,
      retentionMs: AUDIT_RETENTION_MIN_DAYS * DAY_MS,
    });
    expect(() => auditRetentionWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_AUDIT_RETENTION_RETENTION_DAYS: '29',
    }))).toThrow('INVALID_AUDIT_RETENTION_CONFIGURATION');
    await expect(service.collect({
      scanLimit: 10,
      deleteLimit: 5,
      retentionMs: 29 * DAY_MS,
      now: NOW,
    })).rejects.toThrow('AUDIT_RETENTION_BELOW_MINIMUM');
    await expect(service.collect({
      scanLimit: 1,
      deleteLimit: 2,
      retentionMs: 30 * DAY_MS,
      now: NOW,
    })).rejects.toThrow('INVALID_AUDIT_RETENTION_CONFIGURATION');
  });

  test('deletes only attributed records past the window and retains everything else', async () => {
    const expired = await seed('observability_policy', at(31));
    const unattributed = await seed(null, at(31));
    const otherProduct = await seed('config', at(31));
    const recent = await seed('observability_caller', at(29));

    const report = await service.collect({
      scanLimit: 100,
      deleteLimit: 50,
      retentionMs: 30 * DAY_MS,
      now: NOW,
    });

    expect(report).toMatchObject({ status: 'completed', scanned: 1, deleted: 1 });
    const remaining = await rows();
    const ids = remaining.map(row => row.id);
    expect(ids).not.toContain(expired);
    expect(ids).toEqual(expect.arrayContaining([unattributed, otherProduct, recent]));
    const management = remaining.filter(row => row.resource === 'observability_audit');
    expect(management).toHaveLength(1);
    expect(management[0].action).toBe(AuditAction.SYSTEM_MAINTENANCE);
    expect(management[0].details).toMatchObject({
      operation: 'observability_audit_retention',
      deleted: 1,
    });
  });

  test('treats the exact 30-day boundary as expired and keeps one millisecond newer records', async () => {
    const boundary = await seed('observability_policy', at(30));
    const newer = await seed('observability_policy', at(30, 1));

    const report = await service.collect({
      scanLimit: 100,
      deleteLimit: 50,
      retentionMs: 30 * DAY_MS,
      now: NOW,
    });

    expect(report.deleted).toBe(1);
    const ids = (await rows()).map(row => row.id);
    expect(ids).not.toContain(boundary);
    expect(ids).toContain(newer);
  });

  test('deletes in bounded batches and resumes from persisted progress after restart', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seed('observability_delivery', at(40, index));
    }
    const options = { scanLimit: 10, deleteLimit: 2, retentionMs: 30 * DAY_MS, now: NOW };
    expect((await service.collect(options)).deleted).toBe(2);

    const restarted = new CallObservabilityAuditRetentionService(new CallObservabilityStore(db, {} as any));
    expect((await restarted.collect(options)).deleted).toBe(2);
    expect((await restarted.collect(options)).deleted).toBe(1);
    expect((await restarted.collect(options)).deleted).toBe(0);

    // The checkpoint resets after the tail so a later expired record is found again.
    await seed('observability_delivery', at(50, 9));
    expect((await restarted.collect(options)).deleted).toBe(1);
  });

  test('never touches records newer than the cutoff, including concurrent writes', async () => {
    await seed('observability_subscription', at(31));
    const fresh = await seed('observability_subscription', new Date(NOW.getTime() - 1000));

    const report = await service.collect({
      scanLimit: 10,
      deleteLimit: 5,
      retentionMs: 30 * DAY_MS,
      now: NOW,
    });

    expect(report.deleted).toBe(1);
    expect((await rows()).some(row => row.id === fresh)).toBe(true);
  });

  test('rolls back deletion and progress when the transaction fails', async () => {
    const expired = await seed('observability_policy', at(31));
    await db.query(
      "CREATE TRIGGER block_audit_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
    );
    try {
      await expect(service.collect({
        scanLimit: 10,
        deleteLimit: 5,
        retentionMs: 30 * DAY_MS,
        now: NOW,
      })).rejects.toThrow();
    } finally {
      await db.query('DROP TRIGGER block_audit_delete');
    }
    expect((await rows()).some(row => row.id === expired)).toBe(true);
    expect(await state()).toBeUndefined();
  });

  test('worker stays off by default and runs bounded cleanup when explicitly enabled', async () => {
    const disabled = new CallObservabilityAuditRetentionWorker(service, store, new ConfigService({}));
    await expect(disabled.runOnce()).rejects.toThrow('AUDIT_RETENTION_DISABLED');

    const expired = await seed('observability_policy', at(31));
    const enabled = new CallObservabilityAuditRetentionWorker(service, store, new ConfigService({
      API_NOVA_OBSERVABILITY_AUDIT_RETENTION_ENABLED: 'true',
    }));
    const report = await enabled.runOnce();
    expect(report).toMatchObject({
      state: 'idle',
      evidenceScope: 'management_audit_retention',
      currentAttemptComplete: true,
    });
    expect(report.lastReport).toMatchObject({ deleted: 1 });
    expect((await rows()).some(row => row.id === expired)).toBe(false);

    await enabled.onModuleDestroy();
    expect((await state())?.state).toBe('stopped');
  });
});
