import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../database/entities/runtime-asset.entity';
import { RuntimeObservabilityStateEntity } from '../../database/entities/runtime-observability-state.entity';
import { RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { CallObservabilityStore } from './call-observability.store';
import { ManagedProcessLifecycleEvidenceService, MANAGED_PROCESS_LIFECYCLE_PREFIX } from './managed-process-lifecycle-evidence.service';
import { sequenceKey } from './call-observability-storage';
const entities = [RuntimeAssetEntity, RuntimeObservabilityStateEntity, RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePipelineStateEntity];
describe('servers/status retained in-flight and latest-generation evidence', () => {
  let db: DataSource, directory: string;
  const options = () => ({ type: 'sqljs' as const, location: join(directory, 'status.sqlite'), autoSave: true, entities });
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'obs-status-evidence-')); db = await new DataSource({ ...options(), synchronize: true }).initialize();
    await db.getRepository(RuntimeAssetEntity).save([{ id: 'visible', name: 'visible', type: RuntimeAssetType.MCP_SERVER }, { id: 'hidden', name: 'hidden', type: RuntimeAssetType.MCP_SERVER }]);
  });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const row = (id: string, patch: any = {}): any => ({ invocationId: id, sourceInstanceId: 'source', sourceRecordVersion: 1, recordVersion: 1, recordHash: 'a'.repeat(64), createdSequence: sequenceKey('1'), updatedSequence: sequenceKey('1'), runtimeAssetId: 'visible', serverType: 'mcp', spanKind: 'mcp_tool', origin: 'external', startedAt: '2025-01-01T00:00:00.000Z', completedAt: null, phase: 'started', outcome: null, record: { phase: 'started' }, expiresAt: '2100-01-01T00:00:00.000Z', ingestedAt: '2025-01-01T00:00:00.000Z', ...patch });
  const revision = async (id: string, from = '1', until: string | null = null, patch: any = {}) => db.getRepository(RuntimeInvocationRevisionEntity).save({ ...row(id, patch), id: id + ':' + from, recordVersion: Number(from), validFromSequence: sequenceKey(from), validUntilSequence: until === null ? null : sequenceKey(until) });
  async function status(snapshot = '1') {
    await db.getRepository(RuntimePipelineStateEntity).save({ id: 'call-observability:commit-sequence', value: { sequence: sequenceKey(snapshot) }, updatedAt: new Date().toISOString() });
    const store = new CallObservabilityStore(db, {} as any), service = new CallObservabilityServerStatusService(store);
    return store.readSnapshot(tx => service.readInSnapshot(tx, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', origin: 'external', timeBasis: 'startedAt' }, { principalId: 'tester', runtimeAssetIds: ['visible'], requiredPermissions: ['monitoring:read'], fingerprint: 'scope' }, []));
  }
  it('uses revision validity at snapshot watermark, not selected start window or mutable latest phase', async () => {
    await revision('business', '1', '2');
    await revision('business', '2', null, { phase: 'finished', completedAt: '2025-01-01T00:01:00.000Z' });
    await db.getRepository(RuntimeInvocationEntity).save(row('business', { recordVersion: 2, updatedSequence: sequenceKey('2'), phase: 'finished' }));
    await revision('upstream', '1', null, { spanKind: 'upstream_api' });
    await revision('probe', '1', null, { origin: 'probe' });
    await revision('hidden', '1', null, { runtimeAssetId: 'hidden' });
    const old = await status('1');
    expect(old.items).toHaveLength(1); expect(old.items[0].persistedInFlight).toMatchObject({ status: 'observed', count: 1, dataWatermark: '1', timeScope: 'all_retained_starts', coverage: 'unknown', livenessEvaluated: false });
    expect(old.items[0].observedBusinessRequests).toBe(0); expect(old.items[0].activeInvocations).toBeNull();
    const current = await status('2'); expect(current.items[0].persistedInFlight).toMatchObject({ status: 'observed', count: 0, dataWatermark: '2', coverage: 'unknown' });
    expect(current.items[0].activeInvocations).toBeNull(); expect(current.items[0].businessObservationStatus).toBe('not_observed');
    expect(JSON.stringify(current)).not.toContain('hidden');
  });
  it('aggregates more than the old row cap without sampling away the unfinished invocation', async () => {
    const repository = db.getRepository(RuntimeInvocationRevisionEntity);
    for (let offset = 0; offset < 5100; offset += 300) {
      await repository.insert(Array.from({ length: Math.min(300, 5100 - offset) }, (_, index) => {
        const id = 'finished-' + (offset + index);
        return { ...row(id, { phase: 'finished' }), id: id + ':1', validFromSequence: sequenceKey('1'), validUntilSequence: null };
      }));
    }
    await revision('last-unfinished');
    expect((await status()).items[0].persistedInFlight).toMatchObject({ status: 'observed', count: 1 });
  });
  it('returns unknown/null with no evidence and unavailable/null for legacy rows without snapshot revisions', async () => {
    expect((await status()).items[0].persistedInFlight).toMatchObject({ status: 'unknown', count: null, reason: 'retained_business_evidence_missing' });
    await db.getRepository(RuntimeInvocationEntity).save(row('legacy'));
    expect((await status()).items[0].persistedInFlight).toMatchObject({ status: 'unavailable', count: null, reason: 'snapshot_revision_evidence_missing' });
  });
  it('does not count future-created or expired facts as evidence of current activity or idle', async () => {
    await revision('future', '2'); await db.getRepository(RuntimeInvocationEntity).save(row('future', { createdSequence: sequenceKey('2'), updatedSequence: sequenceKey('2') }));
    await revision('expired', '1', null, { expiresAt: '2025-02-01T00:00:00.000Z' });
    expect((await status('1')).items[0].persistedInFlight).toMatchObject({ status: 'unknown', count: null });
  });
  it('marks ambiguous or invalid snapshot evidence unavailable instead of returning a guessed count', async () => {
    await revision('duplicate', '1'); await revision('duplicate', '2');
    expect((await status('2')).items[0].persistedInFlight).toMatchObject({ status: 'unavailable', count: null, reason: 'invalid_invocation_revision_evidence' });
    await db.getRepository(RuntimeInvocationRevisionEntity).clear(); await revision('invalid', '1', null, { phase: 'unknown' });
    expect((await status()).items[0].persistedInFlight.count).toBeNull();
  });
  it('reopens durable unfinished facts and managed start/terminal evidence without pretending historical completeness', async () => {
    await revision('persisted'); const store = new CallObservabilityStore(db, {} as any), lifecycle = new ManagedProcessLifecycleEvidenceService(store);
    const identity = { runtimeAssetId: 'visible', serverId: 'managed', generation: randomUUID(), pid: 1234, startedAt: '2025-01-01T00:00:00.000Z' };
    await lifecycle.recordStarted(identity);
    expect((await status()).items[0].managedLifecycleHistory).toMatchObject({ status: 'observed', startedAt: identity.startedAt, terminalAt: null, terminalEvent: null, dataWatermark: null, historyComplete: false });
    await lifecycle.recordTerminal(identity, 'unexpected_exit', { exitCode: 1 });
    const before = (await status()).items[0]; await db.destroy(); db = await new DataSource(options()).initialize(); const after = (await status()).items[0];
    expect(after.persistedInFlight).toEqual(before.persistedInFlight);
    expect(after.managedLifecycleHistory).toEqual(before.managedLifecycleHistory);
    expect(after.managedLifecycleHistory).toMatchObject({ source: 'runtime_pipeline_states', scope: 'latest_generation_only', status: 'observed', terminalEvent: 'unexpected_exit', dataWatermark: null, generation: identity.generation, historyComplete: false });
    expect(after.managedLifecycleHistory.terminalAt).not.toBeNull(); expect(after.activeInvocations).toBeNull(); expect(after.healthStatus).toBe('unknown');
  });
  it('exposes missing and corrupt lifecycle evidence separately without inventing startup or terminal events', async () => {
    expect((await status()).items[0].managedLifecycleHistory).toMatchObject({ status: 'unknown', startedAt: null, terminalAt: null, reason: 'lifecycle_evidence_missing' });
    await db.getRepository(RuntimePipelineStateEntity).save({ id: MANAGED_PROCESS_LIFECYCLE_PREFIX + 'visible', value: { observedEvent: 'started' }, updatedAt: new Date().toISOString() });
    expect((await status()).items[0].managedLifecycleHistory).toMatchObject({ status: 'unavailable', startedAt: null, terminalAt: null, reason: 'invalid_lifecycle_evidence' });
  });
});
