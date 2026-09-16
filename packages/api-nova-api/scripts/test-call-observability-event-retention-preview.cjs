'use strict';
require('ts-node').register({ transpileOnly: true, project: require('path').resolve(__dirname, '../tsconfig.json') });
const { API_GLOBAL_PREFIX } = require('../src/common/http-api-paths.ts');
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const base = '../src/';
const { CALL_OBSERVABILITY_ENTITIES } = require(base + 'database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require(base + 'database/entities/runtime-observability-event.entity.ts');
const { User, UserStatus } = require(base + 'database/entities/user.entity.ts');
const { Role, RoleType } = require(base + 'database/entities/role.entity.ts');
const { Permission } = require(base + 'database/entities/permission.entity.ts');
const { UserService } = require(base + 'modules/security/services/user.service.ts');
const token = require(base + 'modules/security/management-access-token.ts');
const { CallObservabilityStore } = require(base + 'modules/call-observability/call-observability.store.ts');
const { ObservabilityCursorService } = require(base + 'modules/call-observability/call-observability-cursor.service.ts');
const { ObservabilityAccessGuard } = require(base + 'modules/call-observability/call-observability-access.guard.ts');
const { ObservabilityApiExceptionFilter } = require(base + 'modules/call-observability/call-observability-api.contract.ts');
const { CallObservabilityEventsService } = require(base + 'modules/call-observability/call-observability-events.service.ts');
const { CallObservabilityEventsController } = require(base + 'modules/call-observability/call-observability-events.controller.ts');

async function fixture(t, assets = ['asset-a']) {
  const database = new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true });
  await database.initialize();
  const store = new CallObservabilityStore(database, {});
  const secret = randomUUID() + randomUUID();
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: secret });
  const cursors = new ObservabilityCursorService(config);
  const service = new CallObservabilityEventsService(store, cursors);
  const role = Object.assign(new Role(), { id: randomUUID(), name: 'reader', type: RoleType.CUSTOM, enabled: true,
    permissions: [Object.assign(new Permission(), { name: 'monitoring:read', enabled: true })],
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } } });
  const user = Object.assign(new User(), { id: randomUUID(), username: 'reader', status: UserStatus.ACTIVE,
    emailVerified: true, lockedUntil: null, roles: [role] });
  const jwt = new JwtService();
  class Fixture {}
  Module({ controllers: [CallObservabilityEventsController], providers: [
    { provide: CallObservabilityEventsService, useValue: service }, { provide: ConfigService, useValue: config },
    { provide: JwtService, useValue: jwt }, { provide: UserService, useValue: { findUserById: async () => user } },
    ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
  ] })(Fixture);
  const app = await NestFactory.create(Fixture, { logger: false, abortOnError: false });
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await database.destroy(); });
  async function request(query = {}, auth = true) {
    const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const bearer = jwt.sign({ sub: user.id, tokenUse: token.MANAGEMENT_TOKEN_USE }, { secret, algorithm: 'HS256',
      issuer: token.MANAGEMENT_TOKEN_ISSUER, audience: token.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m' });
    const response = await fetch('http://127.0.0.1:' + app.getHttpServer().address().port +
      '/api/monitoring/observability/events?' + qs, { headers: auth ? { authorization: 'Bearer ' + bearer } : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  async function insert(inputs = [{}]) {
    return store.transaction(async tx => {
      const rows = inputs.map(input => ({ id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        subjectId: randomUUID(), subjectVersion: 1, eventName: 'invocation.completed', runtimeAssetId: 'asset-a',
        eventFamily: 'runtime.request', severity: 'info', status: 'success', actorType: 'runtime',
        retentionClass: 'standard', occurredAt: new Date(), createdAt: new Date(),
        expiresAt: new Date(Date.now() + 14 * 86400000), dispatchState: 'pending',
        dimensions: { serverType: 'gateway', callerId: 'caller-a', endpointDefinitionId: 'endpoint-a' },
        details: { spanKind: 'gateway_request', outcome: 'success', durationMs: 1, toolName: 'tool-a' }, ...input }));
      for (let index = 0; index < rows.length; index += 100) {
        await tx.manager.getRepository(Event).insert(rows.slice(index, index + 100));
      }
      return rows;
    });
  }
  return { database, store, service, cursors, app, user, role, request, insert };
}



const { previewEventRetention } = require(base + 'modules/call-observability/call-observability-event-retention-preview.ts');
const { authorizeObservability } = require(base + 'modules/call-observability/call-observability-access.ts');
const { RuntimeEventDeliveryEntity: Delivery, RuntimePipelineStateEntity: Pipeline, RuntimeEventDeletionGapEntity: Gap } = require(base + 'database/entities/runtime-call-observability.entity.ts');
const scope = f => authorizeObservability(f.user);
const fixedNow = '2030-01-01T00:00:00.000Z';
const past = new Date('2029-12-31T00:00:00.000Z');
const future = new Date('2030-01-02T00:00:00.000Z');
function clock(f) {
  const read = f.store.readSnapshot.bind(f.store);
  f.store.readSnapshot = callback => read(tx => callback({ ...tx, now: fixedNow }));
}

test('preview is default-off and empty authorization does not query storage', async () => {
  const store = { readSnapshot() { throw new Error('must not query'); } };
  const authorization = { runtimeAssetIds: ['asset-a'] };
  const off = await previewEventRetention(store, authorization);
  assert.equal(off.enabled, false); assert.equal(off.scanned, 0);
  const empty = await previewEventRetention(store, { runtimeAssetIds: [] }, { enabled: true });
  assert.equal(empty.scanned, 0); assert.equal(empty.hasMore, false);
  for (const options of [{ enabled: 'true' }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { afterSequence: '01' }, { afterSequence: '-1' }, { afterSequence: '1e3' }]) {
    await assert.rejects(previewEventRetention(store, authorization, options));
  }
});

test('fixed snapshot classifies expiry, exact boundaries, lease uncertainty and any retained delivery', async t => {
  const f = await fixture(t); clock(f);
  const rows = await f.insert([
    { expiresAt: new Date(fixedNow) },
    { expiresAt: future },
    { expiresAt: past, dispatchState: 'leased', dispatchLeaseOwner: 'worker', dispatchLeaseUntil: future },
    { expiresAt: past, dispatchState: 'leased', dispatchLeaseOwner: 'worker', dispatchLeaseUntil: null },
    { expiresAt: past, dispatchState: 'leased', dispatchLeaseOwner: 'worker', dispatchLeaseUntil: new Date(fixedNow) },
    { expiresAt: null },
    { expiresAt: past },
    { expiresAt: past, dispatchState: 'unknown' },
    { expiresAt: past },
    { expiresAt: past, dispatchState: 'leased', dispatchLeaseOwner: null, dispatchLeaseUntil: past },
  ]);
  const saved = await f.database.getRepository(Event).find({ order: { sequence: 'ASC' } });
  await f.database.getRepository(Delivery).insert({ id: randomUUID(), subscriptionId: randomUUID(), subscriptionRevision: 1,
    eventId: saved[6].id, eventSequence: saved[6].sequence, status: 'succeeded', version: 1, attemptCount: 1,
    replayGeneration: 0, nextAttemptAt: past.toISOString(), leaseOwner: null, leaseUntil: null, lastError: {},
    createdAt: '2029-01-01T00:00:00.000Z', updatedAt: past.toISOString(), expiresAt: past.toISOString() });
  await f.database.query('UPDATE runtime_observability_events SET expiresAt = ? WHERE id = ?', ['invalid-time', saved[8].id]);
  const result = await previewEventRetention(f.store, scope(f), { enabled: true });
  assert.deepEqual(result, { enabled: true, scanned: 10, eligible: 2, notExpired: 1, protectedByLease: 1,
    protectedByDelivery: 1, invalid: 5, hasMore: false });
  assert.equal(JSON.stringify(result).includes('worker'), false);
  for (const row of rows) assert.equal(JSON.stringify(result).includes(row.id), false);
});

test('stable sequence pages count at most limit and preview changes no event, gap, cursor or watermark', async t => {
  const f = await fixture(t); clock(f);
  await f.insert([{ expiresAt: past }, { expiresAt: future }, { expiresAt: past }]);
  const beforeEvents = await f.database.getRepository(Event).find(), beforeState = await f.database.getRepository(Pipeline).find();
  const watermark = await f.store.watermark();
  const first = await previewEventRetention(f.store, scope(f), { enabled: true, limit: 1 });
  assert.equal(first.scanned, 1); assert.equal(first.eligible, 1); assert.equal(first.hasMore, true);
  const second = await previewEventRetention(f.store, scope(f), { enabled: true, limit: 1, afterSequence: '1' });
  assert.equal(second.scanned, 1); assert.equal(second.notExpired, 1); assert.equal(second.hasMore, true);
  const third = await previewEventRetention(f.store, scope(f), { enabled: true, limit: 1, afterSequence: '2' });
  assert.equal(third.scanned, 1); assert.equal(third.hasMore, false);
  assert.deepEqual(await previewEventRetention(f.store, scope(f), { enabled: true, limit: 1 }), first);
  assert.deepEqual(await f.database.getRepository(Event).find(), beforeEvents);
  assert.deepEqual(await f.database.getRepository(Pipeline).find(), beforeState);
  assert.equal(await f.database.getRepository(Gap).count(), 0); assert.equal(await f.store.watermark(), watermark);
  assert.equal('afterSequence' in first, false);
  await assert.rejects(previewEventRetention(f.store, scope(f), { enabled: true, afterSequence: '4' }));
});

test('asset scoping excludes hidden and unbound rows including from hasMore', async t => {
  const f = await fixture(t); clock(f);
  await f.insert([{ expiresAt: past }, { expiresAt: past, runtimeAssetId: 'hidden' }, { expiresAt: past, runtimeAssetId: null }]);
  const result = await previewEventRetention(f.store, scope(f), { enabled: true, limit: 1 });
  assert.equal(result.scanned, 1); assert.equal(result.hasMore, false); assert.equal(result.eligible, 1);
  const global = await previewEventRetention(f.store, { ...scope(f), runtimeAssetIds: null }, { enabled: true });
  assert.equal(global.scanned, 3);
});
