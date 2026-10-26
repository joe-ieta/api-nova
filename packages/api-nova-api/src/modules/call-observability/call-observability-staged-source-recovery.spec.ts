import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  CALL_OBSERVABILITY_ENTITIES,
  RuntimeIngestCheckpointEntity,
  RuntimeInvocationEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { CallObservabilityCollector } from './call-observability.collector';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import {
  CallObservabilitySourceLifecycle,
  SOURCE_EXIT_PREFIX,
  SOURCE_FILE_SEAL_PREFIX,
} from './call-observability-source-lifecycle.service';
import {
  CallObservabilityStagedSourceRecoveryService,
  STAGED_SOURCE_MIN_RETENTION_MS,
} from './call-observability-staged-source-recovery.service';
import {
  CallObservabilityStagedSourceRecoveryWorker,
  stagedSourceRecoveryWorkerConfiguration,
} from './call-observability-staged-source-recovery.worker';
import { CallObservabilityStore } from './call-observability.store';
import { DAY_MS } from './call-observability-storage';

const RETENTION_MS = STAGED_SOURCE_MIN_RETENTION_MS;
jest.setTimeout(60000);

describe('call observability staged source recovery (OBS-14-06T)', () => {
  let root: string;
  let sourceDirectory: string;
  let db: DataSource;
  let payloads: CallObservabilityPayloadStore;
  let store: CallObservabilityStore;
  let collector: CallObservabilityCollector;
  let service: CallObservabilityStagedSourceRecoveryService;
  const NOW = new Date('2026-09-26T12:00:00.000Z');
  const aged = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const repository = () => db.getRepository(RuntimePipelineStateEntity);
  const checkpoints = () => db.getRepository(RuntimeIngestCheckpointEntity);
  const state = async () => (await repository().findOneBy({ id: 'call-observability:staged-source-recovery' }))?.value;

  const deadPid = (): number => {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    if (!result.pid) throw new Error('fixture pid unavailable');
    return result.pid;
  };
  const manifest = async (sourceId: string, pid: number) => {
    await fs.writeFile(join(sourceDirectory, `source-v2-${sourceId}.json`), JSON.stringify({
      schemaVersion: 2,
      kind: 'runtime_audit_source',
      sourceInstanceId: sourceId,
      pid,
      startedAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    }) + '\n');
  };
  const record = (sourceId: string) => ({
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
    startedAt: new Date(NOW.getTime() - 1000).toISOString(),
    method: 'GET',
    path: '/example',
  });
  const staged = async (content: string, pid = deadPid(), sourceId = randomUUID()) => {
    const name = `calls-v2-${sourceId}.jsonl`;
    await fs.writeFile(join(sourceDirectory, name), content);
    await manifest(sourceId, pid);
    return { name, sourceId, path: join(sourceDirectory, name) };
  };
  const importFile = async (name: string) => {
    let report = await collector.collectFile(name);
    while (report.hasMore) report = await collector.collectFile(name);
    return report;
  };
  const ageFile = async (checkpointId: string, sourceId: string, ms: number) => {
    await checkpoints().update({ id: checkpointId }, { updatedAt: aged(ms) });
    const proofId = SOURCE_EXIT_PREFIX + sourceId;
    const proof = await repository().findOneBy({ id: proofId });
    await repository().update({ id: proofId }, {
      value: { ...(proof?.value || {}), observedAt: aged(ms) },
    });
  };

  beforeEach(async () => {
    const temporaryRoot = resolve(process.cwd(), '../../.tmp/staged-source-recovery');
    await fs.mkdir(temporaryRoot, { recursive: true });
    root = await fs.mkdtemp(join(temporaryRoot, 'run-'));
    sourceDirectory = join(root, 'source');
    await fs.mkdir(sourceDirectory);
    process.env.API_NOVA_AUDIT_DIR = sourceDirectory;
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = join(root, 'data');
    db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    }).initialize();
    payloads = new CallObservabilityPayloadStore();
    store = new CallObservabilityStore(db, payloads);
    const lifecycle = new CallObservabilitySourceLifecycle(store);
    collector = new CallObservabilityCollector(store, lifecycle);
    service = new CallObservabilityStagedSourceRecoveryService(store);
  });

  afterEach(async () => {
    collector.onModuleDestroy();
    await payloads?.onModuleDestroy();
    if (db?.isInitialized) await db.destroy();
    if (process.env.API_NOVA_AUDIT_DIR === sourceDirectory) delete process.env.API_NOVA_AUDIT_DIR;
    delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('deletes only fully imported, sealed and aged staged files', async () => {
    const sourceId = randomUUID();
    const file = await staged(JSON.stringify(record(sourceId)) + '\n', deadPid(), sourceId);
    const imported = await importFile(file.name);
    expect(imported.sourceState).toBe('closed');
    expect(await repository().findOneBy({ id: SOURCE_FILE_SEAL_PREFIX + imported.checkpointId }))
      .toBeTruthy();
    await ageFile(imported.checkpointId, file.sourceId, 49 * 60 * 60 * 1000);
    const invocationsBefore = await db.getRepository(RuntimeInvocationEntity).count();
    const checkpointsBefore = await checkpoints().count();
    const watermarkBefore = await store.watermark();

    const report = await service.collect({
      scanLimit: 10, deleteLimit: 10, retentionMs: RETENTION_MS, now: NOW,
    });

    expect(report).toMatchObject({ status: 'completed', scanned: 1, deleted: 1, retained: 0 });
    await expect(fs.stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await db.getRepository(RuntimeInvocationEntity).count()).toBe(invocationsBefore);
    expect(await checkpoints().count()).toBe(checkpointsBefore);
    expect(await store.watermark()).toBe(watermarkBefore);
  });

  test('enforces the 48-hour recovery window exactly', async () => {
    const sourceA = randomUUID();
    const boundary = await staged(JSON.stringify(record(sourceA)) + '\n', deadPid(), sourceA);
    const importedBoundary = await importFile(boundary.name);
    await ageFile(importedBoundary.checkpointId, sourceA, RETENTION_MS);
    const sourceB = randomUUID();
    const inside = await staged(JSON.stringify(record(sourceB)) + '\n', deadPid(), sourceB);
    const importedInside = await importFile(inside.name);
    await ageFile(importedInside.checkpointId, sourceB, RETENTION_MS - 1);

    const report = await service.collect({
      scanLimit: 10, deleteLimit: 10, retentionMs: RETENTION_MS, now: NOW,
    });

    expect(report).toMatchObject({ deleted: 1, retained: 1 });
    expect(report.retainedReasons).toMatchObject({ within_retention_window: 1 });
    await expect(fs.stat(boundary.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(inside.path)).resolves.toBeTruthy();
  });

  test('keeps partially imported and unimported files, and never examines non-source names', async () => {
    const sourceId = randomUUID();
    const partial = await staged(JSON.stringify(record(sourceId)) + '\n', deadPid(), sourceId);
    const imported = await importFile(partial.name);
    await fs.appendFile(partial.path, JSON.stringify(record(sourceId)) + '\n');
    await ageFile(imported.checkpointId, sourceId, 49 * 60 * 60 * 1000);
    const never = await staged(JSON.stringify(record(randomUUID())) + '\n');
    const foreign = [
      join(sourceDirectory, `source-v2-${randomUUID()}.json`),
      join(sourceDirectory, 'callers-1.jsonl'),
      join(sourceDirectory, '.source-v2-tmp.tmp'),
    ];
    for (const path of foreign) await fs.writeFile(path, '{}');

    const report = await service.collect({
      scanLimit: 10, deleteLimit: 10, retentionMs: RETENTION_MS, now: NOW,
    });

    expect(report.deleted).toBe(0);
    expect(report.retainedReasons).toMatchObject({
      incomplete_import: 1,
      checkpoint_missing: 1,
    });
    await expect(fs.stat(partial.path)).resolves.toBeTruthy();
    await expect(fs.stat(never.path)).resolves.toBeTruthy();
    for (const path of foreign) await expect(fs.stat(path)).resolves.toBeTruthy();
  });

  test('keeps an active source and sealed half-line fragments', async () => {
    const activeSource = randomUUID();
    const active = await staged(JSON.stringify(record(activeSource)) + '\n', process.pid, activeSource);
    await importFile(active.name);
    const halfSource = randomUUID();
    const half = await staged(
      JSON.stringify(record(halfSource)) + '\n' + '{"partial":',
      deadPid(),
      halfSource,
    );
    const importedHalf = await importFile(half.name);
    await ageFile(importedHalf.checkpointId, halfSource, 49 * 60 * 60 * 1000);

    const report = await service.collect({
      scanLimit: 10, deleteLimit: 10, retentionMs: RETENTION_MS, now: NOW,
    });

    expect(report.deleted).toBe(0);
    expect(report.retainedReasons).toMatchObject({
      source_not_closed: 1,
      incomplete_line: 1,
    });
    await expect(fs.stat(active.path)).resolves.toBeTruthy();
    await expect(fs.stat(half.path)).resolves.toBeTruthy();
  });

  test('keeps hard-linked and mismatched-identity entries', async () => {
    const sourceId = randomUUID();
    const hard = await staged(JSON.stringify(record(sourceId)) + '\n', deadPid(), sourceId);
    const imported = await importFile(hard.name);
    await ageFile(imported.checkpointId, sourceId, 49 * 60 * 60 * 1000);
    await fs.link(hard.path, join(sourceDirectory, `calls-v2-${randomUUID()}.jsonl`));

    const report = await service.collect({
      scanLimit: 10, deleteLimit: 10, retentionMs: RETENTION_MS, now: NOW,
    });

    expect(report.deleted).toBe(0);
    expect(report.retained).toBe(2);
    await expect(fs.stat(hard.path)).resolves.toBeTruthy();
  });

  test('pages bounded batches, resumes after restart and resets the cursor at the tail', async () => {
    const files: Array<{ checkpointId: string; sourceId: string; path: string }> = [];
    for (let index = 0; index < 5; index += 1) {
      const sourceId = randomUUID();
      const file = await staged(JSON.stringify(record(sourceId)) + '\n', deadPid(), sourceId);
      const imported = await importFile(file.name);
      await ageFile(imported.checkpointId, sourceId, 49 * 60 * 60 * 1000);
      files.push({ checkpointId: imported.checkpointId, sourceId, path: file.path });
    }
    const options = { scanLimit: 10, deleteLimit: 2, retentionMs: RETENTION_MS, now: NOW };
    expect((await service.collect(options)).deleted).toBe(2);
    const restarted = new CallObservabilityStagedSourceRecoveryService(store);
    expect((await restarted.collect(options)).deleted).toBe(2);
    expect((await restarted.collect(options)).deleted).toBe(1);
    const drained = await restarted.collect(options);
    expect(drained).toMatchObject({ deleted: 0, nextAfterName: null, status: 'completed' });
    expect((await state())?.checkpoint).toBeNull();
    for (const file of files.slice(0, 5)) {
      await expect(fs.stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const lateSource = randomUUID();
    const late = await staged(JSON.stringify(record(lateSource)) + '\n', deadPid(), lateSource);
    const importedLate = await importFile(late.name);
    await ageFile(importedLate.checkpointId, lateSource, 49 * 60 * 60 * 1000);
    expect((await restarted.collect(options)).deleted).toBe(1);
  });

  test('rejects configuration below the minimum window and invalid bounds', async () => {
    const configuration = stagedSourceRecoveryWorkerConfiguration(new ConfigService({}));
    expect(configuration).toMatchObject({ enabled: false, retentionHours: 48 });
    expect(() => stagedSourceRecoveryWorkerConfiguration(new ConfigService({
      API_NOVA_OBSERVABILITY_STAGED_SOURCE_RETENTION_HOURS: '47',
    }))).toThrow('INVALID_STAGED_SOURCE_RECOVERY_CONFIGURATION');
    await expect(service.collect({
      scanLimit: 10, deleteLimit: 5, retentionMs: RETENTION_MS - 1, now: NOW,
    })).rejects.toThrow('STAGED_SOURCE_RETENTION_BELOW_MINIMUM');
    await expect(service.collect({
      scanLimit: 1, deleteLimit: 2, retentionMs: RETENTION_MS, now: NOW,
    })).rejects.toThrow('INVALID_STAGED_SOURCE_RECOVERY_CONFIGURATION');
  });

  test('worker stays off by default, deletes when enabled and preserves files on failure', async () => {
    const sourceId = randomUUID();
    const file = await staged(JSON.stringify(record(sourceId)) + '\n', deadPid(), sourceId);
    const imported = await importFile(file.name);
    const stale = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    await checkpoints().update({ id: imported.checkpointId }, { updatedAt: stale });
    const proofId = SOURCE_EXIT_PREFIX + sourceId;
    const proof = await repository().findOneBy({ id: proofId });
    await repository().update({ id: proofId }, { value: { ...(proof?.value || {}), observedAt: stale } });
    const disabled = new CallObservabilityStagedSourceRecoveryWorker(
      service, store, new ConfigService({}),
    );
    await expect(disabled.runOnce()).rejects.toThrow('STAGED_SOURCE_RECOVERY_DISABLED');

    const enabled = new CallObservabilityStagedSourceRecoveryWorker(
      service, store, new ConfigService({ API_NOVA_OBSERVABILITY_STAGED_SOURCE_ENABLED: 'true' }),
    );
    const unlink = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { code: 'EACCES' }),
    );
    try {
      await expect(enabled.runOnce()).rejects.toThrow();
    } finally {
      unlink.mockRestore();
    }
    await expect(fs.stat(file.path)).resolves.toBeTruthy();
    expect(await state()).toMatchObject({ state: 'degraded', currentAttemptComplete: false });

    const report = await enabled.runOnce();
    expect(report).toMatchObject({
      state: 'idle',
      evidenceScope: 'staged_source_recovery',
      currentAttemptComplete: true,
    });
    await expect(fs.stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await enabled.onModuleDestroy();
    expect((await state())?.state).toBe('stopped');
  });
});
