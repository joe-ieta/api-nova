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

describe('server_state_v1 explicit realtime protocol', () => {
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


  it('uses real sockets, pins catchup H, ACKs complete pages and excludes legacy initial/broadcast data', async () => {
    await insert(Array.from({ length: 52 }, () => ({})));
    let commits = 0;
    const f = await connect({ ack: (page, reply) => { if (!commits++) void insert().then(() => reply({ nextCursor: page.nextCursor })); else reply({ nextCursor: page.nextCursor }); } });
    f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length >= 3);
    expect(f.frames.slice(0, 3).map(page => [page.items.length, page.highWatermark])).toEqual([[50, '52'], [2, '52'], [1, '53']]);
    gateway.broadcastSystemNotification({ type: 'test', title: 'legacy', message: 'not-state' } as any);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(f.received).not.toEqual(expect.arrayContaining(['connection-established', 'system-notification', 'observability-event']));
  });

  it('replays unacknowledged pages on reconnect and resumes from a fully processed cursor', async () => {
    await insert(Array.from({ length: 51 }, () => ({})));
    const first = await connect({ ack: () => {} }); first.client.emit('subscribe-observability-state', input);
    await wait(() => first.frames.length === 1); first.client.disconnect();
    const again = await connect({ ack: () => {} }); again.client.emit('subscribe-observability-state', input);
    await wait(() => again.frames.length === 1);
    expect(again.frames[0].items.map(row => row.sequence)).toEqual(first.frames[0].items.map(row => row.sequence));
    again.client.disconnect();
    const resumed = await connect(); resumed.client.emit('subscribe-observability-state', { ...input, after: first.frames[0].nextCursor });
    await wait(() => resumed.frames.length === 1);
    expect(resumed.frames[0].items.map(row => row.sequence)).toEqual(['51']);
  });

  it.each(['wrong', 'timeout'])('disconnects %s ACK consumers without advancing to another page', async mode => {
    await insert(Array.from({ length: 51 }, () => ({})));
    const f = await connect({ ack: (_page, reply) => { if (mode === 'wrong') reply({ nextCursor: 'forged' }); } });
    f.client.emit('subscribe-observability-state', input);
    await wait(() => !f.client.connected);
    expect(f.frames).toHaveLength(1); expect(f.errors[0].code).toBe('SLOW_CONSUMER');
  }, 20000);

  it('freshly revokes an idle real socket from persisted database permission state', async () => {
    await insert(); const f = await connect(); f.client.emit('subscribe-observability-state', input);
    await wait(() => f.frames.length === 1);
    await db.getRepository(Permission).update(permissionId, { enabled: false });
    await wait(() => !f.client.connected);
    expect(f.frames).toHaveLength(1); expect(f.errors[0].code).toBe('FORBIDDEN');
  });

  it('reports resnapshot on a durable gap and rejects forged grant or client-selected assets', async () => {
    const rows = await insert();
    await store.transaction(async tx => { await recordEventDeletionGap(tx, rows[0]); await tx.manager.getRepository(Event).delete(rows[0].id); });
    const gap = await connect(); gap.client.emit('subscribe-observability-state', input);
    await wait(() => !gap.client.connected); expect(gap.errors[0]).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED', resnapshotRequired: true });
    for (const query of [{ ...input, token: 'a'.repeat(43) }, { ...input, assetIds: ['hidden'] }, { ...input, after: 'forged-cursor' }]) {
      const f = await connect(); f.client.emit('subscribe-observability-state', query); await wait(() => !f.client.connected); expect(f.frames).toHaveLength(0);
    }
  });

  it('blocks cross-mode packets and keeps an in-flight slot reserved after unsubscribe', async () => {
    const cross = await connect(); cross.client.emit('subscribe-observability', { afterSequence: '0' }); await wait(() => !cross.client.connected);
    const old = await connect({ scope: 'invocation_facts_only' }); old.client.emit('subscribe-observability-state', input); await wait(() => !old.client.connected);
    let release: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = reader.read.bind(reader);
    jest.spyOn(reader, 'read').mockImplementation(async (...args) => { entered = true; await gate; return original(...args); });
    const f = await connect(); f.client.emit('subscribe-observability-state', input); await wait(() => entered);
    f.client.emit('unsubscribe-observability-state'); f.client.emit('subscribe-observability-state', input);
    await wait(() => !f.client.connected); expect(f.errors[0].code).toBe('RATE_LIMITED');
    release!(); await wait(() => (realtime as any).inFlight.size === 0); expect(f.frames).toHaveLength(0);
  });

  it('isolates simultaneous real invocation and state connections sharing the legacy-exclusion room', async () => {
    await insert([{}, { eventName: 'invocation.completed', details: { origin: 'test', spanKind: 'mcp_tool', outcome: 'success' } }]);
    const state = await connect(), invocation = await connect({ scope: 'invocation_facts_only' });
    state.client.emit('subscribe-observability-state', input);
    invocation.client.emit('subscribe-observability', { afterSequence: '0', origin: 'test', serverType: 'mcp' });
    await wait(() => state.frames.length === 1 && invocation.oldFrames.length === 1);
    expect(state.oldFrames).toEqual([]); expect(invocation.frames).toEqual([]);
    expect(state.frames[0].items.map(item => item.evidenceScope)).toEqual(['managed_server_process_lifecycle']);
    expect(invocation.oldFrames[0].data.items.map(item => item.eventType)).toEqual(['invocation.completed']);
    expect(server.sockets.adapter.rooms.get('observability-v1')?.size).toBe(2);
    gateway.broadcastSystemNotification({ type: 'test', title: 'legacy', message: 'must not arrive' } as any);
    await new Promise(resolve => setTimeout(resolve, 50));
    for (const connection of [state, invocation]) {
      expect(connection.received).not.toContain('system-notification');
      expect(connection.received).not.toContain('connection-established');
    }
  });

  it('requires a new snapshot when the actual server-side grant reaches expiry', async () => {
    const f = await connect();
    const resolveGrant = grants.resolve.bind(grants);
    jest.spyOn(grants, 'resolve').mockImplementation((...args) => {
      // Advance only the synchronous grant clock; do not time out Engine.IO's independent heartbeat.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(grantExpiry);
      try { return resolveGrant(...args); } finally { clock.mockRestore(); }
    });
    f.client.emit('subscribe-observability-state', input);
    // Transport timers and JWT validation continue on real time.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('expiry disconnect timeout')), 3000);
      f.client.once('disconnect', () => { clearTimeout(timeout); resolve(); });
    });
    expect(f.frames).toEqual([]);
    expect(f.errors[0]).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED', resnapshotRequired: true });
  });
});
