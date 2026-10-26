import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditAction, AuditLevel, AuditLog, AuditStatus } from '../../database/entities/audit-log.entity';
import { Permission } from '../../database/entities/permission.entity';
import { Role } from '../../database/entities/role.entity';
import { User } from '../../database/entities/user.entity';
import {
  CALL_OBSERVABILITY_ENTITIES,
  RuntimeEventDeletionGapEntity,
  RuntimeEventDeliveryAttemptEntity,
  RuntimeEventDeliveryEntity,
  RuntimeIngestReceiptEntity,
  RuntimeIngestReceiptTombstoneEntity,
  RuntimeObservabilityIdempotencyEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import {
  RuntimeObservabilityActorType,
  RuntimeObservabilityEventEntity,
  RuntimeObservabilityEventFamily,
  RuntimeObservabilityRetentionClass,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityEventsService } from './call-observability-events.service';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { hasEventDeletionGap } from './call-observability-event-gaps';
import {
  CallObservabilityLifecycleRetentionService,
  LIFECYCLE_RETENTION_STATE_ID,
} from './call-observability-lifecycle-retention.service';
import {
  CallObservabilityLifecycleRetentionWorker,
  lifecycleRetentionWorkerConfiguration,
} from './call-observability-lifecycle-retention.worker';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityStore } from './call-observability.store';
import { canonicalJson, contentHash, DAY_MS, publicSequence, sequenceKey } from './call-observability-storage';

jest.setTimeout(60000);

describe('call observability expired-event physical cleanup (OBS-14-03E2B)', () => {
  let root: string;
  let db: DataSource;
  let payloads: CallObservabilityPayloadStore;
  let store: CallObservabilityStore;
  let service: CallObservabilityLifecycleRetentionService;
  const NOW = new Date('2026-09-26T12:00:00.000Z');
  const at = (days: number, offsetMs = 0) => new Date(NOW.getTime() - days * DAY_MS + offsetMs).toISOString();
  const events = () => db.getRepository(RuntimeObservabilityEventEntity);
  const gaps = () => db.getRepository(RuntimeEventDeletionGapEntity);
  const deliveries = () => db.getRepository(RuntimeEventDeliveryEntity);
  const attempts = () => db.getRepository(RuntimeEventDeliveryAttemptEntity);
  const receipts = () => db.getRepository(RuntimeIngestReceiptEntity);
  const tombstones = () => db.getRepository(RuntimeIngestReceiptTombstoneEntity);
  const idempotency = () => db.getRepository(RuntimeObservabilityIdempotencyEntity);
  const state = async () =>
    (await db.getRepository(RuntimePipelineStateEntity).findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID }))?.value;

  const seedEvent = async (overrides: any = {}): Promise<RuntimeObservabilityEventEntity> =>
    store.transaction(async tx => {
      const row = Object.assign(new RuntimeObservabilityEventEntity(), {
        id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        eventName: 'invocation.completed', runtimeAssetId: 'asset-a',
        eventFamily: RuntimeObservabilityEventFamily.RUNTIME_REQUEST,
        severity: RuntimeObservabilitySeverity.INFO, status: RuntimeObservabilityStatus.SUCCESS,
        actorType: RuntimeObservabilityActorType.RUNTIME,
        retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
        subjectId: randomUUID(), subjectVersion: 1,
        occurredAt: new Date(at(60)), createdAt: new Date(at(60)),
        expiresAt: new Date(at(1)), dispatchState: 'pending', details: {}, dimensions: {},
      }, overrides);
      await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert(row);
      return row;
    });
  const seedDelivery = async (event: RuntimeObservabilityEventEntity, overrides: any = {}): Promise<string> => {
    const id = randomUUID();
    await deliveries().insert({
      id, subscriptionId: randomUUID(), subscriptionRevision: 1, eventId: event.id,
      eventSequence: event.sequence, status: 'succeeded', version: 1, attemptCount: 0,
      replayGeneration: 0, nextAttemptAt: at(31), leaseOwner: null, leaseUntil: null, lastError: {},
      createdAt: at(31), updatedAt: at(31), expiresAt: at(0), ...overrides,
    });
    return id;
  };
  const seedAttempt = async (deliveryId: string): Promise<void> => {
    await attempts().insert({
      id: randomUUID(), deliveryId, attemptNo: 1, startedAt: at(31), completedAt: null,
      result: 'permanent_failure', durationMs: 1, httpStatus: null, errorCategory: null, responseSummary: null,
    });
  };
  const seedIdempotency = async (resourceId: string, expiresAt: string): Promise<string> => {
    const id = randomUUID();
    await idempotency().insert({
      id, ownerId: randomUUID(), requestHash: 'r'.repeat(64),
      response: { scopeFingerprint: 'f'.repeat(64),
        result: { statusCode: 202, resourceId, version: 1 } },
      expiresAt,
    } as any);
    return id;
  };
  const receiptIdentity = (sourceInstanceId: string, eventId: string) =>
    contentHash(canonicalJson([sourceInstanceId, eventId]));
  const seedReceipt = async (): Promise<string> => {
    const sourceInstanceId = randomUUID(), eventId = randomUUID();
    const id = receiptIdentity(sourceInstanceId, eventId);
    await receipts().insert({
      id, sourceInstanceId, eventId, recordHash: 'a'.repeat(64), invocationId: randomUUID(),
      createdAt: at(33), expiresAt: at(1),
    });
    return id;
  };
  const options = (overrides: any = {}) => ({
    scanLimit: 100, deleteLimit: 50, now: NOW, events: { enabled: true }, ...overrides,
  });

  beforeEach(async () => {
    const temporaryRoot = resolve(process.cwd(), '../../.tmp/event-retention-executor');
    await fs.mkdir(temporaryRoot, { recursive: true });
    root = await fs.mkdtemp(join(temporaryRoot, 'run-'));
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(root, 'data');
    db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, AuditLog, User, Role, Permission],
    }).initialize();
    payloads = new CallObservabilityPayloadStore();
    store = new CallObservabilityStore(db, payloads);
    service = new CallObservabilityLifecycleRetentionService(store);
  });

  afterEach(async () => {
    await payloads?.onModuleDestroy();
    if (db?.isInitialized) await db.destroy();
    delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('stays disabled by default and never deletes events, gaps, cursor or watermark', async () => {
    const first = await seedEvent();
    const second = await seedEvent({ expiresAt: new Date(at(0)) });
    const watermark = await store.watermark();

    const omitted = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect('events' in omitted).toBe(false);
    const disabled = await service.collect(options({ events: { enabled: false } }));
    expect('events' in disabled).toBe(false);

    expect(await events().count()).toBe(2);
    expect(await gaps().count()).toBe(0);
    expect((await state())?.events).toBeUndefined();
    expect(await store.watermark()).toBe(watermark);
    expect(await events().findOneBy({ id: first.id })).toBeTruthy();
    expect(await events().findOneBy({ id: second.id })).toBeTruthy();
  });

  test('deletes exactly the E2A-classified candidates and reports every protection reason', async () => {
    const eligible = await seedEvent();
    const boundary = await seedEvent({ expiresAt: new Date(NOW) });
    const future = await seedEvent({ expiresAt: new Date(at(0, 60000)) });
    const leased = await seedEvent({
      dispatchState: 'leased', dispatchLeaseOwner: 'worker-1', dispatchLeaseUntil: new Date(at(0, 60000)),
    });
    const unownedLease = await seedEvent({ dispatchState: 'leased', dispatchLeaseOwner: null });
    const unknownState = await seedEvent({ dispatchState: 'unknown' });
    const referenced = await seedEvent();
    await seedDelivery(referenced, { createdAt: at(10), expiresAt: at(1) });
    const invalid = await seedEvent();
    await db.query('UPDATE runtime_observability_events SET expiresAt = ? WHERE id = ?', ['invalid-time', invalid.id]);

    const report = await service.collect(options());

    expect(report.events).toMatchObject({
      status: 'completed', scanned: 6, deleted: 2, retained: 4,
      retainedReasons: { lease_active: 1, invalid_event: 2, protected_by_delivery: 1 },
      checkpoint: null,
    });
    const remaining = (await events().find()).map(row => row.id);
    expect(remaining).not.toContain(eligible.id);
    expect(remaining).not.toContain(boundary.id);
    expect(remaining).toEqual(expect.arrayContaining(
      [future, leased, unownedLease, unknownState, referenced, invalid].map(row => row.id)));
    const [gap] = await gaps().find();
    expect(gap.startSequence).toBe(sequenceKey(eligible.sequence!));
    expect(gap.endSequence).toBe(sequenceKey(boundary.sequence!));
    expect(gap.assetScope).toBe('asset-a');
  });

  test('commits delete, gap and cursor atomically and retries idempotently', async () => {
    const event = await seedEvent();
    const watermark = await store.watermark();
    await db.query('CREATE TRIGGER "block_events_delete" BEFORE DELETE ON "runtime_observability_events" '
      + "BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    try {
      await expect(service.collect(options())).rejects.toThrow();
    } finally {
      await db.query('DROP TRIGGER "block_events_delete"');
    }
    expect(await events().count()).toBe(1);
    expect(await gaps().count()).toBe(0);
    expect((await state())?.events).toBeUndefined();
    expect(await store.watermark()).toBe(watermark);

    const retried = await service.collect(options());
    expect(retried.events).toMatchObject({ deleted: 1, status: 'completed', checkpoint: null });
    expect(await events().count()).toBe(0);
    const [gap] = await gaps().find();
    expect(gap.startSequence).toBe(sequenceKey(event.sequence!));
    expect(gap.endSequence).toBe(sequenceKey(event.sequence!));
    expect((await state())?.events).toMatchObject({ deleted: 1 });

    const rerun = await service.collect(options());
    expect(rerun.events).toMatchObject({ scanned: 0, deleted: 0, status: 'completed' });
    expect(await gaps().count()).toBe(1);
    expect(await store.watermark()).toBe(watermark);
  });

  test('resumes bounded batches across service restarts and resets the cursor at the tail', async () => {
    const seeded = [];
    for (let index = 0; index < 5; index += 1) seeded.push(await seedEvent());
    const watermark = await store.watermark();
    const bounded = { scanLimit: 10, deleteLimit: 2, now: NOW, events: { enabled: true } };

    const first = await service.collect(bounded);
    expect(first.events).toMatchObject({ status: 'waiting', scanned: 5, deleted: 2 });
    expect(first.events!.checkpoint).toEqual({ sequence: publicSequence(seeded[1].sequence!) });

    const restarted = new CallObservabilityLifecycleRetentionService(store);
    const second = await restarted.collect(bounded);
    expect(second.events).toMatchObject({ status: 'waiting', deleted: 2 });
    expect(second.events!.checkpoint).toEqual({ sequence: publicSequence(seeded[3].sequence!) });
    const third = await restarted.collect(bounded);
    expect(third.events).toMatchObject({ status: 'completed', deleted: 1, checkpoint: null });
    expect(await events().count()).toBe(0);
    expect(await store.watermark()).toBe(watermark);

    const [gap] = await gaps().find();
    expect(gap.startSequence).toBe(sequenceKey(seeded[0].sequence!));
    expect(gap.endSequence).toBe(sequenceKey(seeded[4].sequence!));

    const late = await seedEvent();
    const fourth = await restarted.collect(bounded);
    expect(fourth.events).toMatchObject({ status: 'completed', deleted: 1 });
    expect(await events().findOneBy({ id: late.id })).toBeNull();
  });

  test('keeps valid idempotency results and unfinished attempts protecting their events', async () => {
    const backed = await seedEvent();
    const delivery = await seedDelivery(backed);
    const idempotencyId = await seedIdempotency(delivery, at(0, 60000));
    const open = await seedEvent();
    const openDelivery = await seedDelivery(open, { status: 'pending' });
    await seedAttempt(openDelivery);

    const protectedRun = await service.collect(options());
    expect(protectedRun.deliveries).toMatchObject({
      deleted: 0, retainedReasons: { valid_command_result: 1, open_attempt: 1 },
    });
    expect(protectedRun.events).toMatchObject({ deleted: 0, retainedReasons: { protected_by_delivery: 2 } });
    expect(await events().count()).toBe(2);
    expect(await deliveries().count()).toBe(2);

    await idempotency().update({ id: idempotencyId }, { expiresAt: at(1) });
    await attempts().update({ deliveryId: openDelivery }, { completedAt: at(1) });
    const released = await service.collect(options());
    expect(released.events).toMatchObject({ deleted: 2 });
    expect(released.deliveries).toMatchObject({ deleted: 2 });
    expect(await events().count()).toBe(0);
    expect(await deliveries().count()).toBe(0);
    expect(await attempts().count()).toBe(0);
    expect(await idempotency().count()).toBe(0);
  });

  test('honors the E2A asset scope and leaves receipts, tombstones, invocations and audit intact', async () => {
    const visible = await seedEvent();
    const hidden = await seedEvent({ runtimeAssetId: 'hidden-asset' });
    const unbound = await seedEvent({ runtimeAssetId: null });
    const receiptId = await seedReceipt();
    const audit = db.getRepository(AuditLog);
    const auditRow = audit.create({
      action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO, status: AuditStatus.SUCCESS,
      resource: 'observability_delivery',
    });
    await audit.save(auditRow);
    await audit.update({ id: auditRow.id }, { createdAt: new Date(at(40)) });

    const scoped = await service.collect(options({ events: { enabled: true, runtimeAssetIds: ['asset-a'] } }));
    expect(scoped.events).toMatchObject({ scanned: 1, deleted: 1 });
    const remaining = (await events().find()).map(row => row.id);
    expect(remaining).toEqual(expect.arrayContaining([hidden.id, unbound.id]));
    expect(remaining).not.toContain(visible.id);
    expect(await receipts().count()).toBe(0);
    expect(await tombstones().findOneBy({ id: receiptId })).toBeTruthy();
    expect(await audit.count()).toBe(1);

    const global = await service.collect(options({ events: { enabled: true, runtimeAssetIds: null } }));
    expect(global.events).toMatchObject({ deleted: 2 });
    expect(await events().count()).toBe(0);
    expect(await tombstones().count()).toBe(1);
    expect(await audit.count()).toBe(1);
  });

  test('surfaces the E1 read gate for cursors that cross a physical deletion gap', async () => {
    const rows = [];
    for (let index = 0; index < 4; index += 1) rows.push(await seedEvent());
    await events().update({ id: rows[2].id }, { expiresAt: new Date(Date.now() + DAY_MS) });
    const report = await service.collect(options());
    expect(report.events).toMatchObject({ deleted: 3, status: 'completed' });
    const cursorConfig = new ConfigService({ API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32) });
    const eventsService = new CallObservabilityEventsService(store, new ObservabilityCursorService(cursorConfig),
      { authorize: async () => true });
    const authorization = {
      principalId: 'principal-1', runtimeAssetIds: ['asset-a'],
      requiredPermissions: ['monitoring:read'] as const, fingerprint: 'a'.repeat(64),
    };

    await expect(eventsService.list({ afterSequence: '1' }, authorization as any))
      .rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    await expect(eventsService.list({ afterSequence: '2' }, authorization as any))
      .rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    const fresh = await eventsService.list({}, authorization as any);
    expect(fresh.data.items.map((item: any) => item.sequence)).toContain(publicSequence(rows[2].sequence!));
    await store.readSnapshot(async tx => {
      expect(await hasEventDeletionGap(tx, ['asset-a'], '1', '4')).toBe(true);
      expect(await hasEventDeletionGap(tx, ['asset-a'], '4', '4')).toBe(true);
      expect(await hasEventDeletionGap(tx, ['asset-a'], '3', '3')).toBe(false);
      expect(await hasEventDeletionGap(tx, ['other-asset'], '1', '4')).toBe(false);
    });
  });

  test('validates explicit event options and keeps event deletion off when only the retention worker is on', async () => {
    const invalid: any[] = [
      { events: { enabled: 'yes' } },
      { events: { enabled: true, runtimeAssetIds: 'asset-a' } },
      { events: { enabled: true, runtimeAssetIds: [''] } },
    ];
    for (const override of invalid) {
      await expect(service.collect(options(override)))
        .rejects.toMatchObject({ code: 'INVALID_LIFECYCLE_RETENTION_CONFIGURATION' });
    }
    const defaults = lifecycleRetentionWorkerConfiguration(new ConfigService({}));
    expect(defaults).toMatchObject({ enabled: false, eventsEnabled: false });
    expect(() => lifecycleRetentionWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_EVENTS_ENABLED: 'yes',
    }))).toThrow('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');

    const realNow = Date.now();
    const aged = (ms: number) => new Date(realNow - ms).toISOString();
    const event = await seedEvent({ createdAt: aged(31 * DAY_MS), expiresAt: aged(DAY_MS) });
    const retentionOnly = new CallObservabilityLifecycleRetentionWorker(service, store, new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_ENABLED: 'true',
    }));
    const report = await retentionOnly.runOnce();
    expect(report.lastReport && 'events' in report.lastReport).toBe(false);
    expect(await events().findOneBy({ id: event.id })).toBeTruthy();

    const withEvents = new CallObservabilityLifecycleRetentionWorker(service, store, new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_ENABLED: 'true',
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_EVENTS_ENABLED: 'true',
    }));
    const enabled = await withEvents.runOnce();
    expect(enabled.lastReport?.events).toMatchObject({ deleted: 1 });
    expect(await events().findOneBy({ id: event.id })).toBeNull();
    expect(await gaps().count()).toBe(1);
  });
});
