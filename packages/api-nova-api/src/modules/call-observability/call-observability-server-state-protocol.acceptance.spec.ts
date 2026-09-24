import { CallObservabilityRealtimeService } from './call-observability-realtime.service';
import { CallObservabilityEventsService } from './call-observability-events.service';
import { CallObservabilityOverviewSnapshotAuthorizer } from './call-observability-overview-snapshot-authorizer.service';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { MonitoringGateway } from '../websocket/websocket.gateway';
import { CallObservabilityServerStateRealtimeService } from './call-observability-server-state-realtime.service';
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

describe('server_state_v1 local protocol acceptance boundaries', () => {
  let db: DataSource, store: CallObservabilityStore, grants: CallObservabilityServerStateSnapshotAuthorizer;
  let reader: CallObservabilityServerStateDeltaReader, cursors: ObservabilityCursorService;
  let input: ServerStateDeltaInput, context: any, userId: string, permissionId: string, grantExpiry: number;
  let oldRealtime: CallObservabilityRealtimeService;
  let realtime: CallObservabilityServerStateRealtimeService, server: Server, http: ReturnType<typeof createServer>;
  let gateway: MonitoringGateway, bearer: string, address: string;
  const clients: ClientSocket[] = [];
  const wait = async (ready: () => boolean) => { const end = Date.now() + 12000; while (!ready()) { if (Date.now() > end) throw new Error('socket wait timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const connect = async (options: { ack?: (page: any, reply: (value: any) => void) => void; scope?: string } = {}) => {
    const client = io(address, { transports: ['websocket'], forceNew: true, reconnection: false,
      auth: { observability: true, snapshotScope: options.scope ?? 'server_state_v1', token: bearer } });
    clients.push(client);
    const frames: any[] = [], oldFrames: any[] = [], errors: any[] = [], received: string[] = [];
    client.onAny(event => received.push(event));
    client.on('observability-state-event', (page, reply) => { frames.push(page); if (options.ack) options.ack(page, reply); else reply({ nextCursor: page.nextCursor }); });
    client.on('observability-event', (page, reply) => { oldFrames.push(page); reply({ nextCursor: page.data.nextCursor }); });
    client.on('observability-state-error', error => errors.push(error));
    await wait(() => client.connected);
    return { client, frames, oldFrames, errors, received };
  };
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
    bearer = jwt.sign({ sub: userId, tokenUse: MANAGEMENT_TOKEN_USE }, { secret, algorithm: 'HS256', audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER, expiresIn: '10m' });
    const request = { headers: { authorization: 'Bearer ' + bearer } };
    context = { getClass: () => class Test {}, getHandler: () => () => {}, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: () => {} }) }) };
    const scope = authorizeObservability(await users.findUserById(userId));
    const grant = grants.issue('0', scope, filter, ['a']);
    grantExpiry = Date.parse(grant.expiresAt);
    input = { token: grant.token, sequence: grant.sequence, filter: grant.filter };
    cursors = new ObservabilityCursorService(config);
    reader = new CallObservabilityServerStateDeltaReader(store, cursors, grants, guard);
    realtime = new CallObservabilityServerStateRealtimeService(reader, guard);
    const overview = new CallObservabilityOverviewSnapshotAuthorizer(); overview.issue('0', scope, filter);
    oldRealtime = new CallObservabilityRealtimeService(new CallObservabilityEventsService(store, cursors, overview), guard);
    gateway = new (MonitoringGateway as any)(...Array(8).fill({}), oldRealtime, realtime);
    (gateway as any).sendInitialData = () => { throw new Error('legacy snapshot must not run'); };
    http = createServer(); server = new Server(http); (gateway as any).server = server;
    server.on('connection', socket => {
      socket.on('subscribe-observability', query => { void gateway.handleSubscribeObservability(socket, query); });
      socket.on('unsubscribe-observability', () => gateway.handleUnsubscribeObservability(socket));
      socket.on('subscribe-observability-state', query => { void gateway.handleSubscribeObservabilityState(socket, query); });
      socket.on('unsubscribe-observability-state', () => gateway.handleUnsubscribeObservabilityState(socket));
      socket.on('disconnect', () => { realtime.unsubscribe(socket); oldRealtime.unsubscribe(socket); });
      void gateway.handleConnection(socket);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    address = 'http://127.0.0.1:' + (http.address() as any).port;
  });
  afterEach(async () => { for (const client of clients.splice(0)) client.disconnect(); realtime?.onModuleDestroy(); oldRealtime?.onModuleDestroy(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); });
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


  const silentFailure = async (connection: Awaited<ReturnType<typeof connect>>, expectedFrames = 0) => {
    await wait(() => !connection.client.connected);
    expect(connection.frames).toHaveLength(expectedFrames);
    await insert();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(connection.frames).toHaveLength(expectedFrames);
    expect(connection.errors).toHaveLength(1);
  };

  it.each(['before', 'during', 'after'])('suppresses the entire page when persisted permission is revoked %s snapshot read', async phase => {
    await insert(); const f = await connect();
    const revoke = () => db.getRepository(Permission).update(permissionId, { enabled: false });
    if (phase === 'before') await revoke();
    else {
      const original = store.readSnapshot.bind(store);
      jest.spyOn(store, 'readSnapshot').mockImplementationOnce(async callback => {
        const page = await original(async tx => {
          const value = await callback(tx);
          if (phase === 'during') await tx.manager.getRepository(Permission).update(permissionId, { enabled: false });
          return value;
        });
        if (phase === 'after') await revoke();
        return page;
      });
    }
    f.client.emit('subscribe-observability-state', input);
    await silentFailure(f); expect(f.errors[0].code).toBe('FORBIDDEN');
  });

  it.each(['locked', 'role-disabled', 'asset-narrowed'])('rechecks %s in the database after an acknowledged page', async change => {
    await insert(); const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1);
    if (change === 'locked') await db.getRepository(User).update(userId, { lockedUntil: new Date(Date.now() + 60000) });
    else {
      const role = await db.getRepository(Role).findOneByOrFail({ name: 'reader' });
      await db.getRepository(Role).save(Object.assign(role, change === 'role-disabled' ? { enabled: false } : { metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['hidden'] } } }));
    }
    await silentFailure(f, 1);
    expect(['UNAUTHENTICATED', 'FORBIDDEN', 'EVENT_CURSOR_EXPIRED']).toContain(f.errors[0].code);
  });

  it.each(['principal', 'filter', 'grant', 'restart'])('rejects %s mismatch without a state page', async mismatch => {
    await insert(); const f = await connect(); let query = { ...input };
    if (mismatch === 'principal') {
      const user = await db.getRepository(User).findOneByOrFail({ id: userId });
      const scope = authorizeObservability(user);
      const other = grants.issue('0', { ...scope, principalId: randomUUID() }, filter, ['a']);
      query.token = other.token;
    } else if (mismatch === 'filter') query.filter = { ...input.filter, origin: 'other' };
    else if (mismatch === 'grant') query.token = 'a'.repeat(43);
    else {
      // A fresh process-local authority has no knowledge of the old opaque grant.
      const restarted = new CallObservabilityServerStateSnapshotAuthorizer();
      jest.spyOn(grants, 'resolve').mockImplementation(restarted.resolve.bind(restarted));
    }
    f.client.emit('subscribe-observability-state', query);
    await silentFailure(f); expect(f.errors[0]).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED', resnapshotRequired: true });
  });

  it('ignores hidden-asset gaps but rejects an authorized-asset gap on the next poll', async () => {
    const rows = await insert([{ runtimeAssetId: 'hidden', subjectId: 'hidden' }, {}]);
    await store.transaction(async tx => { await recordEventDeletionGap(tx, rows[0]); await tx.manager.getRepository(Event).delete(rows[0].id); });
    const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1);
    expect(f.frames[0].items.map(item => item.runtimeAssetId)).toEqual(['a']);
    const [lost] = await insert();
    await store.transaction(async tx => { await recordEventDeletionGap(tx, lost); await tx.manager.getRepository(Event).delete(lost.id); });
    await silentFailure(f, 1); expect(f.errors[0].code).toBe('EVENT_CURSOR_EXPIRED');
  });

  it('delivers positive subject versions in sequence order as refresh hints, not a state reducer', async () => {
    const generation = randomUUID();
    await insert([3, 1, 3].map(subjectVersion => ({ subjectVersion, details: { evidenceScope: 'managed_server_process_lifecycle', state: 'started', generation } })));
    const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1);
    expect(f.frames[0].items.map(item => [item.sequence, item.subjectVersion, item.refreshRequired])).toEqual([['1', 3, true], ['2', 1, true], ['3', 3, true]]);
    expect(f.frames[0]).toMatchObject({ refreshRequired: true, historyComplete: false });
  });

  it('rejects duplicate durable sequences atomically while allowing unacknowledged replay', async () => {
    const [first] = await insert();
    await expect(insert([{ sequence: first.sequence }])).rejects.toThrow();
    expect(await db.getRepository(Event).count()).toBe(1);
    const f = await connect({ ack: () => {} }); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1); f.client.disconnect();
    const replay = await connect(); replay.client.emit('subscribe-observability-state', input);
    await wait(() => replay.frames.length === 1);
    expect(replay.frames[0].items).toEqual(f.frames[0].items);
    expect(replay.frames[0].highWatermark).toBe('1');
  });

  it.each([0, -1, 1.5])('rejects malformed subject version %s before emitting a page', async subjectVersion => {
    await insert([{ subjectVersion }]); const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await silentFailure(f); expect(f.errors[0].code).toBe('EVENT_CURSOR_EXPIRED');
  });
  it('requires resnapshot for an unknown state evidence scope without advancing delivery', async () => {
    await insert([{ details: { evidenceScope: 'future_unrecognized_state' } }]);
    const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await silentFailure(f);
    expect(f.errors[0]).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED', resnapshotRequired: true });
  });

  it('delivers both supported evidence scopes with their distinct subjects and refresh semantics', async () => {
    await insert([{}, { subjectId: 'invocation-1', subjectVersion: 2, dimensions: { serverType: 'mcp', origin: 'test' },
      details: { evidenceScope: 'retained_business_in_flight', invocationId: 'invocation-1', delta: -1, revisionSequence: '1' } }]);
    const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1);
    expect(f.frames[0].items.map(item => [item.evidenceScope, item.subjectKind])).toEqual([
      ['managed_server_process_lifecycle', 'server'], ['retained_business_in_flight', 'in_flight_member']]);
  });});