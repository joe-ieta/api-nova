'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const root = process.env.OBS_EVENTS_SOURCE === '1' ? '../src/' : '../dist/src/';
if (process.env.OBS_EVENTS_SOURCE === '1') require('ts-node').register({ transpileOnly: true,
  compilerOptions: { module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true } });
const { CALL_OBSERVABILITY_ENTITIES } = require(root + 'database/entities/runtime-call-observability.entity');
const { RuntimeObservabilityEventEntity } = require(root + 'database/entities/runtime-observability-event.entity');
const { CallObservabilityStore } = require(root + 'modules/call-observability/call-observability.store');
const { ObservabilityCursorService } = require(root + 'modules/call-observability/call-observability-cursor.service');
const { CallObservabilityEventsService } = require(root + 'modules/call-observability/call-observability-events.service');
const { contentHash } = require(root + 'modules/call-observability/call-observability-storage');
const scope = assets => ({ principalId: 'reader', runtimeAssetIds: assets, requiredPermissions: ['monitoring:read'],
  fingerprint: contentHash(JSON.stringify(assets)) });
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const store = new CallObservabilityStore(db, {});
  const cursors = new ObservabilityCursorService(new ConfigService({ API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'x'.repeat(64) }));
  const service = new CallObservabilityEventsService(store, cursors);
  const insert = (asset, extra = {}) => store.transaction(async tx => {
    const sequence = tx.nextSequence();
    await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert({ id: randomUUID(), sequence,
      runtimeAssetId: asset, eventName: 'invocation.completed', eventFamily: 'runtime.request',
      occurredAt: new Date(tx.now), createdAt: new Date(tx.now), expiresAt: new Date(Date.now() + 86400000),
      subjectId: randomUUID(), subjectVersion: 1, dimensions: { serverType: 'gateway' },
      details: { spanKind: 'gateway_request', outcome: 'success', headers: { authorization: 'SECRET' }, traceId: 'HIDDEN-TRACE' }, ...extra });
  });
  return { db, store, cursors, service, insert };
}
test('authorized stable scan paginates across filtered empty pages and catches up after draining', async t => {
  const f = await fixture(t), auth = scope(['a']);
  await f.insert('a'); await f.insert('b'); await f.insert('a', { severity: 'error' });
  const first = (await f.service.list({ limit: '1', severities: 'error' }, auth)).data;
  assert.deepEqual(first.items, []); assert.equal(first.hasMore, true); assert.equal(first.highWatermark, '3');
  await f.insert('a', { severity: 'error' });
  const second = (await f.service.list({ after: first.nextCursor, limit: '1' }, auth)).data;
  assert.equal(second.items[0].sequence, '3'); assert.equal(second.hasMore, false); assert.equal(second.highWatermark, '3');
  const third = (await f.service.list({ after: second.nextCursor }, auth)).data;
  assert.equal(third.items[0].sequence, '4');
  assert.equal(JSON.stringify(third).includes('SECRET'), false); assert.equal(JSON.stringify(third).includes('HIDDEN-TRACE'), false);
});
test('hidden and asset-less events do not affect scoped pagination or watermarks', async t => {
  const f = await fixture(t); await f.insert('a');
  const before = (await f.service.list({}, scope(['a']))).data;
  await f.insert('b', { expiresAt: new Date(0) }); await f.insert(undefined);
  const after = (await f.service.list({}, scope(['a']))).data;
  assert.equal(before.highWatermark, after.highWatermark); assert.equal(after.items.length, 1);
  const empty = (await f.service.list({}, scope([]))).data;
  assert.equal(empty.highWatermark, '0'); assert.deepEqual(empty.items, []);
});
test('cursor rejects forged tokens, filter or authorization changes and unproven snapshots', async t => {
  const f = await fixture(t); await f.insert('a');
  const page = (await f.service.list({}, scope(['a']))).data;
  for (const [query, auth, code] of [
    [{ after: page.nextCursor + 'x' }, scope(['a']), 'INVALID_QUERY'],
    [{ after: page.nextCursor, severities: 'error' }, scope(['a']), 'CURSOR_SCOPE_MISMATCH'],
    [{ after: page.nextCursor }, scope(['b']), 'CURSOR_SCOPE_MISMATCH'],
    [{ afterSequence: '0' }, scope(['a']), 'CURSOR_SCOPE_MISMATCH'],
    [{ after: page.nextCursor, afterSequence: '0' }, scope(['a']), 'INVALID_QUERY'],
    [{ limit: ['1', '2'] }, scope(['a']), 'INVALID_QUERY'],
  ]) await assert.rejects(f.service.list(query, auth), error => error.code === code);
});
test('retention loss returns a scoped recovery cursor rather than skipping missing history', async t => {
  const f = await fixture(t), auth = scope(['a']);
  const empty = (await f.service.list({}, auth)).data;
  await f.insert('a', { expiresAt: new Date(0) }); await f.insert('a');
  await assert.rejects(f.service.list({ after: empty.nextCursor }, auth), error => {
    assert.equal(error.code, 'EVENT_CURSOR_EXPIRED'); assert.ok(error.earliestAvailableCursor); return true;
  });
  assert.equal((await f.service.list({}, auth)).data.items[0].sequence, '2');
});
test('until is exclusive of later events and survives fresh service instances', async t => {
  const f = await fixture(t), auth = scope(['a']); await f.insert('a');
  const until = (await f.service.list({}, auth)).data.nextCursor; await f.insert('a');
  const restarted = new CallObservabilityEventsService(f.store, f.cursors);
  const page = (await restarted.list({ until }, auth)).data;
  assert.deepEqual(page.items.map(item => item.sequence), ['1']); assert.equal(page.highWatermark, '1');
});
test('event filters support canonical multi-values and exact scalar tool names', async t => {
  const f = await fixture(t), auth = scope(['a']);
  await f.insert('a', { dimensions: { serverType: 'mcp', toolName: 'tool,one' } });
  assert.equal((await f.service.list({ toolName: 'tool,one', severities: 'error,info,warning' }, auth)).data.items.length, 1);
  assert.equal((await f.service.list({ toolName: 'tool' }, auth)).data.items.length, 0);
  // Exercise the durable revision fallback query for legacy events lacking toolName.
  await f.insert('a');
  assert.equal((await f.service.list({ toolName: 'missing' }, auth)).data.items.length, 0);
});
test('expired signed cursors provide safe recovery, and approved snapshot starts bind to filters', async t => {
  const f = await fixture(t), auth = scope(['a']);
  const binding = { kind: 'event', endpoint: 'obsListEvents', sort: 'sequence:asc', authorization: auth };
  const token = f.cursors.issue(binding, { filter: {}, snapshotSeq: '0', position: { sequence: '0' } }, 1000);
  const now = Date.now;
  Date.now = () => now() + 2000;
  try { await assert.rejects(f.service.list({ after: token }, auth), error => error.code === 'EVENT_CURSOR_EXPIRED' && !!error.earliestAvailableCursor); }
  finally { Date.now = now; }
  const approved = new CallObservabilityEventsService(f.store, f.cursors, { authorize: async (seq, current, filter) =>
    seq === '0' && current.fingerprint === auth.fingerprint && filter.serverType === 'gateway' });
  await f.insert('a');
  assert.equal((await approved.list({ afterSequence: '0', serverType: 'gateway' }, auth)).data.items.length, 1);
});
test('initial history includes retained events below an interleaved expiry boundary', async t => {
  const f = await fixture(t), auth = scope(['a']);
  const before = (await f.service.list({}, auth)).data.nextCursor;
  await f.insert('a');
  await f.insert('a', { expiresAt: new Date(0) });
  await f.insert('a');
  const initial = (await f.service.list({}, auth)).data;
  assert.deepEqual(initial.items.map(item => item.sequence), ['1', '3']);
  assert.equal(initial.hasMore, false);
  // An actual continuation must still report retention loss instead of silently jumping it.
  await assert.rejects(f.service.list({ after: before }, auth), error => error.code === 'EVENT_CURSOR_EXPIRED');
  const first = (await f.service.list({ limit: '1' }, auth)).data;
  assert.deepEqual(first.items.map(item => item.sequence), ['1']);
  assert.equal(first.hasMore, true);
  await assert.rejects(f.service.list({ after: first.nextCursor }, auth), error => error.code === 'EVENT_CURSOR_EXPIRED');
  // until alone is an initial bounded read, not a continuation.
  assert.deepEqual((await f.service.list({ until: initial.nextCursor }, auth)).data.items.map(item => item.sequence), ['1', '3']);
});
test('event presentation exposes bounded safe toolName values only', async t => {
  const f = await fixture(t), auth = scope(['a']);
  await f.insert('a', { dimensions: { serverType: 'mcp', toolName: 'safe-tool' } });
  await f.insert('a', { details: { toolName: 'detail-tool' } });
  await f.insert('a', { dimensions: { toolName: 'x'.repeat(241) } });
  await f.insert('a', { dimensions: { toolName: 'bad\nname' } });
  await f.insert('a', { dimensions: { toolName: { secret: 'SECRET' } } });
  const items = (await f.service.list({}, auth)).data.items;
  assert.deepEqual(items.map(item => item.data.toolName), ['safe-tool', 'detail-tool', undefined, undefined, undefined]);
});
test('optional origin filters are exact, validated and bound to event cursors; omission keeps all origins', async t => {
  const f = await fixture(t), auth = scope(['a']);
  for (const origin of ['external', 'test', 'probe', 'internal']) {
    await f.insert('a', { dimensions: { origin, serverType: 'gateway' } });
  }
  await f.insert('a');
  assert.equal((await f.service.list({}, auth)).data.items.length, 5);
  for (const [index, origin] of ['external', 'test', 'probe', 'internal'].entries()) {
    const data = (await f.service.list({ origin }, auth)).data;
    assert.deepEqual(data.items.map(item => item.sequence), [String(index + 1)]);
  }
  await assert.rejects(f.service.list({ origin: 'external,test' }, auth), error => error.code === 'INVALID_QUERY');
  await assert.rejects(f.service.list({ origin: 'unknown' }, auth), error => error.code === 'INVALID_QUERY');
  const page = (await f.service.list({ origin: 'external', limit: '1' }, auth)).data;
  await assert.rejects(f.service.list({ after: page.nextCursor, origin: 'test' }, auth), error => error.code === 'CURSOR_SCOPE_MISMATCH');
  assert.deepEqual((await f.service.list({ after: page.nextCursor }, auth)).data.items, []);
});
