'use strict';
// Real isolated databases. PostgreSQL never inherits a configured application target.
const postgres = process.argv.includes('--postgres');
process.env.DB_TYPE = postgres ? 'postgres' : 'sqlite';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const e = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore: Store } = require('../src/modules/call-observability/call-observability.store.ts');
const { CallObservabilityPayloadStore: Payloads } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const { CallObservabilityCallersProjector: Projector } = require('../src/modules/call-observability/call-observability-callers.projector.ts');
const entities = [...e.CALL_OBSERVABILITY_ENTITIES, Event];
const projectionEntities = [e.RuntimeAccessSourceEntity, e.RuntimeCallerEntity, e.RuntimeCallerCredentialEntity, e.RuntimeCallerObservationEntity];
const diagnosticId = 'call-observability:caller-diagnostics';
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
const run = (name, args) => new Promise((resolve, reject) => {
  const executable = process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const child = spawn(executable, args, { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(name + ' exited ' + code)); });
});
const record = (extra = {}) => {
  const invocationId = randomUUID();
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(), sourceSequence: 1,
    recordVersion: 1, phase: 'started', requestId: randomUUID(), traceId: invocationId, rootInvocationId: invocationId,
    kind: 'admission', spanKind: 'gateway_request', transport: 'gateway', serverType: 'gateway', protocolTransport: 'http',
    origin: 'external', runtimeAssetId: 'asset', identitySource: 'authenticated', authState: 'authenticated', callerId: 'caller',
    credentialId: 'credential', startedAt: '2026-10-08T01:00:00.000Z', peerIp: '127.0.0.1',
    method: 'GET', path: '/batch', byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress',
    requestHeaders: {}, responseHeaders: {}, request: { state: 'unavailable', reason: 'not_captured' },
    response: { state: 'unavailable', reason: 'not_captured' }, ...extra };
};
const projection = row => ({ record: structuredClone(row) });
const entries = records => records.map(input => ({ input, context: {} }));
const bulk = { batchFacts: true, coalesceBuckets: true };
(async () => {
  const root = path.resolve(__dirname, '../../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'caller-batch-' + (postgres ? 'pg-' : 'sqlite-')));
  const evidence = { directory, backend: postgres ? 'postgres' : 'sqljs', tests: [], stopped: false };
  const databases = [], payloadStores = []; let started = false;
  try {
    let options;
    if (postgres) {
      const data = path.join(directory, 'pgdata');
      await run('initdb', ['-D', data, '-U', 'caller_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
      const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
      evidence.port = port;
      await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
      await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all caller_fixture 127.0.0.1/32 trust\nlocal all caller_fixture trust\n');
      await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
      options = { type: 'postgres', host: '127.0.0.1', port, username: 'caller_fixture', password: '', database: 'postgres', ssl: false,
        entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 } };
    } else options = { type: 'sqljs', location: path.join(directory, 'database.sqlite'), autoSave: true, entities };
    const db = await new DataSource({ ...options, synchronize: true }).initialize(); databases.push(db);
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'payloads');
    const payloads = new Payloads(); payloadStores.push(payloads); const store = new Store(db, payloads);
    const makeProjector = cap => new Projector(new ConfigService({ API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET: 'a'.repeat(32),
      API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID: 'v1', API_NOVA_OBSERVABILITY_SOURCES_PER_DAY: cap ?? 10000 }));
    const projector = makeProjector();
    const reset = async () => {
      for (const entity of projectionEntities) await db.getRepository(entity).clear();
      await db.getRepository(e.RuntimePipelineStateEntity).delete({ id: diagnosticId });
    };
    const snapshot = async () => {
      const out = {};
      for (const entity of projectionEntities) out[entity.name] = (await db.getRepository(entity).find())
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      out.diagnostics = (await db.getRepository(e.RuntimePipelineStateEntity).findOneBy({ id: diagnosticId }))?.value || null;
      return out;
    };
    const apply = async (rows, optimized, selected = projector, before = [], targetStore = store) => {
      const values = rows.map(projection); const batch = optimized ? selected.project.createBatch() : undefined;
      try {
        await targetStore.transaction(async tx => {
          for (let index = 0; index < values.length; index++) await (batch?.project || selected.project)(tx, before[index] || null, values[index]);
          if (batch) await batch.flush(tx);
        });
      } finally { batch?.dispose(); }
      return values;
    };
    const seedProfile = async () => db.getRepository(e.RuntimeCallerEntity).save({ callerId: 'caller', identitySource: 'authenticated',
      displayName: 'Managed name', note: 'Managed note', labels: ['managed'], version: 7,
      firstSeenAt: '2026-10-08T01:00:00.000Z', lastSeenAt: '2026-10-08T01:00:00.000Z' });
    let queries = []; const originalLog = db.logger.logQuery.bind(db.logger);
    db.logger.logQuery = (query, ...args) => { if (/runtime_(?:access_sources|callers|caller_credentials|caller_observations)/.test(query)) queries.push(query); originalLog(query, ...args); };
    const same = Array.from({ length: 16 }, (_, index) => record({ completedAt: `2026-10-08T01:00:${String(index + 1).padStart(2, '0')}.000Z` }));
    await seedProfile(); queries = []; const expectedValues = await apply(same, false); const baselineQueries = queries.length;
    const expected = await snapshot(); await reset(); await seedProfile(); queries = [];
    const actualValues = await apply(same, true); const batchQueries = queries.length;
    assert.deepEqual(actualValues, expectedValues); assert.deepEqual(await snapshot(), expected);
    assert.ok(batchQueries < baselineQueries * 0.25, `${batchQueries}/${baselineQueries}`);
    evidence.queryCounts = { records: 16, baselineQueries, batchQueries };
    evidence.tests.push('16 same-identity records: exact profile/source/credential/observation equivalence and >75% fewer projection SQL statements');

    await reset(); const capped = makeProjector(2);
    const mixed = [record({ peerIp: '10.0.0.1' }), record({ peerIp: '10.0.0.2' }), record({ peerIp: '10.0.0.3' }),
      record({ peerIp: '10.0.0.4', serverType: 'mcp' }), record({ peerIp: '10.0.0.5' }),
      record({ peerIp: '10.0.0.1', completedAt: '2026-10-08T01:01:00.000Z' }),
      record({ runtimeAssetId: null, peerIp: '10.0.0.6' }), record({ authState: 'anonymous', identitySource: 'unknown', peerIp: '10.0.0.7' }),
      record({ authState: 'authentication_failed', peerIp: '10.0.0.8' }), record({ peerIp: '10.0.0.9', clientIp: '8.8.8.8', proxyTrusted: false, ipSource: 'trusted_proxy' }),
      record({ runtimeAssetId: 'proxy', peerIp: '10.0.0.10', clientIp: '8.8.8.8', proxyTrusted: true, ipSource: 'trusted_proxy' }),
      record({ startedAt: '2026-10-07T01:00:00.000Z', peerIp: '10.0.0.11' }), record({ origin: 'internal' }), record({ spanKind: 'upstream_api' }),
      record({ identitySource: 'unknown', peerIp: 'invalid', clientIp: '8.8.8.8' }), record({ peerIp: '10.0.0.12', serverType: 'mcp' })];
    const previous = []; previous[4] = projection(mixed[4]);
    const mixedExpectedValues = await apply(mixed, false, capped, previous); const mixedExpected = await snapshot();
    await reset(); const mixedActual = await apply(mixed, true, capped, previous);
    assert.deepEqual(mixedActual, mixedExpectedValues); assert.deepEqual(await snapshot(), mixedExpected);
    assert.equal(mixedActual[2].record.sourceOverflow, true); assert.equal(mixedActual[3].record.sourceOverflow, true);
    assert.equal(mixedActual[9].record.clientIp, '10.0.0.9'); assert.equal(mixedActual[10].record.clientIp, '8.8.8.8');
    assert.equal(mixedActual[7].record.authState, 'anonymous');
    evidence.tests.push('cap crossing across serverType, overflow counted/incremented once per new invocation, proxy trust, anonymous/failed identity, null asset/day and excluded work match immediate path');

    await reset();
    const start = record({ runtimeAssetId: randomUUID(), startedAt: new Date(Date.now() - 1000).toISOString() });
    const middle = { ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2 };
    const finish = { ...start, eventId: randomUUID(), sourceSequence: 3, recordVersion: 3, phase: 'finished',
      completedAt: new Date().toISOString(), durationMs: 1, outcome: 'success', statusCode: 200 };
    const inputs = entries([start, middle, start, { ...start, eventId: randomUUID(), sourceSequence: 4 }, finish]);
    const statuses = await store.ingestBatch(inputs, projector.project, bulk);
    assert.deepEqual(statuses.map(row => row.status), ['inserted', 'updated', 'duplicate', 'stale', 'updated']);
    const versions = await db.getRepository(e.RuntimeInvocationRevisionEntity).find({ where: { invocationId: start.invocationId }, order: { recordVersion: 'ASC' } });
    assert.equal(versions.length, 3); assert.ok(versions[0].sourceId);
    assert.ok(versions.every(row => row.sourceId === versions[0].sourceId && row.record.sourceId === row.sourceId));
    const prior = await snapshot(); await store.ingestBatch(inputs, projector.project, bulk); assert.deepEqual(await snapshot(), prior);
    evidence.tests.push('real ingest start/progress/terminal revisions retain per-record source identity; duplicate/stale/replay do not repeat projections');

    await reset();
    const identityStart = record({ runtimeAssetId: randomUUID(), startedAt: new Date(Date.now() - 1000).toISOString() });
    const revoked = { ...identityStart, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
      identitySource: 'anonymous', authState: 'authentication_failed', callerId: null, credentialId: null };
    const restored = { ...identityStart, eventId: randomUUID(), sourceSequence: 3, recordVersion: 3 };
    const identityResults = await store.ingestBatch(entries([identityStart, revoked, restored]), projector.project, bulk);
    assert.deepEqual(identityResults.map(row => row.status), ['inserted', 'quarantined', 'updated']);
    assert.equal(identityResults[1].reason, 'INVOCATION_IDENTITY_CONFLICT');
    const identityVersions = await db.getRepository(e.RuntimeInvocationRevisionEntity).find({
      where: { invocationId: identityStart.invocationId }, order: { recordVersion: 'ASC' } });
    assert.deepEqual(identityVersions.map(row => row.callerId), ['caller', 'caller']);
    assert.equal(identityVersions[1].sourceId, identityVersions[0].sourceId);
    assert.ok(identityVersions.every(row => row.sourceId === row.record.sourceId));
    const identityObservations = await db.getRepository(e.RuntimeCallerObservationEntity).find();
    assert.equal(identityObservations.length, 1);
    assert.equal(identityObservations[0].callerId, 'caller');
    assert.equal(await db.getRepository(e.RuntimeCallerCredentialEntity).count(), 1);
    evidence.tests.push('same-invocation caller removal remains an identity conflict: quarantine does not alter source/profile/credential history or block the next valid revision');

    await reset();
    const retryRecord = record({ runtimeAssetId: randomUUID(), startedAt: new Date().toISOString() });
    const checkpoint = { id: 'f'.repeat(64), fileName: 'calls-v2-retry.jsonl', fileIdentity: 'fixture', previousOffset: '0', byteOffset: '1', boundaryHash: 'b'.repeat(64) };
    const retryEntries = [{ input: retryRecord, context: { checkpoint } }];
    const originalFlush = projector.flushBatch.bind(projector); const originalFactory = projector.project.createBatch;
    let lastBatch, disposed = 0;
    projector.project.createBatch = () => { const batch = originalFactory(); lastBatch = batch; const dispose = batch.dispose;
      batch.dispose = () => { disposed++; dispose(); }; return batch; };
    projector.flushBatch = async (...args) => { await originalFlush(...args); throw new Error('late caller flush failure'); };
    await assert.rejects(store.ingestBatch(retryEntries, projector.project, bulk), /late caller flush failure/);
    assert.equal(disposed, 1); await assert.rejects(lastBatch.project({}, null, projection(retryRecord)), /INVALID_PROJECTION_BATCH/);
    assert.equal(await db.getRepository(e.RuntimeAccessSourceEntity).count(), 0);
    assert.equal(await db.getRepository(e.RuntimeInvocationEntity).findOneBy({ invocationId: retryRecord.invocationId }), null);
    assert.equal(await db.getRepository(e.RuntimeIngestCheckpointEntity).findOneBy({ id: checkpoint.id }), null);
    projector.flushBatch = originalFlush;
    const originalFacts = store.flushFactBatch.bind(store);
    store.flushFactBatch = async (...args) => { await originalFacts(...args); throw new Error('after facts failure'); };
    await assert.rejects(store.ingestBatch(retryEntries, projector.project, bulk), /after facts failure/);
    assert.equal(disposed, 2); assert.equal(await db.getRepository(e.RuntimeAccessSourceEntity).count(), 0);
    store.flushFactBatch = originalFacts;
    assert.equal((await store.ingestBatch(retryEntries, projector.project, bulk))[0].status, 'inserted');
    assert.equal(disposed, 3); assert.equal(await db.getRepository(e.RuntimeAccessSourceEntity).count(), 1);
    assert.equal((await db.getRepository(e.RuntimeIngestCheckpointEntity).findOneByOrFail({ id: checkpoint.id })).byteOffset.replace(/^0+/, ''), '1');
    projector.project.createBatch = originalFactory;
    evidence.tests.push('late projection SQL and late core fact failure roll back projections/facts/checkpoint, dispose batch state, and allow exactly-once fresh retry');

    await reset(); await seedProfile(); const protectedBatch = projector.project.createBatch();
    try {
      await store.transaction(async tx => {
        await protectedBatch.project(tx, null, projection(record({ completedAt: '2026-10-08T01:05:00.000Z' })));
        await tx.manager.getRepository(e.RuntimeCallerEntity).update({ callerId: 'caller' }, { displayName: 'New managed name', note: 'New note', labels: ['new'], version: 8 });
        await protectedBatch.flush(tx);
      });
    } finally { protectedBatch.dispose(); }
    const protectedProfile = await db.getRepository(e.RuntimeCallerEntity).findOneByOrFail({ callerId: 'caller' });
    assert.equal(protectedProfile.displayName, 'New managed name'); assert.equal(protectedProfile.note, 'New note');
    assert.deepEqual(protectedProfile.labels, ['new']); assert.equal(protectedProfile.version, 8);
    assert.equal(protectedProfile.lastSeenAt, '2026-10-08T01:05:00.000Z');
    evidence.tests.push('profile conflict update excludes displayName/note/labels/version even if cached metadata changes before flush');

    await reset(); let calls = 0;
    const immediateHook = async (tx, before, after) => {
      await projector.project(tx, before, after); calls++;
      assert.equal(await tx.manager.getRepository(e.RuntimeCallerEntity).count(), 1);
      assert.equal((await tx.manager.getRepository(e.RuntimeAccessSourceEntity).find()).length, 1);
    };
    immediateHook.createBatch = () => { throw new Error('default hook must not create batch'); };
    await store.ingestBatch(entries([record({ runtimeAssetId: randomUUID() })]), immediateHook);
    assert.equal(calls, 1);
    delete immediateHook.createBatch;
    await store.ingestBatch(entries([record({ runtimeAssetId: (await db.getRepository(e.RuntimeAccessSourceEntity).find())[0].runtimeAssetId })]), immediateHook, bulk);
    assert.equal(calls, 2);
    const bounded = projector.project.createBatch();
    try {
      await store.transaction(async tx => {
        for (let index = 0; index < 16; index++) await bounded.project(tx, null, projection(record({ origin: 'internal' })));
        await assert.rejects(bounded.project(tx, null, projection(record())), /INVALID_PROJECTION_BATCH/);
        await assert.rejects(bounded.flush({ ...tx }), /INVALID_PROJECTION_BATCH/);
      });
    } finally { bounded.dispose(); }
    evidence.tests.push('default and arbitrary hooks keep immediate read-your-writes; batch is restricted to 16 records and one transaction');

    if (postgres) {
      await reset(); await seedProfile(); const other = await new DataSource({ ...options, synchronize: false }).initialize(); databases.push(other);
      const otherPayloads = new Payloads(); payloadStores.push(otherPayloads); const otherStore = new Store(other, otherPayloads);
      const firstRecords = Array.from({ length: 4 }, (_, index) => record({ peerIp: `10.1.0.${index + 1}` }));
      const secondRecords = Array.from({ length: 4 }, (_, index) => record({ peerIp: `10.2.0.${index + 1}`, serverType: 'mcp', completedAt: '2026-10-08T01:06:00.000Z' }));
      await Promise.all([apply(firstRecords, true, capped), apply(secondRecords, true, capped, [], otherStore)]);
      const sources = await db.getRepository(e.RuntimeAccessSourceEntity).find();
      assert.equal(sources.filter(row => row.ipSource !== 'overflow').length, 2);
      assert.equal(sources.filter(row => row.ipSource === 'overflow').length, 2);
      assert.equal((await db.getRepository(e.RuntimePipelineStateEntity).findOneByOrFail({ id: diagnosticId })).value.sourceOverflowInvocations, 6);
      const profile = await db.getRepository(e.RuntimeCallerEntity).findOneByOrFail({ callerId: 'caller' });
      assert.equal(profile.lastSeenAt, '2026-10-08T01:06:00.000Z'); assert.equal(profile.displayName, 'Managed name'); assert.equal(profile.version, 7);
      evidence.tests.push('two independent PostgreSQL writers serialize cap admission/overflow diagnostics and merge caller time bounds without losing managed metadata');
    }
    evidence.passed = true;
  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    for (const payloads of payloadStores) await payloads.onModuleDestroy();
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', path.join(directory, 'pgdata'), '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    else evidence.stopped = !postgres;
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, passed: evidence.tests.length, stopped: evidence.stopped, queryCounts: evidence.queryCounts, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
