'use strict';
// Independent PostgreSQL cluster, two independent DataSources. No inherited DB target.
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
const { createApplicationDataSource } = require('../src/database/sqljs-persistence.ts');
const { CallObservabilityPayloadCoordinator: Coordinator, PAYLOAD_COORDINATION_ID } = require('../src/modules/call-observability/call-observability-payload.coordinator.ts');
const { captureAuditBody } = require('api-nova-parser');
const { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity: Invocation, RuntimeInvocationRevisionEntity: Revision,
  RuntimeIngestReceiptEntity: Receipt, RuntimePipelineStateEntity: Pipeline, RuntimePayloadEntity: Payload } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore: Store } = require('../src/modules/call-observability/call-observability.store.ts');
const { CallObservabilityPayloadStore: Payloads } = require('../src/modules/call-observability/call-observability-payload.store.ts');
const entities = [...CALL_OBSERVABILITY_ENTITIES, Event];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/i.test(key)));
const run = (name, args) => new Promise((resolve, reject) => {
  const executable = process.env.API_NOVA_TEST_PG_BIN ? path.join(process.env.API_NOVA_TEST_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const child = spawn(executable, args, { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); reject(new Error(name + ' timed out')); }, 45000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(name + ' exited ' + code)); });
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
(async () => {
  const root = path.resolve(__dirname, '../../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'prepared-writer-' + (postgres ? 'pg-' : 'sqlite-'))); const data = path.join(directory, 'pgdata');
  const evidence = { directory, tests: [], stopped: false }; let started = false; const databases = []; const payloadStores = [];
  try {
    let options;
    if (postgres) {
    await run('initdb', ['-D', data, '-U', 'runtime_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
    evidence.port = port;
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all runtime_fixture 127.0.0.1/32 trust\nlocal all runtime_fixture trust\n');
    await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    options = { type: 'postgres', host: '127.0.0.1', port, username: 'runtime_fixture', password: '', database: 'postgres', ssl: false,
      entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 } };
    } else options = { type: 'sqljs', location: path.join(directory, 'database.sqlite'), autoSave: true, entities };
    const first = await createApplicationDataSource({ ...options, synchronize: true }).initialize(); databases.push(first);
    const second = postgres ? await new DataSource({ ...options, synchronize: false }).initialize() : first;
    if (postgres) databases.push(second);
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'payloads');
    const stores = [first, second].map(db => { const payloads = new Payloads(); payloadStores.push(payloads); return new Store(db, payloads); });
    const [store, competitor] = stores;
    await Promise.all(stores.map(value => value.ensurePayloadStorage()));
    const coordinator = store.payloadCoordination, competingCoordinator = competitor.payloadCoordination;
    const row = () => first.getRepository(Pipeline).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
    const assertReleased = async () => assert.deepEqual((await row()).value.writers, {});
    const marker = async (tx, id) => tx.manager.getRepository(Pipeline).save({ id, value: { proof: true }, updatedAt: tx.now });
    let queries = 0, commits = 0, exports = 0;
    const originalLog = first.logger.logQuery.bind(first.logger);
    first.logger.logQuery = (sql, ...args) => { queries++; if (/^COMMIT\b/.test(sql)) commits++; originalLog(sql, ...args); };
    if (!postgres) {
      const native = first.driver.databaseConnection, originalExport = native.export.bind(native);
      native.export = (...args) => { exports++; return originalExport(...args); };
    }
    const resetCounts = () => { queries = commits = exports = 0; };
    const counts = () => ({ queries, commits, exports });
    // Same bounded fence workload through the original public lifecycle and the
    // prepared lifecycle. Warm the coordination row before taking measurements.
    await coordinator.withWriter(async () => {});
    resetCounts();
    await coordinator.withWriter(async lease => {
      await store.readSnapshot(tx => tx.manager.getRepository(Pipeline).findOneBy({ id: PAYLOAD_COORDINATION_ID }));
      await store.transaction(async tx => {
        for (let index = 0; index < 16; index++) await coordinator.assertWriter(tx, lease);
        await marker(tx, 'fixture:legacy-fence');
      });
    });
    const baseline = counts(); resetCounts();
    await coordinator.withPreparedWriter(tx => tx.manager.getRepository(Pipeline).findOneBy({ id: PAYLOAD_COORDINATION_ID }), async session => {
      assert.ok(session.prepared);
      await session.commit(async tx => {
        for (let index = 0; index < 16; index++) await coordinator.assertWriter(tx, session.lease);
        await marker(tx, 'fixture:prepared-fence');
      });
    });
    const prepared = counts();
    assert.equal(prepared.commits, 2); assert.ok(prepared.queries < baseline.queries);
    if (!postgres) { assert.equal(baseline.exports, 3); assert.equal(prepared.exports, 2); }
    await assertReleased(); evidence.coordination = { baseline, prepared, assertions: 16 };
    evidence.tests.push('prepared lifecycle uses two durable transactions and fewer actual SQL statements, retaining 16 writer assertions');

    // External preparation remains outside the write transaction, but its durable
    // writer fence prevents another coordinator from acquiring GC.
    await coordinator.withPreparedWriter(async () => 'retention', async session => {
      const blocked = await competingCoordinator.acquireGc();
      assert.equal(blocked.lease, null); assert.equal(blocked.reason, 'writer_active');
      await session.commit(tx => marker(tx, 'fixture:gc-protected'));
    });
    const gcAfter = await competingCoordinator.acquireGc(); assert.ok(gcAfter.lease);
    await competingCoordinator.releaseGc(gcAfter.lease);
    await assertReleased();
    evidence.tests.push('independent coordinator cannot acquire GC during external preparation; committed writer release permits the next generation');

    for (const boundary of ['prepare', 'external', 'late-commit']) {
      await assert.rejects(coordinator.withPreparedWriter(async () => {
        if (boundary === 'prepare') throw new Error(boundary);
        return true;
      }, async session => {
        if (boundary === 'external') throw new Error(boundary);
        return session.commit(async tx => { await marker(tx, 'fixture:rolled-back'); throw new Error(boundary); });
      }), new RegExp(boundary));
      assert.equal(await first.getRepository(Pipeline).countBy({ id: 'fixture:rolled-back' }), 0);
      await assertReleased();
    }
    evidence.tests.push('prepare, external work and late transactional failure leave no writer lease or partially committed business marker');

    for (const corrupt of ['owner', 'generation', 'expiry']) {
      await assert.rejects(coordinator.withPreparedWriter(async () => null, async session => {
        await competitor.transaction(async tx => {
          const state = await tx.manager.getRepository(Pipeline).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
          if (corrupt === 'owner') state.value.writers[session.lease.token].owner = 'foreign-owner';
          if (corrupt === 'generation') state.value.generation = String(BigInt(state.value.generation) + 1n);
          if (corrupt === 'expiry') state.value.writers[session.lease.token].expiresAt = 0;
          await tx.manager.getRepository(Pipeline).save(state);
        });
        await session.commit(tx => marker(tx, 'fixture:invalid-' + corrupt));
      }), /PAYLOAD_WRITE_LEASE_LOST/);
      assert.equal(await first.getRepository(Pipeline).countBy({ id: 'fixture:invalid-' + corrupt }), 0);
      // A changed owner is deliberately not released by this coordinator.
      await competitor.transaction(async tx => {
        const state = await tx.manager.getRepository(Pipeline).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
        if (corrupt === 'owner') assert.ok(Object.values(state.value.writers).some(value => value.owner === 'foreign-owner'));
        state.value.writers = {}; await tx.manager.getRepository(Pipeline).save(state);
      });
    }
    evidence.tests.push('owner substitution, generation change and expiry reject commit without publishing facts; cleanup never deletes another owner');

    await assert.rejects(coordinator.withPreparedWriter(async () => null, session => session.commit(async tx => {
      await marker(tx, 'fixture:late-fence');
      const state = await tx.manager.getRepository(Pipeline).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
      state.value.generation = String(BigInt(state.value.generation) + 1n);
      await tx.manager.getRepository(Pipeline).save(state);
    })), /PAYLOAD_WRITE_LEASE_LOST/);
    assert.equal(await first.getRepository(Pipeline).countBy({ id: 'fixture:late-fence' }), 0);
    await assertReleased();
    evidence.tests.push('fresh end-of-transaction fence detects a same-transaction hook mutation and rolls the business marker back');

    // Keep files real: payload preparation is outside the database commit and a
    // second writer changes retained references during that gap.
    const record = () => ({ schemaVersion: 2, invocationId: randomUUID(), eventId: randomUUID(), sourceInstanceId: randomUUID(), sourceSequence: 1,
      recordVersion: 1, phase: 'finished', requestId: randomUUID(), serverType: 'gateway', spanKind: 'gateway_request', protocolTransport: 'http',
      origin: 'external', runtimeAssetId: randomUUID(), identitySource: 'authenticated', callerId: 'fixture-caller', credentialId: 'fixture-credential',
      startedAt: new Date(Date.now()-1000).toISOString(), completedAt: new Date().toISOString(), durationMs: 20, outcome: 'success', statusCode: 200,
      request: captureAuditBody({ request: 'real file' }), response: captureAuditBody({ response: 'real file' }) });
    const bulk = { batchFacts: true, coalesceBuckets: true };
    resetCounts();
    const inputs = Array.from({ length: 16 }, () => ({ input: record(), context: {} }));
    await store.ingestBatch(inputs, undefined, bulk); const ingest = counts();
    assert.equal(ingest.commits, 2); if (!postgres) assert.equal(ingest.exports, 2);
    assert.equal(await first.getRepository(Receipt).count(), 16);
    assert.equal(await first.getRepository(Invocation).count(), 16);
    evidence.ingest = { records: 16, ...ingest };
    evidence.tests.push('real 16-record ingestion with captured payload files commits receipts, facts and released fence in two durable transactions');

    const previous = inputs[0].input;
    const next = { ...previous, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2, response: captureAuditBody({ response: 'changed file' }) };
    const expired = new Date(Date.now() - 10000).toISOString(); let changedExpiry = false;
    const originalPrepare = payloadStores[0].prepare.bind(payloadStores[0]);
    payloadStores[0].prepare = async (...args) => {
      if (!changedExpiry && args[0].invocationId === previous.invocationId) {
        changedExpiry = true;
        await competitor.transaction(tx => tx.manager.getRepository(Payload).update({ invocationId: previous.invocationId }, { expiresAt: expired }));
      }
      return originalPrepare(...args);
    };
    try { await store.ingestBatch([{ input: next, context: {} }], undefined, bulk); }
    finally { payloadStores[0].prepare = originalPrepare; }
    assert.equal(changedExpiry, true);
    const invocation = await first.getRepository(Invocation).findOneByOrFail({ invocationId: previous.invocationId });
    for (const id of [invocation.requestPayloadId, invocation.responsePayloadId]) {
      assert.equal((await first.getRepository(Payload).findOneByOrFail({ id })).expiresAt, expired);
    }
    await assertReleased();
    evidence.tests.push('save-time reference reload preserves a concurrently shortened expired payload deadline after the preparation snapshot');
    await assert.rejects(coordinator.withPreparedWriter(async () => null, async session => {
      await session.commit(tx => marker(tx, 'fixture:committed-before-callback-error'));
      throw new Error('callback after committed result');
    }), /callback after committed result/);
    assert.equal(await first.getRepository(Pipeline).countBy({ id: 'fixture:committed-before-callback-error' }), 1);
    await assertReleased();
    evidence.tests.push('callback error after awaited commit does not replay or falsely roll back the already committed business result');

    await assert.rejects(first.transaction(async manager => {
      const nested = new Coordinator(operation => manager.transaction(inner => operation({ manager: inner,
        now: new Date().toISOString(), events: [], currentSequence: () => '00000000000000000000', nextSequence: () => '00000000000000000001' })));
      await nested.withPreparedWriter(async () => null, session => session.commit(tx => marker(tx, 'fixture:outer-rollback')));
      throw new Error('enclosing transaction rollback');
    }), /enclosing transaction rollback/);
    assert.equal(await first.getRepository(Pipeline).countBy({ id: 'fixture:outer-rollback' }), 0);
    await assertReleased();
    evidence.tests.push('coordinator bound to an enclosing transaction preserves nested rollback of business writes and writer-state changes');

    if (!postgres) {
      const { PlatformTools } = require('typeorm/platform/PlatformTools');
      const writeFile = PlatformTools.writeFile;
      try {
        await assert.rejects(coordinator.withPreparedWriter(async () => null, async session => {
          PlatformTools.writeFile = async () => { throw new Error('fixture post-COMMIT persistence unavailable'); };
          return session.commit(tx => marker(tx, 'fixture:post-commit-failure'));
        }), /post-COMMIT persistence unavailable/);
        const memory = first.driver.databaseConnection.exec("SELECT COUNT(*) FROM runtime_pipeline_state WHERE id = 'fixture:post-commit-failure'")[0].values[0][0];
        const reader = await new DataSource({ ...options, autoSave: false }).initialize();
        let disk, durableWriters;
        try {
          disk = await reader.getRepository(Pipeline).countBy({ id: 'fixture:post-commit-failure' });
          const state = await reader.getRepository(Pipeline).findOneByOrFail({ id: PAYLOAD_COORDINATION_ID });
          durableWriters = Object.keys(state.value.writers).length;
        } finally { await reader.destroy(); }
        assert.equal(memory, 1); assert.equal(disk, 0); assert.equal(durableWriters, 1);
        evidence.postCommitPersistenceFailure = { rejected: true, memoryMarker: memory, diskMarker: disk, durableWriters,
          boundary: 'SQL COMMIT may precede failed filesystem persistence; cleanup is not proof of business rollback and the cohort is never automatically replayed.' };
      } finally { PlatformTools.writeFile = writeFile; }
      await first.createQueryRunner().flush();
      await assertReleased();
      evidence.tests.push('post-COMMIT filesystem failure rejects the session, exposes actual memory/disk divergence and bounded durable lease, and never retries business work');
    }
    evidence.passed = true;
  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    for (const payloads of payloadStores) await payloads.onModuleDestroy();
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    else evidence.stopped = !postgres;
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, tests: evidence.tests.length, stopped: evidence.stopped, coordination: evidence.coordination, ingest: evidence.ingest, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
