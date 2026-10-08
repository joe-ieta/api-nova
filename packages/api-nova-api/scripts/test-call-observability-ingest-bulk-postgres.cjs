'use strict';
// Independent PostgreSQL cluster, two independent DataSources. No inherited DB target.
process.env.DB_TYPE = 'postgres';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const { DataSource } = require('typeorm');
const { CALL_OBSERVABILITY_ENTITIES, RuntimeInvocationEntity: Invocation, RuntimeInvocationRevisionEntity: Revision,
  RuntimeIngestReceiptEntity: Receipt } = require('../src/database/entities/runtime-call-observability.entity.ts');
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
  const directory = await fs.mkdtemp(path.join(root, 'ingest-bulk-pg-')); const data = path.join(directory, 'pgdata');
  const evidence = { directory, tests: [], stopped: false }; let started = false; const databases = []; const payloadStores = [];
  try {
    await run('initdb', ['-D', data, '-U', 'runtime_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
    evidence.port = port;
    await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nfsync=on\nsynchronous_commit=on\nmax_connections=16\n`);
    await fs.writeFile(path.join(data, 'pg_hba.conf'), 'host all runtime_fixture 127.0.0.1/32 trust\nlocal all runtime_fixture trust\n');
    await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start']); started = true;
    const options = { type: 'postgres', host: '127.0.0.1', port, username: 'runtime_fixture', password: '', database: 'postgres', ssl: false,
      entities, extra: { max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000 } };
    const first = await new DataSource({ ...options, synchronize: true }).initialize(); databases.push(first);
    const second = await new DataSource({ ...options, synchronize: false }).initialize(); databases.push(second);
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(directory, 'payloads');
    const stores = databases.map(db => { const payloads = new Payloads(); payloadStores.push(payloads); return new Store(db, payloads); });
    const record = () => { const invocationId = randomUUID(); return {
      schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(), sourceSequence: 1,
      recordVersion: 1, phase: 'started', requestId: randomUUID(), traceId: invocationId, rootInvocationId: invocationId,
      kind: 'admission', spanKind: 'gateway_request', transport: 'gateway', serverType: 'gateway', protocolTransport: 'http',
      origin: 'external', runtimeAssetId: randomUUID(), identitySource: 'authenticated', callerId: 'caller',
      credentialId: 'credential', startedAt: new Date(Date.now()-1000).toISOString(), method: 'GET', path: '/bulk',
      byteMeasurement: 'observed_body', measurementStage: 'gateway_ingress', requestHeaders: {}, responseHeaders: {},
      request: { state: 'unavailable', reason: 'not_captured' }, response: { state: 'unavailable', reason: 'not_captured' },
    }; };
    const finish = start => ({ ...start, eventId: randomUUID(), sourceSequence: 2, recordVersion: 2,
      phase: 'finished', completedAt: new Date().toISOString(), durationMs: 20, outcome: 'success', statusCode: 200 });
    const bulk = { batchFacts: true, coalesceBuckets: true };
    const records = Array.from({ length: 8 }, record).flatMap(start => [start, finish(start)]);
    const inputs = records.map(input => ({ input, context: {} }));
    const results = await Promise.all(stores.map(store => store.ingestBatch(inputs, undefined, bulk)));
    assert.equal(results.flat().filter(row => row.status === 'duplicate').length, 16);
    assert.equal(await first.getRepository(Invocation).count(), 8);
    assert.equal(await first.getRepository(Revision).count(), 16);
    assert.equal(await first.getRepository(Receipt).count(), 16);
    assert.equal(await first.getRepository(Event).count(), 24);
    for (const input of records.filter(row => row.phase === 'started')) {
      const versions = await first.getRepository(Revision).find({ where: { invocationId: input.invocationId }, order: { recordVersion: 'ASC' } });
      assert.equal(versions[0].validUntilSequence, versions[1].validFromSequence);
      assert.equal(versions[1].validUntilSequence, null);
    }
    evidence.tests.push('two independent writers ingest the same bounded batch: 16 exact receipts/revisions, duplicates and closed history intervals');
    const next = record(); await stores[0].ingest(next);
    const mid = { ...next, eventId: randomUUID(), recordVersion: 2, sourceSequence: 2 };
    const last = { ...finish(next), recordVersion: 3, sourceSequence: 3 };
    await stores[1].ingestBatch([mid, last].map(input => ({ input, context: {} })), undefined, bulk);
    const versions = await first.getRepository(Revision).find({ where: { invocationId: next.invocationId }, order: { recordVersion: 'ASC' } });
    assert.equal(versions.length, 3); assert.equal(versions[0].validUntilSequence, versions[1].validFromSequence);
    assert.equal(versions[1].validUntilSequence, versions[2].validFromSequence);
    evidence.tests.push('existing history and same-batch intermediate versions retain exact sequence intervals across instances');
    const before = await first.getRepository(Receipt).count();
    const failing = Array.from({ length: 16 }, () => ({ input: finish(record()), context: {} }));
    const originalFlush = stores[0].flushFactBatch.bind(stores[0]);
    stores[0].flushFactBatch = async (...args) => { await originalFlush(...args); throw new Error('after complete fact flush'); };
    await assert.rejects(stores[0].ingestBatch(failing, undefined, bulk), /after complete fact flush/);
    assert.equal(await first.getRepository(Receipt).count(), before);
    stores[0].flushFactBatch = originalFlush;
    await stores[1].ingestBatch(failing, undefined, bulk);
    assert.equal(await first.getRepository(Receipt).count(), before + 16);
    evidence.tests.push('post-flush transaction failure rolls back all bulk SQL; another instance retries exactly once');
  } catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    for (const payloads of payloadStores) await payloads.onModuleDestroy();
    for (const db of databases) if (db.isInitialized) await db.destroy();
    if (started) { await run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']); evidence.stopped = true; }
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, passed: evidence.tests.length, stopped: evidence.stopped, error: evidence.error }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
