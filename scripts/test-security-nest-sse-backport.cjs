'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const root = path.resolve(process.env.API_NOVA_SECURITY_CANDIDATE_ROOT || path.join(__dirname, '..'));
const apiRequire = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const coreRequire = createRequire(apiRequire.resolve('@nestjs/core'));
const { SseStream } = coreRequire('./router/sse-stream');
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);

async function encode(messages) {
  const stream = new SseStream();
  let output = '';
  stream.on('data', chunk => { output += chunk.toString(); });
  const ended = once(stream, 'end');
  for (const message of messages) {
    await new Promise((resolve, reject) => stream.writeMessage({ ...message }, error => error ? reject(error) : resolve()));
  }
  stream.end();
  await ended;
  return output;
}

test('resolved Nest core is the reviewed backport and matches locked vendor bytes', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'vendor/nestjs-core-sse-backport.json')));
  assert.equal(coreRequire('./package.json').version, '10.4.22');
  assert.equal(hash(fs.readFileSync(coreRequire.resolve('./router/sse-stream'))), provenance.patchedFileSha256);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/@nestjs/core'));
  assert.equal(entries.length, 1, 'all Nest consumers must share the patched core');
  const bytes = fs.readFileSync(path.join(root, provenance.archive));
  assert.equal(entries[0][1].resolved, `file:${provenance.archive}`);
  assert.equal(entries[0][1].integrity, `sha512-${hash(bytes, 'sha512', 'base64')}`);
  assert.equal(hash(bytes), provenance.archiveSha256);
  for (const name of ['@nestjs/platform-express', '@nestjs/platform-socket.io', '@nestjs/websockets', '@nestjs/swagger']) {
    const consumer = createRequire(apiRequire.resolve(name));
    assert.equal(consumer.resolve('@nestjs/core'), apiRequire.resolve('@nestjs/core'), `${name} must consume the backport`);
  }
});

test('normal SSE payloads, multiline data, JSON data and generated IDs are preserved', async () => {
  assert.equal(await encode([
    { type: 'update', id: 'stable-1', retry: 1500, data: 'first\r\nsecond\rthird\nfourth' },
    { data: { status: 'ready', count: 2 } },
    { data: 'done' },
  ]), 'event: update\nid: stable-1\nretry: 1500\ndata: first\ndata: second\ndata: third\ndata: fourth\n\nid: 1\ndata: {"status":"ready","count":2}\n\nid: 2\ndata: done\n\n');
});

test('CR, LF and CRLF in type/id/retry cannot create a new field or event', async () => {
  for (const delimiter of ['\r', '\n', '\r\n']) {
    for (const [key, prefix] of [['type', 'event'], ['id', 'id'], ['retry', 'retry']]) {
      const message = { type: 'safe', id: 'stable', retry: 1500, data: 'payload', [key]: `prefix${delimiter}${delimiter}event: forged${delimiter}data: forged` };
      const output = await encode([message]);
      assert(!output.includes('\r'));
      assert.equal(output.split('\n\n').length, 2, 'exactly one event must be emitted');
      assert.equal(output.split('\n').filter(line => line.startsWith('event: ')).length, 1);
      assert.equal(output.split('\n').filter(line => line.startsWith('data: ')).length, 1);
      assert(output.includes(`${prefix}: prefixevent: forgeddata: forged\n`));
      assert(output.endsWith('data: payload\n\n'));
    }
  }
});

test('a real Nest HTTP SSE route sanitizes upstream fields and closes normally', { timeout: 10000 }, async () => {
  apiRequire('reflect-metadata');
  const { Controller, Module, Sse } = apiRequire('@nestjs/common');
  const { NestFactory } = apiRequire('@nestjs/core');
  const { of } = apiRequire('rxjs');
  class EventsController {
    events() { return of({ type: 'update\n\nevent: forged', id: 'cursor\r\nid: forged', data: 'safe' }, { data: { ok: true } }); }
  }
  Controller('security-sse')(EventsController);
  Sse()(EventsController.prototype, 'events', Object.getOwnPropertyDescriptor(EventsController.prototype, 'events'));
  class EventsModule {}
  Module({ controllers: [EventsController] })(EventsModule);
  const app = await NestFactory.create(EventsModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/security-sse`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(await response.text(), '\nevent: updateevent: forged\nid: cursorid: forged\ndata: safe\n\nid: 1\ndata: {"ok":true}\n\n');
  } finally {
    await app.close();
  }
});

test('backport builder rejects altered or unreviewed upstream archives', () => {
  const { buildBackport } = require('./build-nest-sse-backport.cjs');
  assert.throws(() => buildBackport(Buffer.from('untrusted archive')), /Unexpected upstream archive/);
});

test('build gate rejects stale installed core before invoking any package build', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const base = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(base, 'api-nova-sse-gate-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'packages/api-nova-api'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'node_modules/@nestjs/core/router'), { recursive: true });
    fs.cpSync(path.join(root, 'vendor'), path.join(fixture, 'vendor'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(fixture, 'package-lock.json'));
    for (const file of ['build.js', 'verify-nest-sse-backport.cjs']) {
      fs.copyFileSync(path.join(__dirname, file), path.join(fixture, 'scripts', file));
    }
    fs.writeFileSync(path.join(fixture, 'packages/api-nova-api/package.json'), '{"name":"api-nova-api"}');
    fs.writeFileSync(path.join(fixture, 'node_modules/@nestjs/core/package.json'), '{"name":"@nestjs/core","version":"10.4.22"}');
    fs.writeFileSync(path.join(fixture, 'node_modules/@nestjs/core/router/sse-stream.js'), '// stale same-version registry bytes');
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/build.js')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Installed Nest core is stale or modified/);
    assert.match(result.stderr, /npm ci/);
    assert(!result.stdout.includes('Starting monorepo build'));
    const { verifyNestSseBackport } = require('./verify-nest-sse-backport.cjs');
    verifyNestSseBackport(fixture, { archiveOnly: true });
    const provenance = JSON.parse(fs.readFileSync(path.join(fixture, 'vendor/nestjs-core-sse-backport.json')));
    fs.appendFileSync(path.join(fixture, provenance.archive), 'modified');
    assert.throws(() => verifyNestSseBackport(fixture, { archiveOnly: true }), /Archive differs from dependency lock/);
  } finally {
    assert(path.resolve(fixture).startsWith(base + path.sep));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
