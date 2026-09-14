'use strict';
const { API_GLOBAL_PREFIX } = require('../dist/src/common/http-api-paths.js');
process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const previousJwtSecret = process.env.JWT_SECRET;
const testJwtSecret = randomUUID() + randomUUID();
process.env.JWT_SECRET = testJwtSecret;
after(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});
const fs = require('node:fs/promises');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { JwtService } = require('@nestjs/jwt');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const base = '../dist/src/';
const { AppModule } = require(base + 'app.module.js');
const { CallObservabilityModule } = require(base + 'modules/call-observability/call-observability.module.js');
const { CallObservabilityWorker } = require(base + 'modules/call-observability/call-observability.worker.js');
const { CallObservabilityCollector } = require(base + 'modules/call-observability/call-observability.collector.js');
const { RuntimeMetricBucketEntity, RuntimeMetricContributionEntity } = require(base + 'database/entities/runtime-call-observability.entity.js');
const { CallObservabilityStore } = require(base + 'modules/call-observability/call-observability.store.js');
const { CallObservabilityOutboxService } = require(base + 'modules/call-observability/call-observability-outbox.service.js');
const { SecurityModule } = require(base + 'modules/security/security.module.js');
const { UserService } = require(base + 'modules/security/services/user.service.js');
const { AuditService } = require(base + 'modules/security/services/audit.service.js');
const { User, UserStatus } = require(base + 'database/entities/user.entity.js');
const { Role, RoleType } = require(base + 'database/entities/role.entity.js');
const { CALL_OBSERVABILITY_ENTITIES } = require(base + 'database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } = require(base + 'database/entities/runtime-observability-event.entity.js');
const { DATABASE_ENTITIES } = require(base + 'database/database.entities.js');
const { validationSchema } = require(base + 'config/validation.schema.js');
const tokens = require(base + 'modules/security/management-access-token.js');

test('root imports real observability module and collection remains opt-in', () => {
  assert.ok(Reflect.getMetadata('imports', AppModule).includes(CallObservabilityModule));
  const managementConfig = { JWT_SECRET: testJwtSecret };
  const result = validationSchema.validate({ ...managementConfig });
  assert.equal(result.error, undefined);
  assert.equal(result.value.API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED, 'false');
  assert.equal(result.value.API_NOVA_OBSERVABILITY_OUTBOX_ENABLED, 'false');
  assert.equal(result.value.API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED, 'false');
  assert.ok(validationSchema.validate({ ...managementConfig, API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: 'true' }).error);
  assert.ok(validationSchema.validate({ ...managementConfig, API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'short' }).error);
  assert.ok(validationSchema.validate({ ...managementConfig, API_NOVA_OBSERVABILITY_SOURCES_PER_DAY: 100001 }).error);
  assert.equal(validationSchema.validate({ ...managementConfig, API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: 'true',
    API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 's'.repeat(32) }).error, undefined);
});

test('real module resolves and serves authenticated HTTP with disabled collector', async t => {
  const testRoot = path.resolve(__dirname, '../../../tmp/observability-module-integration');
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'run-'));
  const oldAudit = process.env.API_NOVA_AUDIT_DIR, oldData = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_AUDIT_DIR = path.join(directory, 'source');
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'data');
  await fs.mkdir(process.env.API_NOVA_AUDIT_DIR);
  let app;
  t.after(async () => {
    if (app) await app.close();
    if (oldAudit === undefined) delete process.env.API_NOVA_AUDIT_DIR; else process.env.API_NOVA_AUDIT_DIR = oldAudit;
    if (oldData === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR; else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = oldData;
    if (path.dirname(path.resolve(directory)) !== testRoot) throw new Error('Unsafe integration cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const secret = testJwtSecret;
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: secret,
    API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: secret, API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: 'false',
    API_NOVA_OBSERVABILITY_OUTBOX_ENABLED: 'false', API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED: 'false' });
  const user = Object.assign(new User(), { id: randomUUID(), status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null,
    roles: [Object.assign(new Role(), { name: 'super_admin', type: RoleType.SYSTEM, enabled: true })] });
  const jwt = new JwtService();
  class FixtureSecurityModule {}
  Module({ providers: [{ provide: UserService, useValue: { findUserById: async () => user } },
    { provide: AuditService, useValue: {} }, { provide: JwtService, useValue: jwt }],
    exports: [UserService, AuditService, JwtService] })(FixtureSecurityModule);
  const fixture = await Test.createTestingModule({ imports: [
    TypeOrmModule.forRoot({ type: 'sqljs', synchronize: true, logging: false,
      entities: DATABASE_ENTITIES }), CallObservabilityModule,
  ] }).overrideModule(SecurityModule).useModule(FixtureSecurityModule)
    .overrideProvider(ConfigService).useValue(config).compile();
  app = fixture.createNestApplication({ logger: false });
  const collectOnce = app.get(CallObservabilityWorker).runOnce.bind(app.get(CallObservabilityWorker));
  let scans = 0;
  app.get(CallObservabilityWorker).runOnce = async () => { scans++; throw new Error('Disabled collector ran'); };
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  await app.listen(0, '127.0.0.1');
  assert.equal(scans, 0);
  const address = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/monitoring/observability';
  const denied = await fetch(address + '/capabilities');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  const token = jwt.sign({ sub: user.id, tokenUse: tokens.MANAGEMENT_TOKEN_USE }, {
    secret, algorithm: 'HS256', issuer: tokens.MANAGEMENT_TOKEN_ISSUER,
    audience: tokens.MANAGEMENT_TOKEN_AUDIENCE, expiresIn: '5m' });
  const response = await fetch(address + '/capabilities', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.observationHealth, 'unknown');
  assert.equal(body.data.endpoints.length, 28);
  assert.equal(Reflect.getMetadata('controllers', CallObservabilityModule).length, 14);
  const swagger = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
  for (const endpoint of body.data.endpoints) {
    assert.equal(swagger.paths[endpoint.path][endpoint.method.toLowerCase()].operationId, endpoint.operationId);
  }
  const events = await fetch(address + '/events', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(events.status, 200);
  const health = await fetch(address + '/pipeline/status', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).data.ingest.freshnessStatus, 'unknown');
  await app.get(CallObservabilityCollector).initialize();
  const invocationId = randomUUID(), sourceInstanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const record = { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId,
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(),
    traceId: invocationId, rootInvocationId: invocationId, spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external',
    runtimeAssetId: '00000000-0000-4000-8000-000000000001', identitySource: 'authenticated',
    authState: 'authenticated', callerId: 'integration-caller', credentialId: 'integration-key',
    peerIp: '127.0.0.1', clientIp: '127.0.0.1', ipSource: 'peer',
    startedAt, completedAt: startedAt, durationMs: 0, outcome: 'success', cacheHit: true };
  await fs.writeFile(path.join(directory, 'source', 'calls-v2-' + sourceInstanceId + '.jsonl'), JSON.stringify(record) + '\n');
  const collected = await collectOnce();
  assert.equal(collected.processedRecords, 1);
  const database = app.get(DataSource);
  assert.equal(await database.getRepository(RuntimeMetricContributionEntity).count(), 1);
  assert.ok(await database.getRepository(RuntimeMetricBucketEntity).count() > 0);
  const history = await fetch(address + '/events', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(history.status, 200);
  const eventBody = await history.json();
  assert.ok(eventBody.data.items.some(item => item.subject.id === invocationId));
  const statistics = await fetch(address + '/statistics/summary?scope=business', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(statistics.status, 200);
  const stats = await statistics.json();
  assert.equal(stats.data.metrics.cacheHits, 1);
  assert.equal(stats.data.metrics.cacheMisses, 0);
  const store = app.get(CallObservabilityStore);
  const recompute = await store.recomputePendingBuckets();
  assert.equal(recompute.failed, 0);
  assert.ok(collected.recomputedBuckets + recompute.recomputed > 0);
  const storedBucket = await database.getRepository(RuntimeMetricBucketEntity).findOneBy({ scope: 'business' });
  assert.ok(storedBucket);
  assert.equal(storedBucket.metrics.recompute, undefined);
  assert.equal(storedBucket.metrics.metrics.cacheHits, 1);
  assert.equal(storedBucket.metrics.coverage.isPartial, true);
  assert.deepEqual(await store.recomputePendingBuckets(), { recomputed: 0, failed: 0 });
  const pendingEvents = await database.getRepository(RuntimeObservabilityEventEntity).countBy({ dispatchState: 'pending' });
  assert.ok(pendingEvents > 0);
  const dispatched = await app.get(CallObservabilityOutboxService).runOnce(256);
  assert.equal(dispatched.claimed, pendingEvents);
  assert.equal(dispatched.materializedEvents, pendingEvents);
  assert.equal(dispatched.deliveriesCreated, 0);
  assert.equal((await app.get(CallObservabilityOutboxService).runOnce(256)).claimed, 0);
  const overview = await fetch(address + '/overview', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(overview.status, 200);
  const view = (await overview.json()).data;
  assert.equal(view.invocationSnapshotAuthorized, true);
  assert.equal(view.invocationSnapshotScope, 'invocation_facts_only');
  const after = await fetch(address + '/events?origin=external&afterSequence=' + view.invocationSnapshotSeq,
    { headers: { authorization: 'Bearer ' + token } });
  assert.equal(after.status, 200);
  const wrongOrigin = await fetch(address + '/events?origin=internal&afterSequence=' + view.invocationSnapshotSeq,
    { headers: { authorization: 'Bearer ' + token } });
  assert.equal(wrongOrigin.status, 400);
  assert.equal(scans, 0);
});
