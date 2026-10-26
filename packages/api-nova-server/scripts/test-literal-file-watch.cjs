'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../package.json'));
const chokidar = serverRequire('chokidar');
const originalWatch = chokidar.watch;
const live = [];
// Observe readiness and guarantee cleanup while using real production watchers.
function captureWatch(...args) {
  const watcher = originalWatch(...args);
  const ready = new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
  live.push({ watcher, ready });
  return watcher;
}
chokidar.watch = captureWatch;
chokidar.default.watch = captureWatch;
const { watchOpenAPIFile } = require('../dist/cli/openapi');
const { ConfigManager } = require('../dist/interactive-cli/utils/config-manager');
const base = path.resolve(__dirname, '../../../.tmp');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Watcher event timeout'); await delay(25); }
}
async function fixture(run) {
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'security-watch-'));
  try { await run(directory); }
  finally {
    for (const { watcher } of live.splice(0)) await watcher.close();
    assert.equal(path.dirname(directory), base);
    assert.ok(path.basename(directory).startsWith('security-watch-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test('server resolves the non-glob CJS watcher with only readdirp as its dependency', () => {
  const manifest = require(path.join(path.dirname(serverRequire.resolve('chokidar')), 'package.json'));
  assert.equal(manifest.version, '4.0.3');
  assert.deepEqual(Object.keys(manifest.dependencies), ['readdirp']);
});
for (const [filename, sibling] of [
  ['spec[1].json', 'spec1.json'],
  ['spec{one,two}.json', 'specone.json'],
  ['{'.repeat(64) + 'spec' + '}'.repeat(64) + '.json', 'spec.json'],
]) {
  test(`OpenAPI watches the literal filename ${filename.slice(0, 35)}, preserves stable-write restart, and closes`, { timeout: 10000 }, () => fixture(async directory => {
    const file = path.join(directory, filename), other = path.join(directory, sibling);
    await fs.writeFile(file, '{}'); await fs.writeFile(other, '{}');
    const seen = [];
    watchOpenAPIFile(file, () => { seen.push(require('node:fs').readFileSync(file, 'utf8')); });
    assert.equal(live.length, 1); await live[0].ready;
    await fs.writeFile(other, '{"other":true}'); await delay(450);
    assert.equal(seen.length, 0, 'glob-shaped sibling must not trigger restart');
    await fs.writeFile(file, '{"complete":'); await delay(100); await fs.appendFile(file, 'true}');
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['{"complete":true}']);
    assert.equal(live[0].watcher.closed, true, 'restart closes the one-shot watcher');
    await fs.writeFile(file, '{}'); await delay(450);
    assert.equal(seen.length, 1);
  }));
}
test('OpenAPI keeps atomic editor-save restart behavior', { timeout: 10000 }, () => fixture(async directory => {
  const file = path.join(directory, 'atomic{1,2}.json'), staged = path.join(directory, 'saving.tmp');
  await fs.writeFile(file, '{}'); let calls = 0;
  watchOpenAPIFile(file, () => calls++); await live[0].ready;
  await fs.writeFile(staged, '{"saved":true}'); await fs.rename(staged, file);
  await until(() => calls === 1);
  assert.equal(live[0].watcher.closed, true);
}));
test('remote specifications do not create a local watcher', () => {
  watchOpenAPIFile('https://example.invalid/spec.json', () => assert.fail('remote watcher callback'));
  assert.equal(live.length, 0);
});
test('interactive config watches a literal directory and keeps old/new callbacks and unsubscribe', { timeout: 10000 }, () => fixture(async directory => {
  const configDirectory = path.join(directory, 'config{one,two}[1]');
  const manager = new ConfigManager();
  // JS access redirects the real Conf storage; no user home configuration is touched.
  manager.configPath = configDirectory;
  const initial = await manager.getConfig();
  const seen = [];
  const stop = await manager.onConfigChange((next, previous) => seen.push({ next, previous }));
  assert.equal(live.length, 1); await live[0].ready;
  await manager.set('defaultPort', initial.defaultPort + 1);
  await until(() => seen.length === 1);
  assert.equal(seen[0].previous.defaultPort, initial.defaultPort);
  assert.equal(seen[0].next.defaultPort, initial.defaultPort + 1);
  // Separate completed writes beyond chokidar's duplicate-event throttle.
  await delay(150);
  await manager.set('defaultPort', initial.defaultPort + 2);
  await until(() => seen.length === 2);
  assert.equal(seen[1].previous.defaultPort, initial.defaultPort + 1);
  assert.equal(seen[1].next.defaultPort, initial.defaultPort + 2);
  await stop();
  assert.equal(live[0].watcher.closed, true);
  await manager.set('defaultPort', initial.defaultPort + 3); await delay(350);
  assert.equal(seen.length, 2);
}));
