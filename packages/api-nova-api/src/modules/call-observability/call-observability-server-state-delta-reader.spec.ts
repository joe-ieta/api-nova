import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CALL_OBSERVABILITY_ENTITIES } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity as Event } from '../../database/entities/runtime-observability-event.entity';
import { User, UserStatus } from '../../database/entities/user.entity';
import { Role } from '../../database/entities/role.entity';
import { Permission, PermissionAction, PermissionCategory } from '../../database/entities/permission.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { MANAGEMENT_TOKEN_AUDIENCE, MANAGEMENT_TOKEN_ISSUER, MANAGEMENT_TOKEN_USE } from '../security/management-access-token';
import { ObservabilityAccessGuard } from './call-observability-access.guard';
import { authorizeObservability } from './call-observability-access';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityServerStateSnapshotAuthorizer } from './call-observability-server-state-snapshot-authorizer.service';
import { CallObservabilityServerStateDeltaReader, ServerStateDeltaInput } from './call-observability-server-state-delta-reader';
import { ObservabilityCursorService } from './call-observability-cursor.service';
import { recordEventDeletionGap } from './call-observability-event-gaps';
import { publicSequence } from './call-observability-storage';

describe('server_state_v1 delta reader', () => {
  let db: DataSource, store: CallObservabilityStore, grants: CallObservabilityServerStateSnapshotAuthorizer;
  let reader: CallObservabilityServerStateDeltaReader, cursors: ObservabilityCursorService;
  let input: ServerStateDeltaInput, context: any, userId: string, permissionId: string, grantExpiry: number;
  const filter = { origin: 'test', timeBasis: 'startedAt', from: '2025-01-01T00:00:00.000Z', to: '2025-01-01T01:00:00.000Z', serverType: 'mcp' };
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', synchronize: true, entities: [...CALL_OBSERVABILITY_ENTITIES, Event, User, Role, Permission, AuditLog] }).initialize();
    const permission = await db.getRepository(Permission).save({ name: 'monitoring:read', category: PermissionCategory.MONITORING, action: PermissionAction.READ, enabled: true });
    permissionId = permission.id;
    const role = await db.getRepository(Role).save({ name: 'reader', enabled: true, permissions: [permission], metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['a'] } } });
    const user = await db.getRepository(User).save({ username: 'reader', email: 'reader@example.invalid', password: 'test-only-password', status: UserStatus.ACTIVE, emailVerified: true, roles: [role] });
    userId = user.id;
    store = new CallObservabilityStore(db, {} as any); grants = new CallObservabilityServerStateSnapshotAuthorizer();
    const secret = randomUUID() + randomUUID(), config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: secret });
    const jwt = new JwtService(), users = { findUserById: (id: string) => db.getRepository(User).findOneByOrFail({ id }) };
    const guard = new ObservabilityAccessGuard(new Reflector(), jwt, users as any, config);
    const bearer = jwt.sign({ sub: userId, tokenUse: MANAGEMENT_TOKEN_USE }, { secret, algorithm: 'HS256', audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER, expiresIn: '10m' });
    const request = { headers: { authorization: 'Bearer ' + bearer } };
    context = { getClass: () => class Test {}, getHandler: () => () => {}, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: () => {} }) }) };
    const scope = authorizeObservability(await users.findUserById(userId));
    const grant = grants.issue('0', scope, filter, ['a']);
    grantExpiry = Date.parse(grant.expiresAt);
    input = { token: grant.token, sequence: grant.sequence, filter: grant.filter };
    cursors = new ObservabilityCursorService(config);
    reader = new CallObservabilityServerStateDeltaReader(store, cursors, grants, guard);
  });
  afterEach(async () => { jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); });
  const insert = async (overrides: Array<Record<string, any>> = [{}]) => store.transaction(async tx => {
    const rows = overrides.map(override => Object.assign(new Event(), { id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0', eventName: 'server.state_changed',
      runtimeAssetId: 'a', subjectId: 'a', subjectVersion: 1, eventFamily: 'runtime.lifecycle', severity: 'info', status: 'success', actorType: 'system', retentionClass: 'standard', dispatchState: 'pending',
      occurredAt: new Date(tx.now), createdAt: new Date(tx.now), expiresAt: new Date(Date.now() + 600000), dimensions: { serverType: 'mcp' },
      details: { evidenceScope: 'managed_server_process_lifecycle', state: 'started', generation: randomUUID(), secret: 'private-test-secret' }, ...override }));
    const insertedIds = rows.map(row => row.id);
    for (let i = 0; i < rows.length; i += 50) await tx.manager.getRepository(Event).createQueryBuilder().insert().values(rows.slice(i, i + 50)).updateEntity(false).execute();
    expect(rows.map(row => row.id)).toEqual(insertedIds);
    return rows;
  });

  it('reads lifecycle independent of origin/window, filters members by origin and fixes the asset selection', async () => {
    await insert([{}, { runtimeAssetId: 'hidden' }, { subjectId: 'member', details: { evidenceScope: 'retained_business_in_flight', invocationId: 'member', delta: 1, revisionSequence: '1' }, dimensions: { serverType: 'mcp', origin: 'test' } },
      { subjectId: 'external', details: { evidenceScope: 'retained_business_in_flight', invocationId: 'external', delta: 1, revisionSequence: '1' }, dimensions: { serverType: 'mcp', origin: 'external' } },
      { eventName: 'invocation.completed' }, { eventName: 'legacy.reported_state', details: { evidenceScope: 'legacy', secret: 'private-test-secret' } }, { dimensions: { serverType: 'gateway' } }]);
    const page = await reader.read(input, context);
    expect(page.items.map(item => item.subjectId)).toEqual(['a', 'member']);
    expect(page.refreshRequired).toBe(true);
    expect(JSON.stringify(page)).not.toContain('private-test-secret');
    expect(page.items.every(item => item.refreshRequired)).toBe(true);
    await expect(reader.read({ ...input, assetIds: ['hidden'] } as any, context)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('pins catchup high watermark across pages then admits later commits only after completion', async () => {
    await insert([{}, {}, {}]);
    const first = await reader.read({ ...input, limit: 1 }, context);
    await insert();
    const second = await reader.read({ ...input, after: first.nextCursor, limit: 1 }, context);
    const third = await reader.read({ ...input, after: second.nextCursor, limit: 1 }, context);
    const live = await reader.read({ ...input, after: third.nextCursor, limit: 1 }, context);
    expect([first, second, third, live].map(page => page.highWatermark)).toEqual(['3', '3', '3', '4']);
    expect([first, second, third, live].map(page => page.items[0].sequence)).toEqual(['1', '2', '3', '4']);
    expect(third.hasMore).toBe(false);
  });

  it('refreshes actual persisted roles on every page and again after DB read', async () => {
    await insert();
    const first = await reader.read(input, context);
    await db.getRepository(Permission).update(permissionId, { enabled: false });
    await expect(reader.read({ ...input, after: first.nextCursor }, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.getRepository(Permission).update(permissionId, { enabled: true });
    const original = store.readSnapshot.bind(store);
    jest.spyOn(store, 'readSnapshot').mockImplementation(async operation => { const result = await original(operation); await db.getRepository(Permission).update(permissionId, { enabled: false }); return result; });
    await expect(reader.read(input, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects forged grant, H/filter/cursor changes and cursor reuse across tokens', async () => {
    await insert();
    const page = await reader.read(input, context);
    await expect(reader.read({ ...input, token: 'a'.repeat(43) }, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    await expect(reader.read({ ...input, sequence: '1' }, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    await expect(reader.read({ ...input, filter: { ...filter, origin: 'external' } }, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    await expect(reader.read({ ...input, after: page.nextCursor + 'a' }, context)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    const scope = authorizeObservability(await db.getRepository(User).findOneByOrFail({ id: userId }));
    const next = grants.issue('0', scope, filter, ['a']);
    await expect(reader.read({ ...input, token: next.token, after: page.nextCursor }, context)).rejects.toMatchObject({ code: 'CURSOR_SCOPE_MISMATCH' });
    const binding = { kind: 'event' as const, endpoint: 'obsServerStateDeltas', sort: 'server_state_v1:sequence:asc', authorization: scope };
    const cursor = cursors.open(page.nextCursor, binding);
    expect(cursor.expiresAt).toBeLessThanOrEqual(grantExpiry);
    const beyond = cursors.issue(binding, { filter: cursor.filter, snapshotSeq: '1', position: { sequence: '2', complete: 'false' } });
    await expect(reader.read({ ...input, after: beyond }, context)).rejects.toMatchObject({ code: 'CURSOR_SCOPE_MISMATCH' });
  });

  it('requires resnapshot for retained expiry or scoped deletion gaps without revealing hidden gaps', async () => {
    const rows = await insert([{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, { id: '00000000-0000-4000-8000-000000000000', runtimeAssetId: 'hidden' }]);
    await store.transaction(async tx => { await recordEventDeletionGap(tx, rows[1]); await tx.manager.getRepository(Event).delete(rows[1].id); });
    expect((await reader.read(input, context)).items).toHaveLength(1);
    await store.transaction(async tx => { await recordEventDeletionGap(tx, rows[0]); await tx.manager.getRepository(Event).delete(rows[0].id); });
    await expect(reader.read(input, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
  });

  it('fails expiry closed and bounds an empty filtered scan', async () => {
    await insert(Array.from({ length: 1001 }, () => ({ dimensions: { serverType: 'gateway' } })));
    const first = await reader.read(input, context);
    expect(first.items).toEqual([]); expect(first.scannedEvents).toBe(1000); expect(first.hasMore).toBe(true);
    const last = await reader.read({ ...input, after: first.nextCursor }, context);
    expect(last.scannedEvents).toBe(1); expect(last.hasMore).toBe(false);
    const rows = await insert();
    await db.getRepository(Event).update(rows[0].id, { expiresAt: new Date(0) });
    await expect(reader.read({ ...input, after: last.nextCursor }, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
  });

  it('refuses stale grant after process-local authorizer restart even if the database watermark survives', async () => {
    await insert();
    expect(await store.watermark()).toBe('1');
    jest.spyOn(grants, 'resolve').mockImplementation(new CallObservabilityServerStateSnapshotAuthorizer().resolve.bind(new CallObservabilityServerStateSnapshotAuthorizer()));
    await expect(reader.read(input, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    expect(publicSequence(await store.watermark())).toBe('1');
  });

  it('expires at the server grant deadline and rejects malformed supported lifecycle evidence', async () => {
    const rows = await insert();
    await db.getRepository(Event).update(rows[0].id, { details: { evidenceScope: 'managed_server_process_lifecycle', state: 'started', generation: '-'.repeat(36) } });
    await expect(reader.read(input, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    jest.spyOn(Date, 'now').mockReturnValue(grantExpiry);
    await expect(reader.read(input, context)).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
  });
});
