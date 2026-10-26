import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull } from 'typeorm';
import { AuditAction, AuditLevel, AuditLog, AuditStatus } from '../../database/entities/audit-log.entity';
import { Permission } from '../../database/entities/permission.entity';
import { Role } from '../../database/entities/role.entity';
import { User } from '../../database/entities/user.entity';
import {
  CALL_OBSERVABILITY_ENTITIES,
  RuntimeEventDeliveryAttemptEntity,
  RuntimeEventDeliveryEntity,
  RuntimeEventSubscriptionEntity,
  RuntimeIngestCheckpointEntity,
  RuntimeIngestQuarantineEntity,
  RuntimeIngestReceiptEntity,
  RuntimeIngestReceiptTombstoneEntity,
  RuntimeInvocationEntity,
  RuntimeInvocationRevisionEntity,
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
import { ObservabilityCommandStore } from './call-observability-command.store';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { CallObservabilityDeliveriesService } from './call-observability-deliveries.service';
import { CallObservabilityCollector } from './call-observability.collector';
import {
  CallObservabilityLifecycleRetentionService,
  DELIVERY_RETENTION_FLOOR_MS,
  LIFECYCLE_RETENTION_STATE_ID,
  RECEIPT_RETENTION_FLOOR_MS,
} from './call-observability-lifecycle-retention.service';
import {
  CallObservabilityLifecycleRetentionWorker,
  lifecycleRetentionWorkerConfiguration,
} from './call-observability-lifecycle-retention.worker';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { CallObservabilityStore } from './call-observability.store';
import { canonicalJson, contentHash, DAY_MS } from './call-observability-storage';

jest.setTimeout(60000);

describe('call observability lifecycle retention (OBS-14-03D)', () => {
  let root: string;
  let sourceDirectory: string;
  let db: DataSource;
  let payloads: CallObservabilityPayloadStore;
  let store: CallObservabilityStore;
  let collector: CallObservabilityCollector;
  let service: CallObservabilityLifecycleRetentionService;
  const NOW = new Date('2026-09-26T12:00:00.000Z');
  const at = (days: number, offsetMs = 0) => new Date(NOW.getTime() - days * DAY_MS + offsetMs).toISOString();
  const repository = () => db.getRepository(RuntimePipelineStateEntity);
  const deliveries = () => db.getRepository(RuntimeEventDeliveryEntity);
  const attempts = () => db.getRepository(RuntimeEventDeliveryAttemptEntity);
  const subscriptions = () => db.getRepository(RuntimeEventSubscriptionEntity);
  const events = () => db.getRepository(RuntimeObservabilityEventEntity);
  const receipts = () => db.getRepository(RuntimeIngestReceiptEntity);
  const tombstones = () => db.getRepository(RuntimeIngestReceiptTombstoneEntity);
  const idempotency = () => db.getRepository(RuntimeObservabilityIdempotencyEntity);
  const state = async () =>
    (await repository().findOneBy({ id: LIFECYCLE_RETENTION_STATE_ID }))?.value;

  const seedDelivery = async (overrides: any = {}): Promise<string> => {
    const id = randomUUID();
    await deliveries().insert({
      id, subscriptionId: randomUUID(), subscriptionRevision: 1, eventId: randomUUID(),
      eventSequence: '00000000000000000001', status: 'succeeded', version: 1, attemptCount: 0,
      replayGeneration: 0, nextAttemptAt: at(31), leaseOwner: null, leaseUntil: null, lastError: {},
      createdAt: at(31), updatedAt: at(31), expiresAt: at(0), ...overrides,
    });
    return id;
  };
  const seedAttempt = async (deliveryId: string, completedAt: string | null): Promise<void> => {
    await attempts().insert({
      id: randomUUID(), deliveryId, attemptNo: 1, startedAt: at(31), completedAt,
      result: 'permanent_failure', durationMs: 1, httpStatus: null, errorCategory: null, responseSummary: null,
    });
  };
  const receiptIdentity = (sourceInstanceId: string, eventId: string) =>
    contentHash(canonicalJson([sourceInstanceId, eventId]));
  const seedReceipt = async (overrides: any = {}): Promise<string> => {
    const sourceInstanceId = randomUUID();
    const eventId = randomUUID();
    const id = receiptIdentity(sourceInstanceId, eventId);
    await receipts().insert({
      id, sourceInstanceId, eventId, recordHash: 'a'.repeat(64), invocationId: randomUUID(),
      createdAt: at(33), expiresAt: at(1), ...overrides,
    });
    return id;
  };
  const seedIdempotency = async (overrides: any = {}): Promise<string> => {
    const id = randomUUID();
    await idempotency().insert({
      id, ownerId: randomUUID(), requestHash: 'r'.repeat(64),
      response: { scopeFingerprint: 'f'.repeat(64),
        result: { statusCode: 202, resourceId: randomUUID(), version: 1 } },
      expiresAt: at(1), ...overrides,
    });
    return id;
  };
  const record = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    invocationId: randomUUID(),
    eventId: randomUUID(),
    sourceInstanceId: sourceId,
    sourceSequence: 1,
    recordVersion: 1,
    phase: 'started',
    requestId: randomUUID(),
    traceId: randomUUID(),
    rootInvocationId: randomUUID(),
    spanKind: 'gateway_request',
    serverType: 'gateway',
    transport: 'gateway',
    protocolTransport: 'http',
    origin: 'external',
    runtimeAssetId: randomUUID(),
    identitySource: 'authenticated',
    callerId: 'trusted-caller',
    credentialId: 'credential-reference',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    method: 'GET',
    path: '/example',
    ...overrides,
  });
  const writeSource = async (name: string, content: string): Promise<string> => {
    const path = join(sourceDirectory, name);
    await fs.writeFile(path, content);
    return path;
  };
  const importFile = async (name: string) => {
    let report = await collector.collectFile(name);
    while (report.hasMore) report = await collector.collectFile(name);
    return report;
  };

  beforeEach(async () => {
    const temporaryRoot = resolve(process.cwd(), '../../.tmp/lifecycle-retention');
    await fs.mkdir(temporaryRoot, { recursive: true });
    root = await fs.mkdtemp(join(temporaryRoot, 'run-'));
    sourceDirectory = join(root, 'source');
    await fs.mkdir(sourceDirectory);
    process.env.API_NOVA_AUDIT_DIR = sourceDirectory;
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(root, 'data');
    db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, AuditLog, User, Role, Permission],
    }).initialize();
    payloads = new CallObservabilityPayloadStore();
    store = new CallObservabilityStore(db, payloads);
    collector = new CallObservabilityCollector(store);
    service = new CallObservabilityLifecycleRetentionService(store);
  });

  afterEach(async () => {
    collector.onModuleDestroy();
    await payloads?.onModuleDestroy();
    if (db?.isInitialized) await db.destroy();
    if (process.env.API_NOVA_AUDIT_DIR === sourceDirectory) delete process.env.API_NOVA_AUDIT_DIR;
    delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('enforces the 30-day delivery floor exactly', async () => {
    const boundary = await seedDelivery({ createdAt: at(30), expiresAt: at(0) });
    const newer = await seedDelivery({ createdAt: at(30, 1), expiresAt: at(0) });
    const shortWindow = await seedDelivery({ createdAt: at(29), expiresAt: at(0) });

    const report = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });

    expect(DELIVERY_RETENTION_FLOOR_MS).toBe(30 * DAY_MS);
    expect(report.deliveries).toMatchObject({
      status: 'completed', scanned: 1, deleted: 1, deletedDeliveries: 1, deletedAttempts: 0,
    });
    const remaining = (await deliveries().find()).map(row => row.id);
    expect(remaining).not.toContain(boundary);
    expect(remaining).toEqual(expect.arrayContaining([newer, shortWindow]));
  });

  test('protects leased and open-attempt deliveries, then deletes them with attempts', async () => {
    const leased = await seedDelivery({
      status: 'in_flight', leaseOwner: 'worker-1', leaseUntil: at(0, 60000),
      createdAt: at(31), expiresAt: at(0),
    });
    await seedAttempt(leased, at(1));
    const open = await seedDelivery({ status: 'pending', createdAt: at(31), expiresAt: at(0) });
    await seedAttempt(open, null);

    const first = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(first.deliveries).toMatchObject({
      deleted: 0, deletedDeliveries: 0, deletedAttempts: 0,
      retainedReasons: { lease_active: 1, open_attempt: 1 },
    });
    expect(await deliveries().count()).toBe(2);
    expect(await attempts().count()).toBe(2);

    await deliveries().update({ id: leased }, { status: 'pending', leaseOwner: null, leaseUntil: null });
    await attempts().update({ deliveryId: open, completedAt: IsNull() }, { completedAt: at(1) });

    const second = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(second.deliveries).toMatchObject({ deleted: 2, deletedDeliveries: 2, deletedAttempts: 2 });
    expect(await deliveries().count()).toBe(0);
    expect(await attempts().count()).toBe(0);
  });

  test('keeps an event-expired delivery queryable and rejects retry', async () => {
    await store.transaction(tx => { tx.nextSequence(); return Promise.resolve(); });
    const subscriptionId = randomUUID();
    await subscriptions().insert({
      id: subscriptionId, ownerId: randomUUID(), name: 'Runtime events', version: 1, state: 'enabled',
      destination: 'https://monitor.example/events', secretRef: 'webhook-key',
      filter: {}, scope: { mode: 'all' }, effectiveFromSequence: '00000000000000000001',
      createdAt: at(31), updatedAt: at(31), pausedFromSequence: null, deletedAt: null,
    } as any);
    const eventId = randomUUID();
    await events().insert({
      id: eventId, eventFamily: RuntimeObservabilityEventFamily.RUNTIME_REQUEST,
      eventName: 'invocation.completed', severity: RuntimeObservabilitySeverity.INFO,
      status: RuntimeObservabilityStatus.SUCCESS, occurredAt: new Date(at(31)),
      actorType: RuntimeObservabilityActorType.RUNTIME,
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
      schemaVersion: '1.0', sequence: '00000000000000000001', subjectId: 'subject-1', subjectVersion: 1,
      dispatchState: 'materialized', expiresAt: new Date(at(1)), createdAt: new Date(at(31)),
      details: {}, dimensions: {},
    } as any);
    const deliveryId = await seedDelivery({
      subscriptionId, eventId, eventSequence: '00000000000000000001', status: 'dead',
      createdAt: at(31), expiresAt: at(0),
    });
    const config = new ConfigService({
      API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32),
      API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'c'.repeat(32),
      API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'v1',
    });
    const commands = new ObservabilityCommandStore(store, config);
    const cursors = new ObservabilityCursorService(config);
    const audit = { log: async () => ({ id: randomUUID() }) };
    const deliveriesService = new CallObservabilityDeliveriesService(store, commands, cursors, audit as any);
    const authorization = {
      principalId: 'principal-1', runtimeAssetIds: null,
      requiredPermissions: ['monitoring:read', 'monitoring:delivery:retry'] as const,
      fingerprint: 'a'.repeat(64),
    };

    const view = await deliveriesService.get(deliveryId, {}, authorization as any);
    expect(view.data).toMatchObject({ deliveryId, eventId, status: 'dead' });
    await expect(deliveriesService.retry(deliveryId, { reason: 'manual retry' }, {},
      'retry-key-1', authorization as any, randomUUID())).rejects.toMatchObject({ code: 'EVENT_EXPIRED' });

    const report = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(report.deliveries.deleted).toBe(1);
    expect(await deliveries().count()).toBe(0);
  });

  test('removes receipts only past the 32-day boundary and writes a non-expiring tombstone', async () => {
    const boundaryId = await seedReceipt({ createdAt: at(32), expiresAt: at(0) });
    const olderId = await seedReceipt({ createdAt: at(33), expiresAt: at(1) });
    const insideId = await seedReceipt({ createdAt: at(31), expiresAt: at(1) });
    const futureId = await seedReceipt({ createdAt: at(33), expiresAt: at(0, 1) });
    const invalidId = await seedReceipt({ createdAt: at(33), expiresAt: at(1), recordHash: 'not-a-hash' });

    const report = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });

    expect(RECEIPT_RETENTION_FLOOR_MS).toBe(32 * DAY_MS);
    expect(report.receipts).toMatchObject({
      deleted: 2, tombstoned: 2, retained: 1, retainedReasons: { invalid_record_hash: 1 },
    });
    const remaining = (await receipts().find()).map(row => row.id);
    expect(remaining).not.toContain(boundaryId);
    expect(remaining).not.toContain(olderId);
    expect(remaining).toEqual(expect.arrayContaining([insideId, futureId, invalidId]));
    expect(await tombstones().count()).toBe(2);
    const tombstone = await tombstones().findOneByOrFail({ id: boundaryId });
    expect(tombstone.recordHash).toBe('a'.repeat(64));
    expect(tombstone.receiptExpiresAt).toBe(at(0));
    expect(tombstone.tombstonedAt).toEqual(expect.any(String));
    const columns: Array<{ name: string }> = await db.query('PRAGMA table_info("runtime_ingest_receipt_tombstones")');
    expect(columns.map(column => column.name)).not.toContain('expiresAt');
    expect(columns.map(column => column.name)).not.toContain('tombstoneExpiresAt');
  });

  test('tombstone replay from the original and a copied file adds nothing and hash conflicts stay isolated', async () => {
    const sourceId = randomUUID();
    const evidence = record(sourceId);
    const name = 'calls-v2-' + randomUUID() + '.jsonl';
    await writeSource(name, JSON.stringify(evidence) + '\n');
    const imported = await importFile(name);
    expect(imported.processedRecords).toBe(1);

    const receiptId = receiptIdentity(sourceId, evidence.eventId);
    await receipts().update({ id: receiptId }, { createdAt: at(33), expiresAt: at(1) });
    const collected = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(collected.receipts).toMatchObject({ deleted: 1, tombstoned: 1 });
    expect(await tombstones().findOneBy({ id: receiptId })).toBeTruthy();

    const invocationsBefore = await db.getRepository(RuntimeInvocationEntity).count();
    const revisionsBefore = await db.getRepository(RuntimeInvocationRevisionEntity).count();
    const eventsBefore = await events().count();
    const watermarkBefore = await store.watermark();

    // Original file: rewind the committed offset so the collector reads the same bytes again.
    const checkpoint = await db.getRepository(RuntimeIngestCheckpointEntity).findOneByOrFail({ fileName: name });
    await db.getRepository(RuntimeIngestCheckpointEntity).update({ id: checkpoint.id }, { byteOffset: '0' });
    const original = await importFile(name);
    expect(original.duplicateRecords).toBe(1);

    // Renamed copy: new file identity, same source event identity and payload.
    const copyName = 'calls-v2-' + randomUUID() + '.jsonl';
    await writeSource(copyName, JSON.stringify(evidence) + '\n');
    const copy = await importFile(copyName);
    expect(copy.duplicateRecords).toBe(1);

    // Changed hash with the same identity remains an isolated source conflict.
    const changedName = 'calls-v2-' + randomUUID() + '.jsonl';
    await writeSource(changedName, JSON.stringify({ ...evidence, path: '/mutated' }) + '\n');
    const changed = await importFile(changedName);
    expect(changed.quarantinedRecords).toBe(1);

    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(invocationsBefore);
    expect(await db.getRepository(RuntimeInvocationRevisionEntity).count()).toBe(revisionsBefore);
    expect(await events().count()).toBe(eventsBefore);
    expect(await store.watermark()).toBe(watermarkBefore);
    const quarantine = await db.getRepository(RuntimeIngestQuarantineEntity).find();
    expect(quarantine.some(row => row.reason === 'SOURCE_EVENT_CONFLICT')).toBe(true);
  });

  test('retains valid management idempotency, removes expired rows and allows the key to re-execute', async () => {
    const config = new ConfigService({ API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: 'i'.repeat(32) });
    const commands = new ObservabilityCommandStore(store, config);
    const authorization = {
      principalId: 'principal-1', runtimeAssetIds: null,
      requiredPermissions: ['monitoring:read'] as const, fingerprint: 'a'.repeat(64),
    };
    let executions = 0;
    const authorize = async () => undefined;
    const operation = async () => {
      executions += 1;
      return { statusCode: 202 as const, resourceId: 'policy-1', version: 1 };
    };
    const command = {
      method: 'POST' as const, path: '/api/v1/monitoring/observability/policies',
      key: 'lifecycle-key-1', request: { name: 'policy' },
    };
    expect((await commands.execute(authorization as any, command, authorize, operation)).replayed).toBe(false);
    expect((await commands.execute(authorization as any, command, authorize, operation)).replayed).toBe(true);
    expect(executions).toBe(1);

    const row = (await idempotency().find())[0];
    const boundary = Date.parse(row.expiresAt);
    const validRun = await service.collect({
      scanLimit: 100, deleteLimit: 50, now: new Date(boundary - 1000),
    });
    expect(validRun.idempotency).toMatchObject({ deleted: 0, scanned: 0 });
    expect(await idempotency().count()).toBe(1);

    const expiredRun = await service.collect({
      scanLimit: 100, deleteLimit: 50, now: new Date(boundary + 1000),
    });
    expect(expiredRun.idempotency).toMatchObject({ deleted: 1 });
    expect(await idempotency().count()).toBe(0);

    expect((await commands.execute(authorization as any, command, authorize, operation)).replayed).toBe(false);
    expect(executions).toBe(2);
  });

  test('keeps a delivery referenced by a valid idempotency result until that result expires', async () => {
    const deliveryId = await seedDelivery({ createdAt: at(31), expiresAt: at(0) });
    const idempotencyId = await seedIdempotency({
      response: { scopeFingerprint: 'f'.repeat(64),
        result: { statusCode: 202, resourceId: deliveryId, version: 1 } },
      expiresAt: at(0, 60000),
    });

    const protectedRun = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(protectedRun.deliveries).toMatchObject({
      deleted: 0, retainedReasons: { valid_command_result: 1 },
    });
    expect(await deliveries().count()).toBe(1);
    expect(await idempotency().count()).toBe(1);

    await idempotency().update({ id: idempotencyId }, { expiresAt: at(1) });
    const released = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });
    expect(released.idempotency.deleted).toBe(1);
    expect(released.deliveries.deleted).toBe(1);
    expect(await deliveries().count()).toBe(0);
  });

  test('rolls back the failing phase and preserves rows and progress', async () => {
    const options = { scanLimit: 100, deleteLimit: 50, now: NOW };
    const block = async (table: string, operation: () => Promise<unknown>) => {
      await db.query(
        `CREATE TRIGGER "block_${table}" BEFORE DELETE ON "${table}" BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
      );
      try {
        await expect(operation()).rejects.toThrow();
      } finally {
        await db.query(`DROP TRIGGER "block_${table}"`);
      }
    };

    const idempotencyId = await seedIdempotency();
    await block('runtime_observability_idempotency', () => service.collect(options));
    expect(await idempotency().count()).toBe(1);
    expect((await state())?.idempotency).toBeUndefined();
    await idempotency().delete({ id: idempotencyId });

    const receiptId = await seedReceipt();
    await block('runtime_ingest_receipts', () => service.collect(options));
    expect(await receipts().count()).toBe(1);
    expect(await tombstones().count()).toBe(0);
    expect((await state())?.receipts).toBeUndefined();
    await receipts().delete({ id: receiptId });

    const deliveryId = await seedDelivery();
    await seedAttempt(deliveryId, at(1));
    await block('runtime_event_deliveries', () => service.collect(options));
    expect(await deliveries().count()).toBe(1);
    expect(await attempts().count()).toBe(1);
    expect((await state())?.deliveries).toBeUndefined();
  });

  test('never deletes audit rows in any phase', async () => {
    const audits = db.getRepository(AuditLog);
    const ids: string[] = [];
    for (const resource of ['observability_delivery', 'observability_policy', null]) {
      const row = audits.create({
        action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO, status: AuditStatus.SUCCESS,
        ...(resource ? { resource } : {}),
      });
      await audits.save(row);
      await audits.update({ id: row.id }, { createdAt: new Date(at(40)) });
      ids.push(row.id);
    }
    await seedIdempotency();
    await seedReceipt();
    await seedDelivery();

    const report = await service.collect({ scanLimit: 100, deleteLimit: 50, now: NOW });

    expect(report.status).toBe('completed');
    const remaining = (await audits.find()).map(row => row.id);
    for (const id of ids) expect(remaining).toContain(id);
    expect(await audits.count()).toBe(3);
  });

  test('resumes bounded batches after restart and resets the cursor at the tail', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedIdempotency({ expiresAt: at(10, index) });
      await seedReceipt({ createdAt: at(40, index), expiresAt: at(5, index) });
      await seedDelivery({ createdAt: at(40, index), expiresAt: at(5, index) });
    }
    const options = { scanLimit: 10, deleteLimit: 2, now: NOW };
    const first = await service.collect(options);
    expect(first.status).toBe('waiting');
    expect([first.idempotency.deleted, first.receipts.deleted, first.deliveries.deleted]).toEqual([2, 2, 2]);

    const restarted = new CallObservabilityLifecycleRetentionService(store);
    const second = await restarted.collect(options);
    expect([second.idempotency.deleted, second.receipts.deleted, second.deliveries.deleted]).toEqual([2, 2, 2]);
    const third = await restarted.collect(options);
    expect(third.status).toBe('completed');
    expect([third.idempotency.deleted, third.receipts.deleted, third.deliveries.deleted]).toEqual([1, 1, 1]);
    expect(third.idempotency.checkpoint).toBeNull();
    expect(third.receipts.checkpoint).toBeNull();
    expect(third.deliveries.checkpoint).toBeNull();
    expect(await idempotency().count()).toBe(0);
    expect(await receipts().count()).toBe(0);
    expect(await deliveries().count()).toBe(0);

    await seedIdempotency({ expiresAt: at(20) });
    await seedReceipt({ createdAt: at(41), expiresAt: at(5) });
    await seedDelivery({ createdAt: at(41), expiresAt: at(5) });
    const late = await restarted.collect(options);
    expect([late.idempotency.deleted, late.receipts.deleted, late.deliveries.deleted]).toEqual([1, 1, 1]);
  });

  test('defaults off, validates configuration strictly and cleans only when enabled', async () => {
    const defaults = lifecycleRetentionWorkerConfiguration(new ConfigService({}));
    expect(defaults).toMatchObject({ enabled: false, intervalMs: 60000, scanLimit: 128, deleteLimit: 32 });
    expect(() => lifecycleRetentionWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_ENABLED: 'yes',
    }))).toThrow('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');
    expect(() => lifecycleRetentionWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_INTERVAL_MS: '500',
    }))).toThrow('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');
    expect(() => lifecycleRetentionWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_SCAN_LIMIT: '32',
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_DELETE_LIMIT: '33',
    }))).toThrow('INVALID_LIFECYCLE_RETENTION_CONFIGURATION');

    const disabled = new CallObservabilityLifecycleRetentionWorker(service, store, new ConfigService({}));
    await disabled.onApplicationBootstrap();
    expect(await state()).toBeUndefined();
    await expect(disabled.runOnce()).rejects.toThrow('LIFECYCLE_RETENTION_DISABLED');

    // The worker collects at the real clock, so this fixture ages against it.
    const realNow = Date.now();
    const aged = (ms: number) => new Date(realNow - ms).toISOString();
    const deliveryId = await seedDelivery({
      createdAt: aged(31 * DAY_MS), expiresAt: aged(DAY_MS),
    });
    const idempotencyId = await seedIdempotency({ expiresAt: aged(DAY_MS) });
    const receiptId = await seedReceipt({
      createdAt: aged(33 * DAY_MS), expiresAt: aged(DAY_MS),
    });
    const enabled = new CallObservabilityLifecycleRetentionWorker(service, store, new ConfigService({
      API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_ENABLED: 'true',
    }));
    const report = await enabled.runOnce();
    expect(report).toMatchObject({
      state: 'idle', evidenceScope: 'lifecycle_retention', workerConfigured: true,
      currentAttemptComplete: true,
    });
    expect(report.lastReport).toMatchObject({ status: 'completed' });
    expect(await deliveries().findOneBy({ id: deliveryId })).toBeNull();
    expect(await idempotency().findOneBy({ id: idempotencyId })).toBeNull();
    expect(await receipts().findOneBy({ id: receiptId })).toBeNull();

    await enabled.onModuleDestroy();
    expect((await state())?.state).toBe('stopped');
  });

  test('keeps the tombstone table and unique index in both snapshots and both Initial migrations', async () => {
    const packageRoot = process.cwd();
    const sqliteSchema = await fs.readFile(resolve(packageRoot, 'database/sqlite-schema.sql'), 'utf8');
    const postgresSchema = await fs.readFile(resolve(packageRoot, 'database/postgres-schema.sql'), 'utf8');
    const sqliteMigration = await fs.readFile(
      resolve(packageRoot, 'src/database/migrations/1788825600000-InitialSqliteSchema.ts'), 'utf8');
    const postgresMigration = await fs.readFile(
      resolve(packageRoot, 'src/database/migrations/1788825601000-InitialPostgresSchema.ts'), 'utf8');
    const table = 'runtime_ingest_receipt_tombstones';
    const index = 'IDX_obs_ingest_receipt_tombstones_1';

    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toContain('CREATE TABLE "' + table + '"');
      expect(schema).toContain('CREATE UNIQUE INDEX "' + index + '"');
    }
    for (const migration of [sqliteMigration, postgresMigration]) {
      expect(migration).toContain('CREATE TABLE \\"' + table + '\\"');
      expect(migration).toContain('CREATE UNIQUE INDEX \\"' + index + '\\"');
      expect(migration).toContain('DROP TABLE \\"' + table + '\\"');
    }
    const tables: Array<{ name: string }> =
      await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    expect(tables).toHaveLength(1);
    const indexes: Array<{ sql: string }> =
      await db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [index]);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].sql.toUpperCase()).toContain('UNIQUE');
  });
});
