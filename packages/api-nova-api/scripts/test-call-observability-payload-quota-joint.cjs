'use strict';
// OBS-14-05D quota state-machine and local fault joint scenarios. Windows local
// SQL.js plus real filesystem I/O in an isolated temporary payload root.
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, project: require('node:path').resolve(__dirname, '../tsconfig.json') });
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const source = name => require('../src/' + name + '.ts');
const entities = source('database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity: Event } = source('database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = source('modules/call-observability/call-observability.store');
const { CallObservabilityPayloadStore } = source('modules/call-observability/call-observability-payload.store');
const { PayloadQuotaPrimitives } = source('modules/call-observability/call-observability-payload-quota');
const physical = source('modules/call-observability/call-observability-payload-physical');
const { CallObservabilityPayloadsService } = source('modules/call-observability/call-observability-payloads.service');
const { PayloadPublicationReconcileService } = source('modules/call-observability/call-observability-payload-publication-reconcile');
const { authorizeObservability } = source('modules/call-observability/call-observability-access');
const { User, UserStatus } = source('database/entities/user.entity');
const { Role, RoleType } = source('database/entities/role.entity');
const { Permission } = source('database/entities/permission.entity');

const parent = path.resolve(__dirname, '../../../tmp/observability-payload-quota-joint-tests');
const quotaEnv = 'API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED';
const guardEnv = physical.PAYLOAD_PHYSICAL_GUARD_ENV;
const code = expected => error => error.code === expected;
const detail = {};

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
function withQuota(t) { withEnv(t, quotaEnv, 'true'); }

async function fixture(t, options = {}) {
  const { enabled = true, quotaBytes = 1000, maxBodyBytes = 500, minimumFreeBytes = 1, baselineBytes = 0 } = options;
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const previous = process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = directory;
  const payloads = new CallObservabilityPayloadStore();
  if (previous === undefined) delete process.env.API_NOVA_OBSERVABILITY_DATA_DIR;
  else process.env.API_NOVA_OBSERVABILITY_DATA_DIR = previous;
  const db = await new DataSource({ type: 'sqljs', synchronize: true,
    entities: [...entities.CALL_OBSERVABILITY_ENTITIES, Event] }).initialize();
  const store = new CallObservabilityStore(db, payloads);
  const ownerId = await store.ensurePayloadStorage();
  const quota = new PayloadQuotaPrimitives();
  const initial = await store.transaction(tx => quota.initialize(tx,
    enabled ? { enabled: true, quotaBytes, maxBodyBytes, minimumFreeBytes } : { enabled: false }));
  if (enabled && baselineBytes >= 0) await store.transaction(tx => quota.confirmBaseline(tx, initial.epoch,
    { kind: 'complete_inventory', evidenceId: 'obs-14-05d-joint-baseline', committedBytes: baselineBytes }));
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await payloads.onModuleDestroy();
    const target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('run-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  return {
    directory, db, store, payloads, quota, ownerId, epoch: initial.epoch, initial,
    status: () => store.readSnapshot(tx => quota.status(tx)),
    reserve: (id, bytes, observation) => store.transaction(tx => quota.reserve(tx, initial.epoch, id, bytes, observation)),
    settle: (id, outcome) => store.transaction(tx => quota.settle(tx, initial.epoch, id, outcome)),
    reserveCount: () => db.getRepository(entities.RuntimePayloadQuotaReservationEntity).count(),
    ledger: () => db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).findOneByOrFail({ ownerId }),
  };
}

function record(data, runtimeAssetId = randomUUID()) {
  const invocationId = randomUUID(), bytes = Buffer.byteLength(data);
  return { schemaVersion: 2, invocationId, eventId: randomUUID(), sourceInstanceId: randomUUID(),
    sourceSequence: 1, recordVersion: 1, phase: 'finished', requestId: randomUUID(), traceId: invocationId,
    rootInvocationId: invocationId, runtimeAssetId, kind: 'admission', spanKind: 'gateway_request',
    serverType: 'gateway', transport: 'gateway', protocolTransport: 'http', origin: 'external', identitySource: 'anonymous',
    outcome: 'success', statusCode: 200, startedAt: new Date(Date.now() - 1000).toISOString(), completedAt: new Date().toISOString(),
    request: { state: 'captured', reason: null, data, contentType: 'text/plain', encoding: 'utf8', observedBytes: bytes,
      capturedBytes: bytes, storedBytes: bytes, capturedDigest: createHash('sha256').update(data).digest('hex'),
      digestScope: 'observed_raw', redacted: true, redactionPolicyVersion: 'default-v1' },
    response: { state: 'unavailable', reason: 'not_captured' } };
}
async function request(f, event) {
  const invocation = await f.db.getRepository(entities.RuntimeInvocationEntity)
    .findOneByOrFail({ invocationId: event.invocationId });
  return f.db.getRepository(entities.RuntimePayloadEntity).findOneByOrFail({ id: invocation.requestPayloadId });
}
async function invocation(f, event) {
  return f.db.getRepository(entities.RuntimeInvocationEntity).findOneByOrFail({ invocationId: event.invocationId });
}
function watchTemporary(t, observe = async () => {}) {
  const open = fs.open; let writes = 0;
  fs.open = async (...args) => { if (args[1] === 'wx') { writes++; await observe(args[0]); } return open(...args); };
  t.after(() => { fs.open = open; });
  return () => writes;
}
async function bodyBytes(f) {
  let measured = 0;
  async function measure(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await measure(file);
      else if (entry.isFile() && /\.(body|tmp)$/.test(entry.name)) measured += (await fs.stat(file)).size;
    }
  }
  await measure(path.join(f.directory, 'payloads'));
  return measured;
}
function account(assets) {
  const role = Object.assign(new Role(), { id: randomUUID(), name: 'fixture-role', type: RoleType.CUSTOM, enabled: true,
    permissions: ['monitoring:read', 'monitoring:payload:read'].map(name =>
      Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
    metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: assets } } });
  return Object.assign(new User(), { id: randomUUID(), username: 'fixture-user', email: 'fixture@example.invalid',
    password: 'not-used', status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles: [role] });
}

test('scenario 1 high/low watermarks: real publication stops at H=90%, refuses past L and never double counts', async t => {
  const f = await fixture(t); withQuota(t);
  const watcher = watchTemporary(t);
  for (let index = 0; index < 9; index++) await f.store.ingest(record('a'.repeat(100)));
  assert.equal(watcher(), 9);
  const pressured = await f.status();
  assert.equal(pressured.committedBytes, 900);
  assert.equal(pressured.reservedBytes, 0);
  assert.equal(pressured.budgetedBytes, 900);
  assert.equal(pressured.state, 'limited');
  assert.equal(pressured.configuration.highWatermarkBytes, 900);
  assert.equal(pressured.configuration.lowWatermarkBytes, 800);
  const denied = record('b'.repeat(10));
  await f.store.ingest(denied);
  const deniedBody = await request(f, denied);
  assert.equal(deniedBody.state, 'omitted');
  assert.equal(deniedBody.reason, 'quota_exhausted');
  assert.equal(deniedBody.metadata.storedBytes, 0);
  assert.equal(watcher(), 9);
  assert.equal(await f.reserveCount(), 9);
  assert.deepEqual(await f.status(), pressured);
  assert.equal(await bodyBytes(f), 900);

  const hysteresis = await fixture(t);
  assert.equal((await hysteresis.reserve('below', 899)).status.state, 'ready');
  const atHigh = await hysteresis.reserve('at-high', 1);
  assert.equal(atHigh.status.budgetedBytes, 900);
  assert.equal(atHigh.status.state, 'limited');
  await assert.rejects(hysteresis.reserve('over-high', 1), code('QUOTA_NOT_READY'));
  await hysteresis.settle('at-high', { reason: 'confirmed_absent', committedBytes: 0 });
  const atLow = await hysteresis.settle('below', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 800 });
  assert.equal(atLow.status.committedBytes, 800);
  assert.equal(atLow.status.reservedBytes, 0);
  assert.equal(atLow.status.budgetedBytes, 800);
  assert.equal(atLow.status.state, 'ready');
  const edge = await hysteresis.reserve('edge', 100);
  assert.equal(edge.status.budgetedBytes, 900);
  assert.equal(edge.status.state, 'limited');
  await assert.rejects(hysteresis.reserve('edge-over', 1), code('QUOTA_NOT_READY'));
  const aboveLow = await hysteresis.settle('edge', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 100 });
  assert.equal(aboveLow.status.committedBytes, 900);
  assert.equal(aboveLow.status.state, 'limited');
  assert.equal(await hysteresis.reserveCount(), 3);

  const hard = await fixture(t);
  await hard.reserve('peak', 900);
  await hard.settle('peak', { reason: 'confirmed_occupancy_and_unused_absent', committedBytes: 800 });
  const atHardBound = await hard.reserve('hard', 200);
  assert.equal(atHardBound.status.budgetedBytes, 1000);
  assert.equal(atHardBound.status.state, 'limited');
  await assert.rejects(hard.reserve('hard-over', 1), code('QUOTA_NOT_READY'));

  detail.scenario1 = { highWatermarkBytes: 900, lowWatermarkBytes: 800, committedAtHigh: 900,
    deniedReason: 'quota_exhausted', deniedWrites: 0, reservationRows: 9, physicalBytes: 900,
    hysteresis: { atHigh: 'limited', overHigh: 'QUOTA_NOT_READY', atLowCommitted: 800, atLow: 'ready', aboveLow: 'limited' },
    hardBoundExact: 1000 };
});

test('scenario 2 physical reserve: real statfs evidence, low/stale/missing never bypassed, default off', async t => {
  const f = await fixture(t); withQuota(t); withEnv(t, guardEnv, 'true');
  const realObserve = physical.observePayloadFreeSpace;
  const seen = [];
  physical.observePayloadFreeSpace = async root => {
    const observation = await realObserve(root);
    seen.push({ root, observation });
    return observation;
  };
  t.after(() => { physical.observePayloadFreeSpace = realObserve; });
  const accepted = record('c'.repeat(10));
  await f.store.ingest(accepted);
  assert.equal((await request(f, accepted)).state, 'captured');
  assert.ok(seen.length >= 1);
  assert.ok(seen[0].root.endsWith(path.join('payloads')));
  const stat = fsSync.statfsSync(seen[0].root);
  assert.equal(seen[0].observation.availableBytes, Number(stat.bavail) * Number(stat.bsize));
  assert.ok(seen[0].observation.availableBytes > 0);

  const writes = watchTemporary(t);
  physical.observePayloadFreeSpace = async () => ({ availableBytes: 1, observedAtMs: Date.now(), source: 'filesystem_statfs' });
  const low = record('d'.repeat(10));
  await f.store.ingest(low);
  assert.equal((await request(f, low)).reason, 'quota_physical_low');
  physical.observePayloadFreeSpace = async () => ({ availableBytes: 1 << 30, observedAtMs: Date.now() - 15001, source: 'filesystem_statfs' });
  const stale = record('e'.repeat(10));
  await f.store.ingest(stale);
  assert.equal((await request(f, stale)).reason, 'quota_physical_unknown');
  physical.observePayloadFreeSpace = async () => null;
  const missing = record('f'.repeat(10));
  await f.store.ingest(missing);
  assert.equal((await request(f, missing)).reason, 'quota_physical_unknown');
  assert.equal(writes(), 0);
  assert.equal(await f.reserveCount(), 1);
  assert.equal((await f.status()).committedBytes, 10);
  physical.observePayloadFreeSpace = realObserve;
  const recovered = record('g'.repeat(10));
  await f.store.ingest(recovered);
  assert.equal((await request(f, recovered)).state, 'captured');
  assert.equal(writes(), 1);
  assert.equal((await f.status()).committedBytes, 20);

  const off = await fixture(t); withQuota(t); withEnv(t, guardEnv, 'false');
  let consulted = 0;
  physical.observePayloadFreeSpace = async () => { consulted++; return { availableBytes: 1, observedAtMs: Date.now(), source: 'filesystem_statfs' }; };
  try {
    const unguarded = record('h'.repeat(10));
    await off.store.ingest(unguarded);
    assert.equal((await request(off, unguarded)).state, 'captured');
    assert.equal(consulted, 0);
  } finally { physical.observePayloadFreeSpace = realObserve; }

  detail.scenario2 = { configuredReserveBytes: 1, realObservationBytes: seen[0].observation.availableBytes,
    simulatedLow: 'quota_physical_low', staleEvidence: 'quota_physical_unknown', missingEvidence: 'quota_physical_unknown',
    deniedTemporaryWrites: 0, recoveredWithRealNumbers: true, defaultOffConsulted: consulted === 0 };
});

test('scenario 3 version, schema and disabled states reject without mutation or data leak', async t => {
  const f = await fixture(t); withQuota(t);
  const before = await f.status();
  const beforeLedger = await f.ledger();
  assert.deepEqual(await f.store.transaction(tx => f.quota.initialize(tx,
    { enabled: true, quotaBytes: 1000, maxBodyBytes: 500, minimumFreeBytes: 1 })), before);
  await assert.rejects(f.store.transaction(tx => f.quota.initialize(tx,
    { enabled: true, quotaBytes: 2000, maxBodyBytes: 500 })), code('QUOTA_CONFIGURATION_CONFLICT'));
  const unchanged = await f.ledger();
  assert.equal(unchanged.state, 'ready');
  assert.equal(unchanged.committedBytes, '0');
  assert.equal(unchanged.version, beforeLedger.version);
  await assert.rejects(f.store.transaction(tx => f.quota.reserve(tx, randomUUID(), 'wrong-epoch', 10)), code('QUOTA_EPOCH_MISMATCH'));
  await f.reserve('operation', 100);
  await assert.rejects(f.reserve('operation', 101), code('QUOTA_OPERATION_CONFLICT'));
  await assert.rejects(f.store.transaction(async tx => {
    const repository = tx.manager.getRepository(entities.RuntimePayloadQuotaLedgerEntity);
    const get = tx.manager.getRepository.bind(tx.manager);
    tx.manager.getRepository = target => target === entities.RuntimePayloadQuotaLedgerEntity
      ? new Proxy(repository, { get(repo, key) {
        if (key === 'update') return async () => ({ affected: 0 });
        const value = repo[key]; return typeof value === 'function' ? value.bind(repo) : value;
      } }) : get(target);
    try { await f.quota.reserve(tx, f.epoch, 'cas-conflict', 10); }
    finally { tx.manager.getRepository = get; }
  }), code('QUOTA_VERSION_CONFLICT'));
  assert.equal(await f.reserveCount(), 1);
  assert.equal((await f.status()).reservedBytes, 100);
  await f.db.getRepository(entities.RuntimePayloadQuotaLedgerEntity).update({ ownerId: f.ownerId },
    { reservedBytes: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) });
  await assert.rejects(f.status(), code('INVALID_QUOTA_LEDGER'));

  const disabledFixture = await fixture(t, { enabled: false }); withQuota(t);
  const disabled = await disabledFixture.status();
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.committedBytes, null);
  assert.equal(disabled.budgetedBytes, null);
  assert.equal(disabled.configuration.enabled, false);
  await assert.rejects(disabledFixture.reserve('disabled-operation', 1), code('QUOTA_NOT_READY'));
  const writes = watchTemporary(t);
  const denied = record('i'.repeat(10));
  await disabledFixture.store.ingest(denied);
  assert.equal((await request(disabledFixture, denied)).reason, 'quota_unavailable');
  assert.equal(writes(), 0);
  assert.deepEqual(await disabledFixture.status(), disabled);
  const disabledLedger = await disabledFixture.ledger();
  assert.equal(disabledLedger.baselineKey, null);
  assert.equal(disabledLedger.committedBytes, '0');
  assert.equal(disabledLedger.reservedBytes, '0');
  assert.equal(await disabledFixture.reserveCount(), 0);

  detail.scenario3 = { configurationConflict: 'QUOTA_CONFIGURATION_CONFLICT', ledgerUnchangedVersion: 0,
    epochMismatch: 'QUOTA_EPOCH_MISMATCH', operationConflict: 'QUOTA_OPERATION_CONFLICT', versionConflict: 'QUOTA_VERSION_CONFLICT',
    invalidLedger: 'INVALID_QUOTA_LEDGER', disabledState: 'disabled', disabledBaselineKey: null,
    disabledOmission: 'quota_unavailable', disabledReservations: 0 };
});

test('scenario 4+6 permission bypass and business effect: scoped reads stay isolated and degradation is declared', async t => {
  const f = await fixture(t); withQuota(t);
  const assetA = 'asset-a', assetB = 'asset-b';
  const publishedA = record('j'.repeat(10), assetA);
  await f.store.ingest(publishedA);
  const publishedB = record('k'.repeat(10), assetB);
  await f.store.ingest(publishedB);
  assert.equal((await f.status()).committedBytes, 20);
  const pressure = await f.reserve('in-flight-pressure', 900);
  assert.equal(pressure.status.budgetedBytes, 920);
  assert.equal(pressure.status.state, 'limited');
  const denied = record('l'.repeat(10), 'asset-c');
  await f.store.ingest(denied);
  const deniedBody = await request(f, denied);
  assert.equal(deniedBody.state, 'omitted');
  assert.equal(deniedBody.reason, 'quota_exhausted');
  assert.equal(deniedBody.metadata.observedBytes, 10);
  assert.equal(deniedBody.metadata.storedBytes, 0);
  const deniedRow = await invocation(f, denied);
  assert.equal(deniedRow.record.outcome, 'success');
  assert.equal(deniedRow.record.httpStatus, 200);
  await assert.rejects(f.settle('publish:' + '0'.repeat(64), { reason: 'confirmed_absent', committedBytes: 0 }),
    code('QUOTA_OPERATION_CONFLICT'));
  await assert.rejects(f.store.transaction(tx => f.quota.reserve(tx, randomUUID(), 'forged', 1)), code('QUOTA_EPOCH_MISMATCH'));
  const unchanged = await f.status();
  assert.equal(unchanged.committedBytes, 20);
  assert.equal(unchanged.reservedBytes, 900);
  assert.equal(unchanged.state, 'limited');

  const userA = account([assetA]);
  const service = new CallObservabilityPayloadsService(f.store, f.payloads, { log: async () => undefined },
    { findUserById: async id => { if (id !== userA.id) throw Object.assign(new Error('missing'), { getStatus: () => 404 }); return userA; } });
  const authorization = authorizeObservability(userA, ['monitoring:payload:read']);
  const own = await service.get(publishedA.invocationId, 'request', {}, authorization, randomUUID());
  assert.equal(own.data.state, 'captured');
  assert.equal(own.data.content, 'j'.repeat(10));
  assert.ok(!JSON.stringify(own).includes('k'.repeat(10)));
  await assert.rejects(service.get(publishedB.invocationId, 'request', {}, authorization, randomUUID()), code('NOT_FOUND'));
  const stillPressured = await f.status();
  assert.equal(stillPressured.committedBytes, 20);
  assert.equal(stillPressured.reservedBytes, 900);
  assert.equal(stillPressured.state, 'limited');

  detail.scenario4 = { pressuredBudgeted: 920, deniedReason: 'quota_exhausted',
    businessOutcome: deniedRow.record.outcome, forgedRelief: 'rejected', crossAssetRead: 'NOT_FOUND', authorizedRead: 'captured' };
});

test('scenario 5 pressure plus fault: every byte stays accounted and a complete proof settles once', async t => {
  const faulted = await fixture(t, { baselineBytes: 880 }); withQuota(t);
  const unlink = fs.unlink;
  fs.unlink = async file => {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('fixture temporary lock'), { code: 'EACCES' });
    return unlink(file);
  };
  const faultEvent = record('m'.repeat(10));
  try { await faulted.store.ingest(faultEvent); } finally { fs.unlink = unlink; }
  assert.equal((await request(faulted, faultEvent)).reason, 'quota_publication_uncertain');
  const faultRow = await invocation(faulted, faultEvent);
  assert.equal(faultRow.record.outcome, 'success');
  assert.equal(faultRow.record.httpStatus, 200);
  const faultIntent = await faulted.db.getRepository(entities.RuntimePayloadPublicationIntentEntity)
    .findOneOrFail({ where: {} });
  assert.equal((await faulted.db.getRepository(entities.RuntimePayloadQuotaReservationEntity)
    .findOneByOrFail({ id: faultIntent.reservationId })).state, 'uncertain');
  const held = await faulted.status();
  assert.equal(held.committedBytes, 880);
  assert.equal(held.reservedBytes, 20);
  assert.equal(held.state, 'degraded');
  const heldPhysical = await bodyBytes(faulted);
  assert.equal(heldPhysical, 20);
  assert.ok(held.reservedBytes >= 10 && held.committedBytes + held.reservedBytes >= heldPhysical);
  const blocked = record('n'.repeat(10));
  await faulted.store.ingest(blocked);
  assert.ok(['quota_unavailable', 'quota_exhausted'].includes((await request(faulted, blocked)).reason));
  await faulted.store.ingest(faultEvent);
  assert.deepEqual(await faulted.status(), held);
  assert.equal(await faulted.reserveCount(), 1);

  const f = await fixture(t); withQuota(t);
  const settle = PayloadQuotaPrimitives.prototype.settle;
  PayloadQuotaPrimitives.prototype.settle = function (tx, epoch, operation, outcome) {
    return settle.call(this, tx, epoch, operation,
      outcome.reason === 'confirmed_occupancy_and_unused_absent' ? { reason: 'unknown' } : outcome);
  };
  const event = record('o'.repeat(10));
  try { await f.store.ingest(event); } finally { PayloadQuotaPrimitives.prototype.settle = settle; }
  assert.equal((await request(f, event)).state, 'captured');
  const deferred = await f.status();
  assert.equal(deferred.committedBytes, 0);
  assert.equal(deferred.reservedBytes, 20);
  assert.equal(deferred.state, 'degraded');
  const deferredPhysical = await bodyBytes(f);
  assert.equal(deferredPhysical, 10);
  assert.ok(deferred.reservedBytes >= deferredPhysical);
  const intent = await f.db.getRepository(entities.RuntimePayloadPublicationIntentEntity).findOneOrFail({ where: {} });
  const reconciled = await new PayloadPublicationReconcileService(f.store, f.payloads).reconcile(intent.reservationId);
  assert.equal(reconciled.status, 'settled');
  const settled = await f.status();
  assert.equal(settled.committedBytes, 10);
  assert.equal(settled.reservedBytes, 0);
  assert.equal(settled.state, 'ready');
  assert.ok(settled.committedBytes + settled.reservedBytes >= await bodyBytes(f));
  assert.equal(await f.reserveCount(), 1);
  await f.store.ingest(event);
  assert.deepEqual(await f.status(), settled);
  assert.equal(await f.reserveCount(), 1);

  detail.scenario5 = { faultReason: 'quota_publication_uncertain', heldCommitted: 880, heldReserved: 20,
    heldPhysicalBytes: 20, settledCommitted: 10, settledReserved: 0, settledPhysicalBytes: 10,
    reservationRowsAfterReplay: 1, replayDelta: 0, undercountOrOversell: false };
  detail.scenario6 = { declaredOmission: 'quota_publication_uncertain', businessOutcome: faultRow.record.outcome,
    degradedState: 'degraded', recoveryStatus: reconciled.status, silentDrop: false };
});

after(() => { console.log('OBS_14_05D_DETAIL ' + JSON.stringify(detail)); });
