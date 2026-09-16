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


const { RuntimeEventDeletionGapEntity: Gap } = require(base + 'database/entities/runtime-call-observability.entity.ts');
const { recordEventDeletionGap, hasEventDeletionGap } = require(base + 'modules/call-observability/call-observability-event-gaps.ts');
const { authorizeObservability } = require(base + 'modules/call-observability/call-observability-access.ts');
const { sequenceKey } = require(base + 'modules/call-observability/call-observability-storage.ts');
const scope = f => authorizeObservability(f.user);
const record = (f, row) => f.store.transaction(tx => recordEventDeletionGap(tx, row));

test('single-sequence insert merges adjacent intervals, preserves disjoint gaps and never advances sequence', async t => {
  const f = await fixture(t), rows = await f.insert([{}, {}, {}, {}, {}]);
  const before = await f.store.watermark();
  await record(f, rows[0]); await record(f, rows[2]); await record(f, rows[4]);
  assert.equal(await f.database.getRepository(Gap).count(), 3);
  await record(f, rows[1]); await record(f, rows[1]);
  assert.equal(await f.database.getRepository(Gap).count(), 2);
  await record(f, rows[3]);
  const [gap] = await f.database.getRepository(Gap).find();
  assert.equal(gap.startSequence, sequenceKey(rows[0].sequence));
  assert.equal(gap.endSequence, sequenceKey(rows[4].sequence));
  assert.equal(await f.store.watermark(), before);
  assert.equal(await f.database.getRepository(Event).count(), 5); // helper never deletes
});

test('real Store rollback removes the gap and parallel writers safely converge', async t => {
  const f = await fixture(t), rows = await f.insert([{}, {}, {}]);
  await assert.rejects(f.store.transaction(async tx => { await recordEventDeletionGap(tx, rows[0]); throw new Error('rollback'); }), /rollback/);
  assert.equal(await f.database.getRepository(Gap).count(), 0);
  await Promise.all(rows.map(row => record(f, row)));
  assert.equal(await f.database.getRepository(Gap).count(), 1);
});

test('noncontiguous deletion gaps protect signed cursors and authorized afterSequence while new snapshots remain available', async t => {
  const f = await fixture(t), rows = await f.insert([{}, {}, {}, {}]);
  const first = await f.request({ limit: '1' });
  const cursor = first.body.data.nextCursor || first.body.meta.nextCursor;
  assert.equal(typeof cursor, 'string');
  await f.store.transaction(async tx => {
    await recordEventDeletionGap(tx, rows[2]);
    await tx.manager.getRepository(Event).delete(rows[2].id); // isolated fixture simulates future E2
  });
  const response = await f.request({ after: cursor });
  assert.equal(response.status, 410); assert.equal(response.body.error.code, 'EVENT_CURSOR_EXPIRED');
  assert.equal(JSON.stringify(response.body).includes('startSequence'), false);
  assert.equal((await f.request()).status, 200);
  const service = new CallObservabilityEventsService(f.store, f.cursors, { authorize: async () => true });
  await assert.rejects(service.list({ afterSequence: '1' }, scope(f)), error => error.code === 'EVENT_CURSOR_EXPIRED');
  await assert.rejects(service.list({ afterSequence: '3' }, scope(f)), error => error.code === 'EVENT_CURSOR_EXPIRED');
  const later = await service.list({ afterSequence: '4' }, scope(f));
  assert.equal(later.data.items.length, 0);
  await f.store.readSnapshot(async tx => {
    assert.equal(await hasEventDeletionGap(tx, ['asset-a'], '3', '4'), true);
    assert.equal(await hasEventDeletionGap(tx, ['asset-a'], '4', '4'), false);
  });
});

test('hidden and unbound gaps do not alter asset-scoped responses or leak gap ranges', async t => {
  const f = await fixture(t), rows = await f.insert([{}, { runtimeAssetId: 'hidden-asset' }, { runtimeAssetId: null }]);
  await record(f, rows[1]); await record(f, rows[2]);
  const service = new CallObservabilityEventsService(f.store, f.cursors, { authorize: async () => true });
  assert.equal((await service.list({ afterSequence: '0' }, scope(f))).data.items.length, 1);
  await f.store.readSnapshot(async tx => {
    assert.equal(await hasEventDeletionGap(tx, [], '0', '3'), false);
    assert.equal(await hasEventDeletionGap(tx, ['asset-a'], '0', '3'), false);
    assert.equal(await hasEventDeletionGap(tx, null, '0', '3'), true);
    assert.equal(await hasEventDeletionGap(tx, ['hidden-asset'], '0', '1'), false);
  });
});


test('SQLite initial migration provides the durable gap table, indexes and range constraints without synchronization', async t => {
  const database = new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: false });
  await database.initialize(); t.after(() => database.destroy());
  const { InitialSqliteSchema1788825600000 } = require('../src/database/migrations/1788825600000-InitialSqliteSchema.ts');
  const migration = new InitialSqliteSchema1788825600000(), runner = database.createQueryRunner();
  await migration.up(runner);
  const indexes = await database.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_event_deletion_gaps'");
  for (const name of ['IDX_obs_event_gaps_scope_start', 'IDX_obs_event_gaps_scope_end', 'IDX_obs_event_gaps_end']) assert.ok(indexes.some(index => index.name === name));
  await assert.rejects(database.getRepository(Gap).insert({ id: 'bad', assetScope: 'asset-a', startSequence: sequenceKey('3'), endSequence: sequenceKey('2') }));
  await database.getRepository(Gap).insert({ id: 'valid', assetScope: 'asset-a', startSequence: sequenceKey('2'), endSequence: sequenceKey('2') });
  assert.equal(await database.getRepository(Gap).count(), 1);
  await migration.down(runner);
  assert.equal((await database.query("SELECT name FROM sqlite_master WHERE name='runtime_event_deletion_gaps'")).length, 0);
});

test('both SQL baselines and initial migrations contain matching gap schema statements', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const [dialect, migration] of [['sqlite', '1788825600000-InitialSqliteSchema'], ['postgres', '1788825601000-InitialPostgresSchema']]) {
    const sql = fs.readFileSync(path.resolve(__dirname, '../database/' + dialect + '-schema.sql'), 'utf8');
    const ts = fs.readFileSync(path.resolve(__dirname, '../src/database/migrations/' + migration + '.ts'), 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.startsWith('CREATE') && s.includes('runtime_event_deletion_gaps'));
    assert.equal(statements.length, 4);
    for (const statement of statements) assert.ok(ts.includes(JSON.stringify(statement)), dialect + ': ' + statement);
  }
});
