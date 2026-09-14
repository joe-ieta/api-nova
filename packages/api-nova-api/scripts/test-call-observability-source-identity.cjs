'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { matchesOpenedSource } = require('../dist/src/modules/call-observability/call-observability-source-identity.js');
const stat = (changes = {}) => ({ dev: 27, ino: 123, birthtimeMs: 42.5, nlink: 1,
  isFile: () => true, isSymbolicLink: () => false, ...changes });

test('matching complete identities need no extra open', async t => {
  t.mock.method(fs, 'open', async () => { throw new Error('unexpected open'); });
  assert.equal(await matchesOpenedSource('fixture', stat(), stat(), 'win32'), true);
});

test('missing Windows path volume requires corroboration and closes the handle', async t => {
  let closed = 0;
  t.mock.method(fs, 'open', async () => ({ stat: async () => stat(), close: async () => { closed++; } }));
  t.mock.method(fs, 'lstat', async () => stat({ dev: 0 }));
  assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'win32'), true);
  assert.equal(closed, 1);
});

test('non-Windows and conflicting nonzero devices never take the fallback', async t => {
  t.mock.method(fs, 'open', async () => { throw new Error('unexpected open'); });
  assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'linux'), false);
  assert.equal(await matchesOpenedSource('fixture', stat({ dev: 28 }), stat(), 'win32'), false);
  assert.equal(await matchesOpenedSource('fixture', stat(), stat({ dev: 0 }), 'win32'), false);
});

test('inode, birth time, hard links and symbolic links remain rejected', async t => {
  t.mock.method(fs, 'open', async () => { throw new Error('unexpected open'); });
  for (const changes of [{ ino: 456 }, { birthtimeMs: 43 }, { nlink: 2 },
    { isSymbolicLink: () => true }, { isFile: () => false }, { ino: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0, ...changes }), stat(), 'win32'), false);
    assert.equal(await matchesOpenedSource('fixture', stat(), stat(changes), 'win32'), false);
  }
});

test('second handle cannot confirm a different device or inode', async t => {
  let confirmed = stat({ dev: 28 }), closed = 0;
  t.mock.method(fs, 'open', async () => ({ stat: async () => confirmed, close: async () => { closed++; } }));
  t.mock.method(fs, 'lstat', async () => stat({ dev: 0 }));
  assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'win32'), false);
  confirmed = stat({ ino: 456 });
  assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'win32'), false);
  assert.equal(closed, 2);
});

test('replacement and links during confirmation are rejected', async t => {
  let current;
  t.mock.method(fs, 'open', async () => ({ stat: async () => stat(), close: async () => {} }));
  t.mock.method(fs, 'lstat', async () => current);
  for (const changes of [{ ino: 456 }, { dev: 28 }, { nlink: 2 }, { isSymbolicLink: () => true }]) {
    current = stat({ dev: 0, ...changes });
    assert.equal(await matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'win32'), false);
  }
});

test('failed path recheck propagates and still closes confirmation handle', async t => {
  let closed = 0;
  t.mock.method(fs, 'open', async () => ({ stat: async () => stat(), close: async () => { closed++; } }));
  t.mock.method(fs, 'lstat', async () => { throw new Error('fixture failure'); });
  await assert.rejects(matchesOpenedSource('fixture', stat({ dev: 0 }), stat(), 'win32'), /fixture failure/);
  assert.equal(closed, 1);
});

test('large Windows file ids are compared exactly instead of rounded Numbers', async t => {
  const exact = BigInt('19984723371166351');
  const large = stat({ ino: Number(exact) });
  const precise = (ino = exact, dev = BigInt(27)) => ({ ...stat(), ino, dev,
    birthtimeNs: BigInt(42500000), nlink: BigInt(1) });
  let confirmed = precise();
  t.mock.method(fs, 'open', async () => ({ stat: async () => confirmed, close: async () => {} }));
  t.mock.method(fs, 'lstat', async () => precise(exact, BigInt(0)));
  const original = { stat: async () => precise() };
  assert.equal(await matchesOpenedSource('fixture', { ...large, dev: 0 }, large, 'win32', original), true);
  confirmed = precise(exact + BigInt(1));
  assert.equal(await matchesOpenedSource('fixture', { ...large, dev: 0 }, large, 'win32', original), false);
});
