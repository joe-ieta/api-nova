'use strict';
// Consumer-chain and bounded lifecycle regressions; all HTTP stays on loopback.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { deflateSync, gzipSync } = require('node:zlib');
const root = path.resolve(process.env.API_NOVA_SECURITY_CANDIDATE_ROOT || path.join(__dirname, '..'));
const api = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const consumer = (req, name) => createRequire(req.resolve(name));
const platform = consumer(api, '@nestjs/platform-express');
const sdk = consumer(api, '@modelcontextprotocol/sdk/server/streamableHttp.js');
function version(req, name, expected) {
  let directory = path.dirname(req.resolve(name));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name === name) return assert.equal(metadata.version, expected, name);
    }
    directory = path.dirname(directory);
  }
  assert.fail(`Missing metadata: ${name}`);
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('Nest, MCP SDK, Axios and TypeORM consumers resolve the intended security patches', () => {
  version(platform, 'multer', '2.5.0');
  version(api, 'multer', '2.5.0');
  for (const req of [platform, consumer(platform, 'express'), consumer(api, 'express')]) {
    version(req, 'body-parser', '1.20.9');
  }
  version(consumer(sdk, 'express'), 'body-parser', '2.4.0');
  version(consumer(api, 'axios'), 'follow-redirects', '1.16.2');
  for (const name of ['api', 'server', 'parser', 'ui']) {
    const req = createRequire(path.join(root, `packages/api-nova-${name}/package.json`));
    version(consumer(req, 'axios'), 'follow-redirects', '1.16.2');
  }
  version(api, 'typeorm', '0.3.31');
  // A nested stale package must fail even when a patched root copy exists.
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const expected = { multer: '2.5.0', 'follow-redirects': '1.16.2', typeorm: '0.3.31' };
  for (const [location, item] of Object.entries(lock.packages)) {
    const name = location.split('node_modules/').at(-1);
    const target = name === 'body-parser' ? (item.version.startsWith('1.') ? '1.20.9' : '2.4.0') : expected[name];
    if (target) assert.equal(item.version, target, location);
  }
});

for (const [name, req] of [['Nest', platform], ['MCP SDK', consumer(sdk, 'express')]]) {
  test(`${name} body parser destroys completed decoders before trailing bytes arrive`, { timeout: 5000 }, async () => {
    for (const [encoding, compress] of [['deflate', deflateSync], ['gzip', gzipSync]]) {
      const request = new PassThrough();
      const payload = compress(Buffer.from('{"safe":true}'));
      request.headers = { 'content-type': 'application/json', 'content-encoding': encoding, 'transfer-encoding': 'chunked' };
      let decoder;
      const originalPipe = request.pipe;
      request.pipe = function (destination, ...args) {
        decoder = destination;
        return originalPipe.call(this, destination, ...args);
      };
      const parsed = new Promise((resolve, reject) => req('body-parser').json()(request, {}, error => error ? reject(error) : resolve()));
      request.end(payload);
      try {
        await parsed;
        assert.deepEqual(request.body, { safe: true });
        assert.equal(decoder.destroyed, true, encoding + ' decoder must be destroyed after successful parsing');
        assert.equal(decoder.listenerCount('error') > 0, true, 'late decompression errors must remain handled');
        // Models a late error after raw-body has removed its callback listeners.
        decoder.emit('error', new Error('synthetic trailing compressed bytes'));
      } finally { request.destroy(); decoder?.destroy(); }
    }
  });
}

test('Nest FileInterceptor handles valid uploads and ignores a fileFilter completing after abort', { timeout: 5000 }, async () => {
  const { FileInterceptor } = api('@nestjs/platform-express');
  const body = Buffer.from('--safe-boundary\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\npayload\r\n--safe-boundary--\r\n');
  const context = request => ({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) });
  const request = () => {
    const req = new PassThrough();
    req.headers = { 'content-type': 'multipart/form-data; boundary=safe-boundary', 'content-length': String(body.length) };
    return req;
  };
  const Valid = FileInterceptor('file');
  const valid = request();
  try {
    const completed = new Valid().intercept(context(valid), { handle: () => 'accepted' });
    valid.end(body);
    assert.equal(await completed, 'accepted');
    assert.equal(valid.file.buffer.toString(), 'payload');
  } finally { valid.destroy(); }
  let releaseFilter, notifyFilter, writes = 0, continued = false;
  const entered = new Promise(resolve => { notifyFilter = resolve; });
  const Pending = FileInterceptor('file', {
    fileFilter(_req, _file, callback) { releaseFilter = callback; notifyFilter(); },
    storage: {
      _handleFile(_req, file, callback) { writes++; file.stream.resume(); callback(null, {}); },
      _removeFile(_req, _file, callback) { callback(); },
    },
  });
  const aborted = request();
  let busboy;
  const originalPipe = aborted.pipe;
  aborted.pipe = function (destination, ...args) {
    busboy = destination;
    return originalPipe.call(this, destination, ...args);
  };
  const completed = new Pending().intercept(context(aborted), { handle() { continued = true; } });
  const rejected = assert.rejects(completed, /abort|close/i);
  try {
    aborted.write(body);
    await entered;
    aborted.destroy();
    await rejected;
    await turn();
    assert.equal(busboy.listenerCount('error') > 0, true, 'busboy must still handle errors after request teardown');
    assert.doesNotThrow(() => busboy.emit('error', new Error('synthetic late multipart error')));
    releaseFilter(null, true);
    await turn();
    assert.equal(writes, 0, 'late filter callback must not start storage after teardown');
    assert.equal(continued, false);
  } finally { aborted.destroy(); }
});

test('Axios redirect chain strips array credentials and treats custom sensitive header names literally', { timeout: 5000 }, async () => {
  const redirects = consumer(api, 'axios')('follow-redirects').http;
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/source') {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/target` });
      res.end();
    } else { received.push(req.headers); res.end('ok'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { hostname: 'localhost', port: server.address().port, path: '/source',
    lookup(_host, _options, callback) { callback(null, [{ address: '127.0.0.1', family: 4 }]); } };
  const get = extra => new Promise((resolve, reject) => {
    redirects.get({ ...options, ...extra }, response => {
      response.resume(); response.on('end', resolve); response.on('error', reject);
    }).on('error', reject);
  });
  try {
    await get({ headers: ['Authorization', 'Bearer synthetic', 'Cookie', 'session=synthetic'] });
    assert.equal(received.length, 1, 'array-form headers must produce a valid request through the redirect');
    assert.equal(received[0].authorization, undefined);
    assert.equal(received[0].cookie, undefined);
    await get({ headers: { 'x-api.key': 'sensitive', 'x-apiXkey': 'public' }, sensitiveHeaders: ['x-api.key'] });
    assert.equal(received[1]['x-api.key'], undefined);
    assert.equal(received[1]['x-apixkey'], 'public', 'a dot in a header name must not become a regex wildcard');
    await get({ headers: { 'x-api.key': 'sensitive' }, sensitiveHeaders: ['x-api.key', 'x-missing'] });
    assert.equal(received[2]['x-api.key'], undefined);
  } finally { await close(server); }
});

test('TypeORM generated migration SQL preserves interpolation markers, backticks and backslashes as data', () => {
  const { MigrationGenerateCommand: command } = api('typeorm/commands/MigrationGenerateCommand');
  const sql = "SELECT '${globalThis.securityProbe = true}', `quoted`, '\\${value}'";
  const line = 'await queryRunner.query(`' + command.escapeTemplateLiteral(sql) + '`);';
  const code = command.getJavascriptTemplate('safe', 1234567890000, [line], [line], false);
  const context = { module: { exports: {} }, securityProbe: false };
  vm.runInNewContext(code, context, { timeout: 1000 });
  const migration = new context.module.exports();
  const queries = [];
  const runner = { query(value) { queries.push(value); } };
  return Promise.resolve().then(() => migration.up(runner)).then(() => migration.down(runner)).then(() => {
    assert.deepEqual(queries, [sql, sql]);
    assert.equal(context.securityProbe, false);
  });
});
