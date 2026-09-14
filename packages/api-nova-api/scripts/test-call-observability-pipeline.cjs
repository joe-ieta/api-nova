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
      assert.equal(result.data[stage][field], ['aggregation', 'dispatch'].includes(stage) && field === 'pendingCount' ? 0 : null);
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
    assert.equal(success.body.data.aggregation.evidenceSource, 'store_metrics_recompute_markers');
    assert.equal(success.body.data.dispatch.pendingCount, 0);
    assert.equal(success.body.data.dispatch.evidenceSource, 'outbox_materializer_state_and_pending_events');
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



test('remote metric and caller JSON pending markers match Store selection including expired rows', async t => {
  const f = await fixture(t);
  const { RuntimeCallerBucketEntity } = require('../src/database/entities/runtime-call-observability.entity.ts');
  const future = new Date(Date.now() + 600000).toISOString();
  const metric = f.database.getRepository(RuntimeMetricBucketEntity);
  const callers = f.database.getRepository(RuntimeCallerBucketEntity);
  await metric.save([
    { id: 'pending-metric', scope: 'business', bucketStart: '2026-09-14T00:00:00.000Z',
      bucketEnd: '2026-09-14T00:01:00.000Z', dimensions: {}, metrics: { recompute: { state: 'pending' } },
      version: 0, dataWatermark: '0', expiresAt: future },
    { id: 'expired-pending-metric', scope: 'business', bucketStart: '2026-09-14T00:00:00.000Z',
      bucketEnd: '2026-09-14T00:01:00.000Z', dimensions: {}, metrics: { recompute: { state: 'pending' } },
      version: 0, dataWatermark: '0', expiresAt: '2000-01-01T00:00:00.000Z' },
    { id: 'finished-metric', scope: 'business', bucketStart: '2026-09-14T00:00:00.000Z',
      bucketEnd: '2026-09-14T00:01:00.000Z', dimensions: {}, metrics: { metrics: {} },
      version: 1, dataWatermark: '0', expiresAt: future },
  ]);
  await callers.save({ id: 'pending-caller', callerId: 'private-caller', runtimeAssetId: 'private-asset',
    bucketStart: '2026-09-14T00:00:00.000Z', metrics: { recompute: { state: 'pending' } }, version: 0, expiresAt: future });
  let view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.pendingCount, 3); assert.equal(view.pendingBuckets, 2); assert.equal(view.pendingCallerBuckets, 1);
  assert.equal(view.evidenceSource, 'store_metrics_recompute_markers');
  assert.equal(view.pendingCountScope, 'all_persisted_metric_and_caller_pending_markers_including_expired');
  assert.equal(view.state, 'backlog'); assert.equal(view.dataWatermark, null);
  assert.equal('leasedBuckets' in view, false); assert.equal('retryBuckets' in view, false);
  const recomputed = await f.store.recomputePendingBuckets();
  assert.equal(recomputed.failed, 3, 'real Store selects these markers; malformed projection data remains pending');
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.pendingCount, 3); assert.equal(view.failedRecords, null);
  assert.equal(JSON.stringify(view).includes('private'), false);
  await f.save(report({ recomputedBuckets: 4, recomputeFailures: 3 }));
  view = (await f.service.get({}, globalScope)).data.aggregation;
  assert.equal(view.lastRunRecomputedBuckets, 4); assert.equal(view.lastRunRecomputeFailures, 3);
});
test('real outbox materializer state and dispatch-eligible rows replace scan checkpoint assumptions', async t => {
  const f = await fixture(t);
  const { CallObservabilityOutboxService, OUTBOX_WORKER_STATE_ID } = require(base + 'call-observability-outbox.service.ts');
  await f.store.transaction(async tx => {
    const specs = [
      { dispatchState: 'pending' }, { dispatchState: 'leased', dispatchLeaseUntil: new Date(Date.now() - 10000) },
      { dispatchState: 'suppressed' }, { dispatchState: 'materialized' },
      { dispatchState: 'pending', expiresAt: new Date('2000-01-01T00:00:00Z') },
      { dispatchState: 'pending', expiresAt: null }, { dispatchState: 'pending', schemaVersion: 'legacy' },
    ];
    for (const spec of specs) {
      await tx.manager.getRepository(RuntimeObservabilityEventEntity).save({
        id: require('node:crypto').randomUUID(), schemaVersion: '1.0', sequence: tx.nextSequence(),
        eventName: 'invocation.completed', eventFamily: 'runtime.request', severity: 'info', status: 'success',
        actorType: 'runtime', retentionClass: 'standard', runtimeAssetId: 'a', occurredAt: new Date(tx.now),
        expiresAt: new Date(Date.now() + 600000), ...spec,
      });
    }
  });
  let view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.pendingCount, 2);
  assert.equal(view.dataWatermark, null, 'absent outbox run is not a fabricated zero watermark');
  assert.equal(view.state, 'backlog');
  const worker = new CallObservabilityOutboxService(f.store, new ConfigService());
  t.after(() => worker.onModuleDestroy());
  await worker.runOnce();
  const state = await f.repository.findOneByOrFail({ id: OUTBOX_WORKER_STATE_ID });
  view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.pendingCount, 0); assert.equal(view.state, 'unknown');
  assert.equal(view.dataWatermark, state.value.watermark);
  assert.equal(view.dataWatermarkScope, 'outbox_materialization_not_webhook_acknowledgement');
  assert.equal(view.freshnessStatus, 'recent');
  assert.equal(view.webhook.state, 'unknown');
  assert.equal(view.webhook.succeeded, null);
});
test('real empty webhook worker run reports last-run evidence, not delivery acknowledgements or current health', async t => {
  const f = await fixture(t);
  const { CallObservabilityDeliveryWorker, WEBHOOK_WORKER_ID } = require(base + 'call-observability-delivery.worker.ts');
  const worker = new CallObservabilityDeliveryWorker(f.store, new ConfigService(), {});
  t.after(() => worker.onModuleDestroy());
  const actual = await worker.runOnce();
  const persisted = await f.repository.findOneByOrFail({ id: WEBHOOK_WORKER_ID });
  const before = await f.repository.find();
  let view = (await f.service.get({}, globalScope)).data.dispatch.webhook;
  assert.equal(view.state, actual.state); assert.equal(view.claimed, 0);
  assert.equal(view.succeeded, 0); assert.equal(view.snapshotSeq, actual.snapshotSeq);
  assert.equal(view.lastAttemptAt, persisted.value.lastAttemptAt);
  assert.equal(view.workerConfigured, true); assert.equal(view.freshnessStatus, 'recent');
  assert.deepEqual(await f.repository.find(), before);
  await f.repository.save({ ...persisted, updatedAt: new Date(Date.now() - 60000).toISOString(),
    value: { ...persisted.value, claimed: -1, succeeded: '0', lastAttemptAt: 'bad', snapshotSeq: '999999', secretRef: 'private-secret' } });
  view = (await f.service.get({}, globalScope)).data.dispatch.webhook;
  assert.equal(view.freshnessStatus, 'stale'); assert.equal(view.claimed, null); assert.equal(view.succeeded, null);
  assert.equal(view.lastAttemptAt, null); assert.equal(view.snapshotSeq, null);
  assert.equal(JSON.stringify(view).includes('private-secret'), false);
});
test('malformed or ahead outbox watermarks do not hide actual pending counts or fabricate progress', async t => {
  const f = await fixture(t);
  const { OUTBOX_WORKER_STATE_ID } = require(base + 'call-observability-outbox.service.ts');
  for (const watermark of ['1', '-1', 'malformed', 0, '18446744073709551616']) {
    await f.repository.save({ id: OUTBOX_WORKER_STATE_ID, value: { watermark }, updatedAt: new Date().toISOString() });
    const view = (await f.service.get({}, globalScope)).data.dispatch;
    assert.equal(view.dataWatermark, null); assert.equal(view.pendingCount, 0);
    assert.equal(view.state, 'unknown'); assert.equal(view.lagMs, null);
  }
  await f.repository.save({ id: OUTBOX_WORKER_STATE_ID, value: { watermark: '0' },
    updatedAt: new Date(Date.now() + 60000).toISOString() });
  const view = (await f.service.get({}, globalScope)).data.dispatch;
  assert.equal(view.pendingCount, 0); assert.equal(view.observationAgeMs, null); assert.equal(view.freshnessStatus, 'unknown');
});
test('retention report is absent rather than fabricated disabled and does not initialize storage', async t => {
  const f = await fixture(t), before = await f.repository.count();
  const view = (await f.service.get({}, globalScope)).data.retention;
  assert.equal(view.state, 'unknown'); assert.equal(view.workerConfigured, null);
  assert.equal(view.observedAt, null); assert.equal(view.lastReport, null);
  assert.equal(view.freshnessStatus, 'unknown'); assert.equal(view.cleanupScope, 'payload_objects_only');
  assert.equal(await f.repository.count(), before);
});

test('retention evidence uses bounded schedule freshness and whitelists counters without paths', async t => {
  const f = await fixture(t);
  const { RETENTION_WORKER_ID, RETENTION_ERROR_CODES } = require(base + 'call-observability-retention.worker.ts');
  const observedAt = new Date(Date.now() - 180000).toISOString();
  await f.repository.save({ id: RETENTION_WORKER_ID, updatedAt: observedAt, value: {
    state: 'degraded', workerConfigured: true, intervalMs: 60000, stateVersion: 3,
    lastAttemptAt: observedAt, lastFailureAt: observedAt, errorCode: RETENTION_ERROR_CODES[0],
    secret: 'do-not-expose', nextRunAt: 'do-not-expose',
    lastReport: { status: 'completed', scanned: 8, deleted: 2, missing: 1, changed: 0,
      protected: 5, danglingReferences: 0, hasMore: true, path: 'do-not-expose' },
  } });
  const view = (await f.service.get({}, globalScope)).data.retention;
  assert.equal(view.freshnessStatus, 'stale'); assert.equal(view.staleAfterMs, 120000);
  assert.equal(view.lastReport.deleted, 2); assert.equal(view.stateVersion, 3);
  assert.equal(view.lastFailureAt, observedAt);
  assert.equal(JSON.stringify(view).includes('do-not-expose'), false);
  assert.equal(view.errorCode, RETENTION_ERROR_CODES[0]);
});

test('malformed retention diagnostics never become trusted times, counters or free-text errors', async t => {
  const f = await fixture(t);
  const { RETENTION_WORKER_ID } = require(base + 'call-observability-retention.worker.ts');
  const future = new Date(Date.now() + 600000).toISOString();
  await f.repository.save({ id: RETENTION_WORKER_ID, updatedAt: future, value: {
    state: 'do-not-expose', workerConfigured: 'true', intervalMs: 1, stateVersion: -1,
    lastAttemptAt: future, errorCode: 'do-not-expose', lastReport: { deleted: -1, scanned: '9', hasMore: 'true' },
  } });
  const view = (await f.service.get({}, globalScope)).data.retention;
  assert.equal(view.state, 'unknown'); assert.equal(view.workerConfigured, null);
  assert.equal(view.observedAt, null); assert.equal(view.lastAttemptAt, null);
  assert.equal(view.lastReport.deleted, null); assert.equal(view.lastReport.scanned, null);
  assert.equal(view.errorCode, null); assert.equal(view.intervalMs, null);
});

test('pipeline exposes the committed management heartbeat without claiming collector or business liveness', async t => {
  const f = await fixture(t);
  const { CallObservabilityHeartbeatWorker } = require(base + 'call-observability-heartbeat.worker.ts');
  const worker = new CallObservabilityHeartbeatWorker(f.store,
    new ConfigService({ API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED: 'true' }));
  t.after(() => worker.onModuleDestroy());
  assert.equal((await f.service.get({}, globalScope)).data.managementHeartbeat.reportedState, 'unknown');
  await worker.runOnce();
  const result = await f.service.get({}, globalScope);
  assert.equal(result.data.managementHeartbeat.reportedState, 'reporting');
  assert.equal(result.data.managementHeartbeat.evidenceScope, 'management_process_store_roundtrip');
  assert.equal(result.data.managementHeartbeat.businessServerLivenessEvaluated, false);
  assert.equal(result.data.managementHeartbeat.freshnessStatus, 'recent');
  assert.ok(BigInt(result.data.managementHeartbeat.dataWatermark) <= BigInt(result.meta.snapshotSeq));
  assert.equal(result.data.ingest.state, 'unknown');
  assert.equal(result.data.ingest.freshnessStatus, 'unknown');
  assert.equal(JSON.stringify(result.data.managementHeartbeat).includes('leaseUntil'), false);
  await worker.onModuleDestroy();
  assert.equal((await f.service.get({}, globalScope)).data.managementHeartbeat.reportedState, 'stopped');
});

test('pipeline capacity is a prior scan sample, not current disk usage or freshened by worker stop', async t => {
  const f = await fixture(t);
  const { RETENTION_WORKER_ID } = require(base + 'call-observability-retention.worker.ts');
  const measured = new Date(Date.now() - 180000).toISOString();
  const value = { state: 'stopped', intervalMs: 60000, currentAttemptComplete: true, lastReportAt: measured,
    lastReport: { status: 'completed', scanUsage: { measurement: 'logical_file_length_before_cleanup',
      scanCoverage: 'partial', scanStartedAt: measured, scanCompletedAt: measured,
      observedBytes: 42, observedFiles: 2, scannedEntries: 3, traversedShards: 1, missingShards: 1, unmeasuredEntries: 1,
      truncated: true, startedAtShardBoundary: true } } };
  await f.repository.save({ id: RETENTION_WORKER_ID, updatedAt: new Date().toISOString(), value });
  const sample = (await f.service.get({}, globalScope)).data.retention.scanUsage;
  assert.equal(sample.observedBytes, 42);
  assert.equal(sample.scanCoverage, 'partial');
  assert.equal(sample.freshnessStatus, 'stale');
  assert.equal(sample.currentTotalBytes, null);
  assert.equal(sample.filesystemAvailableBytes, null);
  assert.equal(sample.quotaEnforced, false);
  value.currentAttemptComplete = false;
  await f.repository.save({ id: RETENTION_WORKER_ID, updatedAt: new Date().toISOString(), value });
  const failed = (await f.service.get({}, globalScope)).data.retention.scanUsage;
  assert.equal(failed.scanCoverage, 'unknown');
  assert.equal(failed.observedBytes, null);
});
