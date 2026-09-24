import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CALL_OBSERVABILITY_ENTITIES } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityStateEntity } from '../../database/entities/runtime-observability-state.entity';
import { RuntimeAssetEntity, RuntimeAssetType, RuntimeAssetStatus } from '../../database/entities/runtime-asset.entity';
import { CallObservabilityStore } from './call-observability.store';
import { ManagedProcessLifecycleEvidenceService } from './managed-process-lifecycle-evidence.service';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { CallObservabilityServerStateSnapshotAuthorizer, SERVER_STATE_SNAPSHOT_TTL_MS, MAX_SERVER_STATE_SNAPSHOT_GRANTS } from './call-observability-server-state-snapshot-authorizer.service';
import { CallObservabilityOverviewSnapshotAuthorizer } from './call-observability-overview-snapshot-authorizer.service';

describe('server_state_v1 snapshot grant', () => {
  let db: DataSource, store: CallObservabilityStore, grants: CallObservabilityServerStateSnapshotAuthorizer;
  let status: CallObservabilityServerStatusService;
  const asset = randomUUID(), hidden = randomUUID();
  const scope = { principalId: 'reader', fingerprint: 'current-role-fingerprint', runtimeAssetIds: [asset], requiredPermissions: ['monitoring:read'] as const };
  const filter = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z', origin: 'external', timeBasis: 'startedAt' };
  const raw = { from: filter.from, to: filter.to, origin: filter.origin };
  const open = async (database?: Uint8Array) => {
    db = await new DataSource({ type: 'sqljs', database, synchronize: !database,
      entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, RuntimeObservabilityStateEntity, RuntimeAssetEntity] }).initialize();
    store = new CallObservabilityStore(db, {} as any);
    grants = new CallObservabilityServerStateSnapshotAuthorizer();
    status = new CallObservabilityServerStatusService(store, grants);
  };
  beforeEach(async () => {
    await open();
    for (const id of [asset, hidden]) await db.getRepository(RuntimeAssetEntity).save({ id, name: id, type: RuntimeAssetType.MCP_SERVER, status: RuntimeAssetStatus.ACTIVE });
    await new ManagedProcessLifecycleEvidenceService(store).recordStarted({ runtimeAssetId: asset, serverId: 'managed', generation: randomUUID(), pid: 321, startedAt: '2026-01-01T00:00:00.000Z' });
  });
  afterEach(async () => { jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); });

  it('issues only after one successful SQL.js snapshot, binding H and the visible selection', async () => {
    let completed = false;
    const original = store.readSnapshot.bind(store);
    const read = jest.spyOn(store, 'readSnapshot').mockImplementation(async operation => { const result = await original(operation); completed = true; return result; });
    const issue = grants.issue.bind(grants);
    jest.spyOn(grants, 'issue').mockImplementation((...args) => { expect(completed).toBe(true); return issue(...args); });
    const result = await status.list(raw, scope), grant = result.data.serverStateSnapshot!;
    expect(read).toHaveBeenCalledTimes(1);
    expect(grant).toMatchObject({ scope: 'server_state_v1', sequence: '1', assetIds: [asset], isPartial: true, historyComplete: false });
    expect(grant.excludedDomains).toEqual(expect.arrayContaining(['legacy_reported_state', 'runtime_asset_directory', 'management_heartbeat', 'unsequenced_lifecycle_history']));
    expect(result.data.dataWatermark).toBeNull();
    expect(result.data.managementHeartbeat).toBeNull();
    expect(grants.authorize(grant.token, grant.sequence, scope, grant.filter, grant.assetIds)).toBe(true);
    expect(await store.watermark()).toBe('1');
    expect(JSON.stringify(grant)).not.toContain(hidden);
  });

  it('rejects forged tokens, changed H, principal, current permissions, assets and filters', async () => {
    const grant = (await status.list(raw, scope)).data.serverStateSnapshot!;
    const check = (token = grant.token, sequence = grant.sequence, auth = scope, selected = grant.filter, ids = grant.assetIds) => grants.authorize(token, sequence, auth, selected, ids);
    expect(check('forged')).toBe(false);
    expect(check(grant.token, '2')).toBe(false);
    expect(check(grant.token, '1', { ...scope, principalId: 'other' })).toBe(false);
    expect(check(grant.token, '1', { ...scope, fingerprint: 'revoked' })).toBe(false);
    expect(grants.authorize(grant.token, '1', { ...scope, requiredPermissions: [] }, grant.filter, grant.assetIds)).toBe(false);
    expect(check(grant.token, '1', { ...scope, runtimeAssetIds: [hidden] })).toBe(false);
    expect(check(grant.token, '1', scope, { ...grant.filter, origin: 'test' })).toBe(false);
    expect(check(grant.token, '1', scope, { ...grant.filter, from: '2025-01-01T00:00:00.000Z' })).toBe(false);
    expect(check(grant.token, '1', scope, grant.filter, [asset, hidden])).toBe(false);
  });

  it('expires grants and evicts oldest grants at the bounded capacity', () => {
    const initial = grants.issue('1', scope, filter, [asset]);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + SERVER_STATE_SNAPSHOT_TTL_MS + 1);
    expect(grants.authorize(initial.token, '1', scope, filter, [asset])).toBe(false);
    jest.restoreAllMocks();
    const oldest = grants.issue('1', scope, filter, [asset]);
    for (let i = 0; i < MAX_SERVER_STATE_SNAPSHOT_GRANTS; i++) grants.issue('1', scope, filter, [asset]);
    expect(grants.authorize(oldest.token, '1', scope, filter, [asset])).toBe(false);
  });

  it('fails closed after DB reopen until a new status snapshot is obtained', async () => {
    const old = (await status.list(raw, scope)).data.serverStateSnapshot!;
    const database = (db.driver as any).export() as Uint8Array;
    await db.destroy(); await open(database);
    expect(grants.authorize(old.token, old.sequence, scope, old.filter, old.assetIds)).toBe(false);
    const fresh = (await status.list(raw, scope)).data.serverStateSnapshot!;
    expect(fresh.sequence).toBe(old.sequence);
    expect(fresh.token).not.toBe(old.token);
    expect(grants.authorize(fresh.token, fresh.sequence, scope, fresh.filter, fresh.assetIds)).toBe(true);
  });

  it('does not issue after failed reads or when reused as the embedded overview block', async () => {
    const issue = jest.spyOn(grants, 'issue');
    const block = await store.readSnapshot(tx => status.readInSnapshot(tx, filter, scope, []));
    expect(block.serverStateSnapshot).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    const original = store.readSnapshot.bind(store);
    jest.spyOn(store, 'readSnapshot').mockImplementation(async operation => { await original(operation); throw new Error('commit read failed'); });
    await expect(status.list(raw, scope)).rejects.toThrow('commit read failed');
    expect(issue).not.toHaveBeenCalled();
  });

  it('cannot substitute an invocation-only overview grant and preserves empty authorization', async () => {
    const overview = new CallObservabilityOverviewSnapshotAuthorizer();
    overview.issue('1', scope, filter);
    const grant = (await status.list(raw, { ...scope, runtimeAssetIds: [] })).data.serverStateSnapshot!;
    expect(grant.assetIds).toEqual([]);
    expect(grants.authorize('1', '1', scope, filter, [asset])).toBe(false);
    expect(await new CallObservabilityOverviewSnapshotAuthorizer().authorize(grant.sequence, scope, filter)).toBe(false);
    expect(grants.authorize(grant.token, '1', scope, grant.filter, [])).toBe(false);
  });
});
