'use strict';
process.env.DB_TYPE = 'sqlite';
delete process.env.JWT_SECRET;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DataSource } = require('typeorm');
const { Module, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { captureAuditBody, auditDigest } = require('api-nova-parser');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity.js');
const { User, UserStatus } = require('../dist/src/database/entities/user.entity.js');
const { Role, RoleType } = require('../dist/src/database/entities/role.entity.js');
const { Permission } = require('../dist/src/database/entities/permission.entity.js');
const { AuditLog, AuditAction, AuditLevel, AuditStatus } = require('../dist/src/database/entities/audit-log.entity.js');
const { UserService } = require('../dist/src/modules/security/services/user.service.js');
const { AuditService } = require('../dist/src/modules/security/services/audit.service.js');
const tokens = require('../dist/src/modules/security/management-access-token.js');
const { CallObservabilityStore } = require('../dist/src/modules/call-observability/call-observability.store.js');
const { CallObservabilityPayloadStore } = require('../dist/src/modules/call-observability/call-observability-payload.store.js');
const { CallObservabilityPayloadsService } = require('../dist/src/modules/call-observability/call-observability-payloads.service.js');
const { CallObservabilityPayloadsController } = require('../dist/src/modules/call-observability/call-observability-payloads.controller.js');
const { ObservabilityAccessGuard } = require('../dist/src/modules/call-observability/call-observability-access.guard.js');
const { ObservabilityApiExceptionFilter } = require('../dist/src/modules/call-observability/call-observability-api.contract.js');
const root = path.resolve(__dirname, '../../../tmp/observability-payloads-tests');
const READ = 'monitoring:read', PAYLOAD = 'monitoring:payload:read';
function role(names = [READ, PAYLOAD], assets = ['asset-a']) {
  return Object.assign(new Role(), {
    id: randomUUID(), name: 'fixture-role', type: RoleType.CUSTOM, enabled: true,
    permissions: names.map(name => Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
    metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } },
  });
}
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  let app, database;
  const oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  const payloads = new CallObservabilityPayloadStore();
  if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData;
  t.after(async () => {
    if (app) await app.close();
    await payloads.onModuleDestroy();
    if (database?.isInitialized) await database.destroy();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('run-')) throw new Error('Non-owned test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  database = new DataSource({ type: 'sqljs',
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity, User, Role, Permission, AuditLog],
    synchronize: true, logging: false });
  await database.initialize();
  const secret = randomUUID() + randomUUID(), config = new ConfigService({ JWT_SECRET: secret }), jwt = new JwtService();
  const users = new Map(), auditLogs = database.getRepository(AuditLog), userRepository = database.getRepository(User);
  const audit = new AuditService(auditLogs, userRepository);
  const resolver = { async findUserById(id) { if (!users.has(id)) throw new NotFoundException(); return users.get(id); } };
  const store = new CallObservabilityStore(database, payloads);
  const service = new CallObservabilityPayloadsService(store, payloads, audit, resolver);
  let reads = 0;
  const actualRead = payloads.read.bind(payloads);
  payloads.read = async entity => { reads++; return actualRead(entity); };
  class FixtureModule {}
  Module({ controllers: [CallObservabilityPayloadsController], providers: [
    { provide: CallObservabilityPayloadsService, useValue: service },
    { provide: UserService, useValue: resolver }, { provide: JwtService, useValue: jwt },
    { provide: ConfigService, useValue: config }, ObservabilityAccessGuard, ObservabilityApiExceptionFilter,
  ] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1/monitoring/observability/invocations/';
  const now = Date.now() - 1000, sourceInstanceId = randomUUID();
  async function account(roles = [role()]) {
    const id = randomUUID();
    const user = Object.assign(new User(), { id, username: 'fixture-' + id, email: id + '@example.invalid',
      status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles });
    users.set(id, user);
    // JWT fixture accounts also exist in the real audit FK table; no password login is used.
    await userRepository.insert({ id, username: user.username, email: user.email,
      password: '$2b$fixture-not-for-login', status: UserStatus.ACTIVE, emailVerified: true });
    return user;
  }
  const user = await account();
  async function request(id, side = 'request', who = user, query = '') {
    const access = who ? jwt.sign({ sub: who.id, tokenUse: tokens.MANAGEMENT_TOKEN_USE }, {
      secret, algorithm: 'HS256', issuer: tokens.MANAGEMENT_TOKEN_ISSUER,
      audience: tokens.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m',
    }) : null;
    const response = await fetch(base + encodeURIComponent(id) + '/payloads/' + encodeURIComponent(side) + query,
      { headers: { ...(access ? { authorization: 'Bearer ' + access } : {}),
        'x-request-id': 'client-controlled-secret', 'user-agent': 'fixture-secret-agent' }, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  async function ingest(overrides = {}) {
    const row = { schemaVersion: 2, sourceInstanceId, sourceSequence: 1, eventId: randomUUID(), recordVersion: 1,
      invocationId: randomUUID(), requestId: randomUUID(), phase: 'finished', serverType: 'gateway',
      spanKind: 'gateway_request', protocolTransport: 'http', origin: 'external', runtimeAssetId: 'asset-a',
      identitySource: 'authenticated', callerId: 'caller-a', credentialId: 'private-credential',
      startedAt: new Date(now).toISOString(), completedAt: new Date(now + 10).toISOString(), outcome: 'success',
      statusCode: 200, request: captureAuditBody({ value: 'request-value', password: 'private-password' }),
      response: captureAuditBody({ result: 'response-value', token: 'private-token' }), ...overrides };
    const result = await store.ingest(row);
    assert.equal(result.status, 'inserted', JSON.stringify(result));
    return row;
  }
  const object = (id, side = 'request') => database.getRepository(entities.RuntimePayloadEntity).findOneBy({ invocationId: id, side });
  const logs = () => auditLogs.find({ order: { createdAt: 'ASC' } });
  return { app, database, directory, payloads, store, service, audit, user, users, account, request,
    ingest, object, logs, reads: () => reads };
}

test('captured JSON is redacted and mandatory audit is committed before HTTP content returns', async t => {
  const f = await fixture(t), row = await f.ingest();
  const watermark = await f.store.watermark();
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.content, { value: 'request-value', password: '[REDACTED]' });
  assert.equal(result.body.data.encoding, 'json');
  assert.equal(result.body.data.state, 'captured');
  assert.equal(result.cache, 'no-store');
  const logs = await f.logs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].userId, f.user.id);
  assert.equal(logs[0].resource, 'observability.payload');
  assert.equal(logs[0].resourceId, row.invocationId);
  assert.equal(logs[0].action, AuditAction.API_CALLED);
  assert.equal(logs[0].status, AuditStatus.SUCCESS);
  assert.equal(logs[0].details.result, 'prepared');
  assert.equal(logs[0].details.operation, 'obsGetInvocationPayload');
  assert.notEqual(logs[0].details.requestId, 'client-controlled-secret');
  assert.equal(await f.store.watermark(), watermark);
  for (const secret of ['request-value', 'private-password', 'private-token', 'private-credential',
    'fixture-secret-agent', 'client-controlled-secret', 'fileKey', 'storageOwnerId']) {
    assert.equal(JSON.stringify(logs).includes(secret), false, secret);
  }
  const retrieved = await f.audit.findLogById(logs[0].id);
  assert.equal(retrieved.user.id, f.user.id);
});

test('request and response sides cannot be confused, and neither exposes storage references', async t => {
  const f = await fixture(t), row = await f.ingest();
  const result = await f.request(row.invocationId, 'response');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.content, { result: 'response-value', token: '[REDACTED]' });
  assert.equal(result.body.data.side, 'response');
  for (const value of ['fileKey', 'storageOwnerId', 'data/runtime', 'private-token', 'request-value']) {
    assert.equal(JSON.stringify(result.body).includes(value), false, value);
  }
  assert.equal((await f.logs())[0].details.side, 'response');
});

test('captured empty is not the same as omitted or unavailable', async t => {
  const f = await fixture(t);
  const empty = await f.ingest({ request: captureAuditBody(undefined, 'text/plain') });
  const omitted = await f.ingest({ request: { state: 'omitted', reason: 'policy', contentType: 'text/plain',
    totalBytes: 12, capturedBytes: 0, sha256: auditDigest('private-data'), data: 'private-data', redacted: false } });
  const missing = await f.ingest({ request: undefined });
  const e = (await f.request(empty.invocationId)).body.data;
  assert.equal(e.state, 'captured'); assert.equal(e.content, ''); assert.equal(e.observedBytes, 0);
  const o = (await f.request(omitted.invocationId)).body.data;
  assert.equal(o.state, 'omitted'); assert.equal(o.content, null); assert.equal(o.reason, 'policy');
  assert.equal(o.observedBytes, 12); assert.equal(o.storedBytes, 0);
  const m = (await f.request(missing.invocationId)).body.data;
  assert.equal(m.state, 'unavailable'); assert.equal(m.content, null); assert.equal(m.observedBytes, null);
  assert.equal((await f.logs()).length, 3);
});

test('JSON scalar values retain their types and string values', async t => {
  const f = await fixture(t);
  for (const value of [0, false, null, 'plain string', ['value', 2], { a: 1 }]) {
    const row = await f.ingest({ request: captureAuditBody(JSON.stringify(value), 'application/json') });
    const result = await f.request(row.invocationId);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.encoding, 'json');
    assert.deepEqual(result.body.data.content, value);
  }
});

test('binary payload uses Base64 and preserves actual bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 10, 13, 34]);
  const row = await f.ingest({ request: captureAuditBody(bytes, 'application/octet-stream') });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200); assert.equal(result.body.data.encoding, 'base64');
  assert.deepEqual(Buffer.from(result.body.data.content, 'base64'), bytes);
  assert.equal(result.body.data.observedBytes, bytes.length);
  assert.equal(result.body.data.digestScope, 'observed_raw');
});

test('multipart parts stay structured and redacted without raw upload paths', async t => {
  const f = await fixture(t);
  const boundary = 'fixture-boundary';
  const raw = '--' + boundary + '\r\nContent-Disposition: form-data; name="password"\r\n\r\nprivate-password\r\n--' +
    boundary + '\r\nContent-Disposition: form-data; name="note"\r\n\r\nsafe note\r\n--' + boundary + '--\r\n';
  const row = await f.ingest({ request: captureAuditBody(raw, 'multipart/form-data; boundary=' + boundary) });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200); assert.equal(result.body.data.encoding, 'multipart');
  assert.equal(result.body.data.content.parts.length, 2);
  assert.equal(result.body.data.content.parts[0].body, '[REDACTED]');
  assert.equal(JSON.stringify(result.body).includes('private-password'), false);
});

test('incomplete body retains a partial digest/measurement rather than pretending to be complete', async t => {
  const f = await fixture(t);
  const row = await f.ingest({ request: { state: 'incomplete', reason: 'stream_interrupted',
    encoding: 'utf8', contentType: 'text/plain', totalBytes: 4, capturedBytes: 4,
    data: 'part', sha256: auditDigest('part'), redacted: false } });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200); assert.equal(result.body.data.state, 'incomplete');
  assert.equal(result.body.data.content, 'part'); assert.equal(result.body.data.digestScope, 'partial');
  assert.equal(result.body.meta.isPartial, true);
});

test('read-time redaction applies without changing capture digest semantics', async t => {
  const f = await fixture(t);
  const raw = '{"password":"private-password","value":"safe"}';
  const row = await f.ingest({ request: { state: 'complete', contentType: 'application/json', encoding: 'utf8',
    totalBytes: Buffer.byteLength(raw), capturedBytes: Buffer.byteLength(raw), data: raw,
    sha256: auditDigest(raw), redacted: false } });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.content.password, '[REDACTED]');
  assert.equal(result.body.data.readRedacted, true);
  assert.equal(result.body.data.redacted, true);
  assert.equal(result.body.data.capturedDigest, auditDigest(raw));
  assert.equal(result.body.data.digestScope, 'observed_raw');
});

test('expired body returns safe 410 metadata and a failed-read audit without opening content', async t => {
  const f = await fixture(t), start = Date.now() - 8 * 86400000;
  const row = await f.ingest({ startedAt: new Date(start).toISOString(), completedAt: new Date(start + 10).toISOString() });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 410); assert.equal(result.body.error.code, 'PAYLOAD_EXPIRED');
  assert.equal(result.body.error.details.state, 'expired');
  assert.ok(Number.isFinite(Date.parse(result.body.error.details.expiredAt)));
  assert.equal(result.cache, 'no-store'); assert.equal(f.reads(), 0);
  const logs = await f.logs();
  assert.equal(logs.length, 1); assert.equal(logs[0].status, AuditStatus.FAILED);
  assert.equal(logs[0].details.result, 'PAYLOAD_EXPIRED');
  assert.equal(logs[0].details.requestId, result.body.error.requestId);
});

test('retention expiring during file I/O still prevents content disclosure', async t => {
  const f = await fixture(t), row = await f.ingest(), read = f.payloads.read.bind(f.payloads);
  f.payloads.read = async entity => {
    const body = await read(entity);
    // Shorten only this fixture's loaded metadata, then cross that real time boundary.
    entity.expiresAt = new Date(Date.now() + 10).toISOString();
    await delay(20);
    return body;
  };
  const result = await f.request(row.invocationId);
  assert.equal(f.reads(), 1); assert.equal(result.status, 410);
  assert.equal(Object.hasOwn(result.body, 'data'), false);
  assert.equal((await f.logs())[0].status, AuditStatus.FAILED);
});

test('permission revocation during file I/O is checked before return and audited', async t => {
  const f = await fixture(t), row = await f.ingest(), read = f.payloads.read.bind(f.payloads);
  f.payloads.read = async entity => { const body = await read(entity); f.user.roles = [role([READ])]; return body; };
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'FORBIDDEN');
  assert.equal(JSON.stringify(result.body).includes('request-value'), false);
  assert.equal((await f.logs())[0].details.result, 'FORBIDDEN');
});

test('read and payload scopes are ANDed; hidden and nonexistent invocations share safe 404', async t => {
  const f = await fixture(t), hidden = await f.ingest({ runtimeAssetId: 'asset-b' });
  const reader = await f.account([role([READ])]);
  const payloadOnly = await f.account([role([PAYLOAD])]);
  const disjoint = await f.account([role([READ], ['asset-a']), role([PAYLOAD], ['asset-b'])]);
  for (const who of [reader, payloadOnly]) assert.equal((await f.request(hidden.invocationId, 'request', who)).status, 403);
  assert.equal((await f.request(hidden.invocationId, 'request', disjoint)).status, 404);
  for (const id of [hidden.invocationId, 'nonexistent']) {
    const result = await f.request(id);
    assert.equal(result.status, 404); assert.equal(result.body.error.code, 'NOT_FOUND');
  }
  assert.equal(f.reads(), 0);
  const logs = await f.logs();
  assert.equal(logs.length, 3);
  assert.ok(logs.every(log => log.resourceId == null));
  assert.equal(JSON.stringify(logs).includes(hidden.invocationId), false);
});

test('authentication and invalid side/query reject before touching payload storage', async t => {
  const f = await fixture(t), row = await f.ingest();
  assert.equal((await f.request(row.invocationId, 'request', null)).status, 401);
  for (const side of ['both', 'file', '../request']) assert.equal((await f.request(row.invocationId, side)).status, 400);
  assert.equal((await f.request(row.invocationId, 'request', f.user, '?fileKey=private')).status, 400);
  assert.equal(f.reads(), 0); assert.equal((await f.logs()).length, 0);
});

test('missing or mismatched payload references return unavailable, never another side content', async t => {
  const f = await fixture(t), row = await f.ingest();
  const response = await f.object(row.invocationId, 'response');
  await f.database.getRepository(entities.RuntimeInvocationEntity).update(
    { invocationId: row.invocationId }, { requestPayloadId: response.id });
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 200); assert.equal(result.body.data.state, 'unavailable');
  assert.equal(result.body.data.content, null); assert.equal(result.body.data.expiresAt, null);
  assert.equal(f.reads(), 0);
});

test('corrupt body objects fail closed and only safe failure metadata enters the management audit', async t => {
  const f = await fixture(t), row = await f.ingest(), object = await f.object(row.invocationId);
  const file = path.resolve(f.directory, 'data/payloads', object.fileKey);
  if (!file.startsWith(path.resolve(f.directory) + path.sep)) throw new Error('Non-owned corruption fixture');
  await fs.writeFile(file, 'corrupt-private-marker');
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(JSON.stringify(result.body).includes('private'), false);
  const logs = await f.logs();
  assert.equal(logs[0].status, AuditStatus.FAILED);
  assert.equal(logs[0].details.result, 'OBSERVABILITY_UNAVAILABLE');
  assert.equal(JSON.stringify(logs).includes(object.fileKey), false);
});

test('mandatory audit failure never returns content or advances the call watermark', async t => {
  const f = await fixture(t), row = await f.ingest(), watermark = await f.store.watermark();
  f.audit.log = async () => { throw new Error('private-driver-password'); };
  const result = await f.request(row.invocationId);
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result.body).includes('request-value'), false);
  assert.equal(JSON.stringify(result.body).includes('private-driver-password'), false);
  assert.equal((await f.logs()).length, 0);
  assert.equal(await f.store.watermark(), watermark);
});

test('service read admission is bounded and releases slots after completion', async t => {
  const f = await fixture(t), row = await f.ingest(), read = f.payloads.read.bind(f.payloads);
  let entered = 0, release, ready;
  const gate = new Promise(resolve => { release = resolve; });
  const allEntered = new Promise(resolve => { ready = resolve; });
  f.payloads.read = async entity => {
    entered++; if (entered === 4) ready();
    await gate;
    return read(entity);
  };
  const pending = Array.from({ length: 4 }, () => f.request(row.invocationId));
  try {
    await Promise.race([allEntered, delay(3000).then(() => { throw new Error('Read admission fixture timeout'); })]);
    const limited = await f.request(row.invocationId);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
  } finally { release(); }
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.status === 200));
  assert.equal((await f.request(row.invocationId)).status, 200);
  assert.equal((await f.logs()).length, 6);
});

test('audit service still supports ordinary non-transactional callers', async t => {
  const f = await fixture(t);
  const row = await f.audit.log({ action: AuditAction.API_CALLED, level: AuditLevel.INFO,
    status: AuditStatus.SUCCESS, userId: f.user.id, resource: 'fixture-api' });
  assert.ok(row.id);
  assert.equal((await f.audit.findLogById(row.id)).resource, 'fixture-api');
});

test('generated payload Swagger exposes one guarded JSON route with explicit expiry metadata', async t => {
  const f = await fixture(t);
  const document = SwaggerModule.createDocument(f.app, new DocumentBuilder().setTitle('Fixture').setVersion('1.0').addBearerAuth().build());
  const route = '/api/v1/monitoring/observability/invocations/{id}/payloads/{side}';
  assert.deepEqual(Object.keys(document.paths), [route]);
  const operation = document.paths[route].get;
  assert.equal(operation.operationId, 'obsGetInvocationPayload');
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  assert.deepEqual(operation.parameters.find(item => item.name === 'side').schema.enum, ['request', 'response']);
  for (const code of ['200', '400', '401', '403', '404', '410', '429', '503']) assert.ok(operation.responses[code]);
  const payload = document.components.schemas.ObservabilityPayloadDto;
  assert.deepEqual(payload.properties.encoding.enum, ['json', 'text', 'base64', 'multipart']);
  assert.ok(payload.properties.content.nullable);
  assert.equal(payload.properties.fileKey, undefined);
  assert.equal(document.components.schemas.ObservabilityErrorDto.properties.details.properties.state.enum[0], 'expired');
});

test('management audit list can retrieve the sensitive read evidence using the current entity schema', async t => {
  const f = await fixture(t), row = await f.ingest();
  assert.equal((await f.request(row.invocationId)).status, 200);
  const result = await f.audit.findLogs({ resource: 'observability.payload', page: 1, limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.data[0].resourceId, row.invocationId);
  assert.equal(result.data[0].details.operation, 'obsGetInvocationPayload');
  assert.equal(result.data[0].user.id, f.user.id);
  assert.equal(result.totalPages, 1);
  assert.equal(result.hasNext, false);
  assert.equal(result.hasPrev, false);
});

test('management audit date filters bind mapped timestamps and retain inclusive legacy boundaries', async t => {
  const f = await fixture(t), repository = f.database.getRepository(AuditLog);
  const records = [];
  for (const hour of [10, 11, 12]) {
    const row = await f.audit.log({ action: AuditAction.API_CALLED, level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS, userId: f.user.id, resource: 'date-fixture' });
    await repository.update({ id: row.id }, { createdAt: new Date('2026-09-09T' + hour + ':00:00.000Z') });
    records.push(row.id);
  }
  const both = await f.audit.findLogs({ startDate: '2026-09-09T11:00:00.000Z', endDate: '2026-09-09T12:00:00.000Z' });
  assert.deepEqual(both.data.map(row => row.id), [records[2], records[1]]);
  const after = await f.audit.findLogs({ startDate: '2026-09-09T11:00:00.000Z' });
  assert.deepEqual(after.data.map(row => row.id), [records[2], records[1]]);
  const before = await f.audit.findLogs({ endDate: '2026-09-09T11:00:00.000Z' });
  assert.deepEqual(before.data.map(row => row.id), [records[1], records[0]]);
  const outside = await f.audit.findLogs({ startDate: '2026-09-10T00:00:00.000Z' });
  assert.equal(outside.total, 0);
});

test('management audit search casts JSON and enum values while keeping search input parameterized', async t => {
  const f = await fixture(t), row = await f.ingest();
  assert.equal((await f.request(row.invocationId)).status, 200);
  for (const search of ['obsGetInvocationPayload', 'observability.payload', 'api_called']) {
    const result = await f.audit.findLogs({ search });
    assert.equal(result.total, 1, search);
    assert.equal(result.data[0].resourceId, row.invocationId);
  }
  assert.equal((await f.audit.findLogs({ search: "' OR 1=1 --" })).total, 0);
  assert.equal((await f.audit.findLogs({ search: 'private-password' })).total, 0);
});

test('management audit pagination uses an ID tie-breaker for identical creation timestamps', async t => {
  const f = await fixture(t), repository = f.database.getRepository(AuditLog), expected = [];
  for (let i = 0; i < 4; i++) {
    const row = await f.audit.log({ action: AuditAction.API_CALLED, level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS, userId: f.user.id, resource: 'page-fixture' });
    await repository.update({ id: row.id }, { createdAt: new Date('2026-09-09T12:00:00.000Z') });
    expected.push(row.id);
  }
  expected.sort().reverse();
  const first = await f.audit.findLogs({ page: 1, limit: 2, resource: 'page-fixture' });
  const second = await f.audit.findLogs({ page: 2, limit: 2, resource: 'page-fixture' });
  assert.deepEqual(first.data.map(row => row.id), expected.slice(0, 2));
  assert.deepEqual(second.data.map(row => row.id), expected.slice(2));
  assert.equal(first.total, 4); assert.equal(second.total, 4);
  assert.equal(first.hasNext, true); assert.equal(second.hasPrev, true); assert.equal(second.hasNext, false);
});
