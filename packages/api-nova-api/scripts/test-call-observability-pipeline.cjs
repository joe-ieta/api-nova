'use strict';
// Source-only tests: never build or write the shared dist directory.
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  require('node:fs').readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
  }, fileName: filename }).outputText, filename);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const base = '../src/modules/call-observability/';
const { RuntimePipelineStateEntity, RuntimeMetricBucketEntity, CALL_OBSERVABILITY_ENTITIES } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore } = require(base + 'call-observability.store.ts');
const { CallObservabilityPipelineService } = require(base + 'call-observability-pipeline.service.ts');
const { CallObservabilityPipelineController } = require(base + 'call-observability-pipeline.controller.ts');
const { authorizeObservability } = require(base + 'call-observability-access.ts');
const { OBSERVABILITY_AUTHORIZATION } = require(base + 'call-observability-access.guard.ts');
const { COLLECTOR_WORKER_ID, CallObservabilityWorker } = require(base + 'call-observability.worker.ts');
const { ConfigService } = require('@nestjs/config');
const globalScope = { principalId: 'reader', runtimeAssetIds: null, requiredPermissions: ['monitoring:read'], fingerprint: 'test' };
const code = expected => error => error.code === expected;
async function fixture(t) {
  const database = await new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
  t.after(() => database.destroy());
  const store = new CallObservabilityStore(database, {});
  const repository = database.getRepository(RuntimePipelineStateEntity);
  const service = new CallObservabilityPipelineService(store);
  const save = (value, age = 0) => repository.save({ id: COLLECTOR_WORKER_ID,
    updatedAt: new Date(Date.now() - age).toISOString(), value });
  return { database, store, repository, service, save };
}
const report = overrides => ({ state: 'running', snapshotSeq: '0', scanComplete: true,
  lastSuccessfulScanAt: new Date(Date.now() - 1000).toISOString(),
  scan: { startedAt: new Date(Date.now() - 2000).toISOString(), backlogFiles: 0,
    partialBytes: 0, quarantinedRecords: 0, errors: {} }, ...overrides });

test('absent evidence is unknown; reads create no pipeline rows', async t => {
  const f = await fixture(t);
  const result = await f.service.get({}, globalScope);
  assert.equal(result.data.ingest.state, 'unknown');
  assert.equal(result.data.ingest.dataWatermark, null);
  assert.equal(result.data.ingest.quarantinedRecords, null);
  assert.equal(result.data.ingest.freshnessStatus, 'unknown');
  for (const stage of ['ingest', 'aggregation', 'dispatch']) {
    for (const field of ['lagMs', 'pendingCount', 'failedRecords', 'droppedRecords', 'unknownLoss', 'diskUsage', 'effectiveQuota', 'gapRanges']) {
      assert.equal(result.data[stage][field], stage === 'aggregation' && field === 'pendingCount' ? 0 : null);
    }
  }
  assert.equal(result.data.aggregation.state, 'unknown');
  assert.equal(result.data.dispatch.state, 'unknown');
  assert.equal(await f.repository.count(), 0);
});
test('global read suffices; asset local, empty and missing read scopes fail before storage', async () => {
  let reads = 0;
  const service = new CallObservabilityPipelineService({ readSnapshot: () => { reads++; throw new Error('storage reached'); } });
  for (const scope of [{ ...globalScope, runtimeAssetIds: ['asset-a'] },
    { ...globalScope, runtimeAssetIds: [] }, { ...globalScope, requiredPermissions: ['monitoring:manage'] }]) {
    await assert.rejects(service.get({}, scope), code('FORBIDDEN'));
  }
  await assert.rejects(service.get({}, undefined), code('UNAUTHENTICATED'));
  assert.equal(reads, 0);
  const user = { id: 'reader', isActive: true, isLocked: false, roles: [{ enabled: true,
    name: 'reader', type: 'custom', metadata: { observabilityScope: { mode: 'all' } },
    permissions: [{ name: 'monitoring:read', enabled: true }] }] };
  assert.equal(authorizeObservability(user).runtimeAssetIds, null);
  await assert.rejects(service.get({}, authorizeObservability(user)), /storage reached/);
});
test('recent and stale scans retain evidence without manufacturing health or data lag', async t => {
  const f = await fixture(t);
  await f.save(report());
  let result = await f.service.get({}, globalScope);
  assert.equal(result.data.ingest.freshnessStatus, 'recent');
  assert.equal(result.data.ingest.backlogFiles, 0);
  assert.equal(result.data.ingest.pendingCount, null);
  assert.equal(result.data.ingest.scanErrorCount, 0);
  await f.save(report({ lastSuccessfulScanAt: new Date(Date.now() - 120000).toISOString() }), 60000);
  result = await f.service.get({}, globalScope);
  assert.equal(result.data.ingest.freshnessStatus, 'stale');
  assert.equal(result.data.ingest.state, 'running');
  assert.ok(result.data.ingest.observationAgeMs >= 60000);
  assert.equal(result.data.ingest.lagMs, null);
});
test('partial degraded scan exposes scoped counts without internal error strings or paths', async t => {
  const f = await fixture(t);
  await f.save(report({ state: 'degraded', scanComplete: false, secret: 'private',
    scan: { backlogFiles: 3, partialBytes: 42, quarantinedRecords: 2,
      errors: { 'E:/private/source.jsonl': 4 }, fileName: 'private' } }));
  const result = await f.service.get({}, globalScope);
  assert.equal(result.data.ingest.backlogScope, 'partial_directory_scan');
  assert.equal(result.data.ingest.backlogFiles, 3);
  assert.equal(result.data.ingest.scanErrorCount, 4);
  assert.equal(result.data.ingest.quarantinedRecords, 2);
  assert.equal(result.data.ingest.quarantinedRecordsScope, 'current_scan');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('malformed counters, watermark and future timestamps remain unknown; reject query parameters', async t => {
  const f = await fixture(t);
  await f.save(report({ snapshotSeq: '99999999999999999999', lastSuccessfulScanAt: 'invalid',
    scan: { backlogFiles: -1, partialBytes: '0', quarantinedRecords: 1.5, errors: { bad: -1 } } }), -60000);
  const { data } = await f.service.get({}, globalScope);
  assert.equal(data.ingest.freshnessStatus, 'unknown');
  for (const field of ['dataWatermark', 'backlogFiles', 'partialBytes', 'quarantinedRecords', 'scanErrorCount', 'lastSuccessfulScanAt']) {
    assert.equal(data.ingest[field], null);
  }
  for (const query of [{ runtimeAssetId: 'a' }, { unexpected: 'x' }, [], null]) {
    await assert.rejects(f.service.get(query, globalScope), code('INVALID_QUERY'));
  }
});
test('real worker missing-source persistence survives service recreation without mutating evidence', async t => {
  const f = await fixture(t);
  const collector = { initialize: async () => ({}), sourceDirectory: require('node:path').join(
    __dirname, 'missing-pipeline-source-' + require('node:crypto').randomUUID()) };
  const worker = new CallObservabilityWorker(collector, {}, f.store, new ConfigService());
  t.after(() => worker.onModuleDestroy());
  await worker.runOnce();
  const before = await f.repository.find();
  const controller = new CallObservabilityPipelineController(new CallObservabilityPipelineService(f.store));
  const result = await controller.get({}, { [OBSERVABILITY_AUTHORIZATION]: globalScope });
  assert.equal(result.data.ingest.state, 'waiting_for_source');
  assert.equal(result.data.ingest.lastSuccessfulScanAt, null);
  assert.equal(result.data.ingest.scanComplete, false);
  assert.deepEqual(await f.repository.find(), before);
  await assert.rejects(controller.get({}, {}), code('UNAUTHENTICATED'));
});

// Actual loopback HTTP with the production controller, guard, service and exception filter.
// Only the user repository boundary is substituted; JWT verification is real.
test('HTTP pipeline authorization, cache policy and Swagger use the real Nest route', async t => {
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { JwtService } = require('@nestjs/jwt');
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const { UserService } = require('../src/modules/security/services/user.service.ts');
  const { ObservabilityAccessGuard } = require(base + 'call-observability-access.guard.ts');
  const tokenContract = require('../src/modules/security/management-access-token.ts');
  const f = await fixture(t);
  await f.save(report({ scan: { backlogFiles: 7, partialBytes: 13, quarantinedRecords: 2, errors: { SOURCE_FILE_MISSING: 1 } } }));
  const secret = 'pipeline-http-test-secret-'.repeat(3);
  const jwt = new JwtService();
  const makeUser = (id, scope, permissions = ['monitoring:read']) => ({ id, isActive: true, isLocked: false,
    roles: [{ name: 'reader', type: 'custom', enabled: true,
      metadata: { observabilityScope: scope }, permissions: permissions.map(name => ({ name, enabled: true })) }] });
  const users = new Map([
    ['global', makeUser('global', { mode: 'all' })],
    ['scoped', makeUser('scoped', { mode: 'assets', runtimeAssetIds: ['asset-a'] })],
    ['manage-only', makeUser('manage-only', { mode: 'all' }, ['monitoring:manage'])],
  ]);
  let reads = 0;
  const readSnapshot = f.store.readSnapshot.bind(f.store);
  f.store.readSnapshot = (...args) => { reads++; return readSnapshot(...args); };
  class PipelineHttpFixtureModule {}
  Module({ controllers: [CallObservabilityPipelineController], providers: [
    CallObservabilityPipelineService, ObservabilityAccessGuard,
    { provide: CallObservabilityStore, useValue: f.store },
    { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
    { provide: JwtService, useValue: jwt },
    { provide: UserService, useValue: { findUserById: async id => users.get(id) } },
  ] })(PipelineHttpFixtureModule);
  const app = await NestFactory.create(PipelineHttpFixtureModule, { logger: false, abortOnError: false });
  try {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Pipeline test')
      .setVersion('1.0').addBearerAuth().build());
    SwaggerModule.setup('swagger', app, document);
    await app.listen(0, '127.0.0.1');
    const root = await app.getUrl();
    const token = (subject, extra = {}, options = {}) => jwt.sign({
      sub: subject, tokenUse: tokenContract.MANAGEMENT_TOKEN_USE, ...extra,
    }, { secret, algorithm: 'HS256', audience: tokenContract.MANAGEMENT_TOKEN_AUDIENCE,
      issuer: tokenContract.MANAGEMENT_TOKEN_ISSUER, expiresIn: '5m', ...options });
    const request = async (bearer, suffix = '') => {
      const response = await fetch(root + '/monitoring/observability/pipeline/status' + suffix,
        { headers: bearer ? { Authorization: 'Bearer ' + bearer } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() };
    };
    const globalToken = token('global');
    const success = await request(globalToken);
    assert.equal(success.status, 200);
    assert.equal(success.body.status, 'success');
    assert.equal(success.body.data.resourceScope, 'global');
    assert.equal(success.body.data.ingest.backlogFiles, 7);
    assert.equal(success.body.data.ingest.pendingCount, null);
    assert.equal(success.body.data.aggregation.state, 'unknown');
    assert.equal(success.body.data.dispatch.state, 'unknown');
    assert.equal(success.body.data.aggregation.pendingCount, 0);
    assert.equal(success.body.data.aggregation.evidenceSource, 'unexpired_bucket_queue_snapshot');
    assert.equal(success.body.data.dispatch.pendingCount, null);
    assert.equal(success.body.data.dispatch.evidenceSource, 'events_dispatch_checkpoint');
    assert.equal(reads, 1);
    for (const [bearer, expectedStatus, expectedCode] of [
      [token('scoped', { permissions: ['monitoring:read', 'monitoring:manage'], runtimeAssetIds: null }), 403, 'FORBIDDEN'],
      [token('manage-only'), 403, 'FORBIDDEN'],
      [null, 401, 'UNAUTHENTICATED'],
      [token('global', { tokenUse: 'runtime_access' }), 401, 'UNAUTHENTICATED'],
      [token('global', {}, { audience: 'wrong-audience' }), 401, 'UNAUTHENTICATED'],
      [token('global', {}, { expiresIn: -1 }), 401, 'UNAUTHENTICATED'],
    ]) {
      const rejected = await request(bearer);
      assert.equal(rejected.status, expectedStatus);
      assert.equal(rejected.body.error.code, expectedCode);
      assert.equal(rejected.body.status, 'error');
      assert.equal(typeof rejected.body.error.requestId, 'string');
      assert.equal(rejected.body.data, undefined);
      assert.equal(rejected.body.meta, undefined);
      assert.equal(JSON.stringify(rejected.body).includes('backlogFiles'), false);
    }
    assert.equal(reads, 1, 'rejected HTTP callers must not read global pipeline evidence');
    const invalid = await request(globalToken, '?runtimeAssetId=asset-a');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_QUERY');
    assert.equal(reads, 1);
    // Same signed JWT, changed server-side grant: scope is reloaded on every request.
    users.set('global', makeUser('global', { mode: 'assets', runtimeAssetIds: ['asset-a'] }));
    assert.equal((await request(globalToken)).status, 403);
    assert.equal(reads, 1);
    const swaggerResponse = await fetch(root + '/swagger-json', { signal: AbortSignal.timeout(5000) });
    assert.equal(swaggerResponse.status, 200);
    const swagger = await swaggerResponse.json();
    const operation = swagger.paths['/monitoring/observability/pipeline/status'].get;
    assert.equal(operation.operationId, 'obsGetPipelineStatus');
    assert.deepEqual(operation.security, [{ bearer: [] }]);
    assert.deepEqual(operation.parameters || [], []);
    for (const status of ['200', '400', '401', '403', '503']) assert.ok(operation.responses[status]);
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref,
      '#/components/schemas/ObservabilityPipelineStatusEnvelopeDto');
    const schemas = swagger.components.schemas;
    assert.equal(schemas.ObservabilityPipelineStatusDto.properties.ingest.$ref,
      '#/components/schemas/ObservabilityPipelineIngestDto');
    assert.equal(schemas.ObservabilityPipelineIngestDto.properties.pendingCount.nullable, true);
    assert.equal(schemas.ObservabilityPipelineDispatchDto.properties.lagMs.nullable, true);
  } finally {
    await app.close();
  }
});


test('aggregation counts durable queue transitions, excludes expired buckets and never claims coverage', async t => {
  const f = await fixture(t);
  const { CallObservabilityBucketRecomputeQueue } = require(base + 'call-observability-bucket-recompute.queue.ts');
  const queue = new CallObservabilityBucketRecomputeQueue();
  const future = new Date(Date.now() + 600000).toISOString();
  const key = { bucketId: 'pipeline-test-bucket', scope: 'external',
    bucketStart: '2026-01-01T00:00:00.000Z', bucketEnd: '2026-01-01T00:01:00.000Z' };
  await f.store.transaction(tx => queue.invalidate(tx, key, '00000000000000000001', future));
  let view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.state, 'backlog');
  assert.equal(view.pendingCount, 1);
  assert.equal(view.pendingBuckets, 1);
  assert.equal(view.leasedBuckets, 0);
  assert.equal(view.oldestPendingAt, null, 'bucketStart is not enqueue time');
  const [claim] = await f.store.transaction(tx => queue.claim(tx));
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.state, 'backlog', 'a lease is not proof of a running worker');
  assert.equal(view.pendingBuckets, 0);
  assert.equal(view.leasedBuckets, 1);
  assert.equal(view.pendingCount, 1);
  await f.store.transaction(tx => queue.fail(tx, claim, 0));
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.retryBuckets, 1);
  assert.equal(view.failedRecords, null);
  const [retry] = await f.store.transaction(tx => queue.claim(tx));
  await f.store.transaction(tx => queue.complete(tx, retry, { computationComplete: true }));
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.pendingCount, 0);
  assert.equal(view.state, 'unknown');
  assert.equal(view.dataWatermark, null, 'completed bucket watermark is not global coverage');
  const repository = f.database.getRepository(RuntimeMetricBucketEntity);
  const completed = await repository.findOneByOrFail({ id: key.bucketId });
  await repository.save([
    { ...completed, id: 'expired-work', recomputeState: 'pending', expiresAt: '2000-01-01T00:00:00.000Z' },
    { ...completed, id: 'expired-lease', recomputeState: 'leased', leaseUntil: '2000-01-01T00:00:00.000Z', leaseToken: 'secret-token' },
  ]);
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.pendingCount, 1);
  assert.equal(view.expiredLeaseBuckets, 1);
  assert.equal(view.pendingBuckets, 0);
  assert.equal(view.evidenceSource, 'unexpired_bucket_queue_snapshot');
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
});

test('dispatch checkpoint counts actual retained scan rows; real dispatcher progress is not delivery health', async t => {
  const f = await fixture(t);
  const { EVENTS_DISPATCH_CHECKPOINT, CallObservabilityEventsDispatcher } = require(base + 'call-observability-events.dispatcher.ts');
  await f.store.transaction(async tx => {
    for (const dispatchState of ['pending', 'suppressed', 'pending']) {
      await tx.manager.getRepository(RuntimeObservabilityEventEntity).save({
        eventFamily: 'runtime.request', eventName: 'invocation.completed', occurredAt: new Date(tx.now),
        sequence: tx.nextSequence(), dispatchState, expiresAt: dispatchState === 'suppressed'
          ? new Date('2000-01-01T00:00:00.000Z') : null,
      });
    }
  });
  let view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.pendingCount, null, 'absent checkpoint is not an observed zero checkpoint');
  assert.equal(view.state, 'unknown');
  await f.repository.save({ id: EVENTS_DISPATCH_CHECKPOINT, value: { sequence: '00000000000000000000', secretRef: 'private-secret' },
    updatedAt: new Date(Date.now() - 60000).toISOString() });
  view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.dataWatermark, '0');
  assert.equal(view.pendingCount, 3, 'suppressed and expired records still need scanning');
  assert.equal(view.state, 'backlog');
  assert.equal(view.freshnessStatus, 'stale');
  assert.ok(view.observationAgeMs >= 60000);
  assert.equal(view.lagMs, null);
  assert.equal(JSON.stringify(view).includes('private-secret'), false);
  const dispatcher = new CallObservabilityEventsDispatcher(f.store);
  await dispatcher.dispatchBatch(1);
  view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.dataWatermark, '1');
  assert.equal(view.pendingCount, 2);
  assert.equal(view.freshnessStatus, 'recent');
  await dispatcher.dispatchBatch();
  view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.dataWatermark, '3');
  assert.equal(view.pendingCount, 0);
  assert.equal(view.state, 'unknown', 'caught-up scan does not prove live scheduler or delivery success');
  assert.equal(view.dataWatermarkScope, 'event_scan_checkpoint_not_delivery_acknowledgement');
  assert.equal(view.failedRecords, null);
});

test('invalid or ahead dispatch checkpoints cannot fabricate progress or freshness', async t => {
  const f = await fixture(t);
  const { EVENTS_DISPATCH_CHECKPOINT } = require(base + 'call-observability-events.dispatcher.ts');
  for (const sequence of ['1', '-1', 'malformed', 0, '18446744073709551616']) {
    await f.repository.save({ id: EVENTS_DISPATCH_CHECKPOINT, value: { sequence }, updatedAt: new Date().toISOString() });
    const view = (await f.service.get({}, globalScope)).data.dispatch;
    assert.equal(view.dataWatermark, null);
    assert.equal(view.pendingCount, null);
    assert.equal(view.observationAgeMs, null);
    assert.equal(view.state, 'unknown');
  }
  await f.repository.save({ id: EVENTS_DISPATCH_CHECKPOINT, value: { sequence: '0' },
    updatedAt: new Date(Date.now() + 60000).toISOString() });
  const view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.pendingCount, 0);
  assert.equal(view.observationAgeMs, null);
  assert.equal(view.freshnessStatus, 'unknown');
});

