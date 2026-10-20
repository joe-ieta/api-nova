'use strict';
// Local synthetic regression only. Run with Node 24; no remote service is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const http = require('node:http');
const zlib = require('node:zlib');
const semver = require('semver');
const root = path.resolve(__dirname, '..');
const api = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const ui = createRequire(path.join(root, 'packages/api-nova-ui/package.json'));

function version(loader, name) {
  let directory = path.dirname(loader.resolve(name));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name === name) return metadata.version;
    }
    directory = path.dirname(directory);
  }
  throw Error(`Missing metadata: ${name}`);
}
const consumer = (loader, name) => createRequire(loader.resolve(name));
function atLeast(loader, name, minimum) {
  const actual = version(loader, name);
  assert(semver.gte(actual, minimum), `${name}: ${actual} < ${minimum}`);
}
async function listening(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('actual consumers resolve patched nested dependencies, not just root copies', () => {
  atLeast(api, 'compression', '1.8.2');
  atLeast(consumer(api, 'express'), 'proxy-addr', '2.0.8');
  atLeast(consumer(api, '@nestjs/platform-express'), 'multer', '2.4.0');
  atLeast(consumer(api, '@nestjs/swagger'), 'js-yaml', '4.3.2');
  atLeast(consumer(api, '@nestjs/swagger'), 'lodash', '4.18.1');
  atLeast(consumer(api, '@nestjs/config'), 'lodash', '4.18.1');
  atLeast(consumer(api, 'socket.io'), 'engine.io', '6.6.10');
  atLeast(consumer(api, 'socket.io'), 'socket.io-parser', '4.2.7');
  atLeast(consumer(ui, 'socket.io-client'), 'socket.io-parser', '4.2.7');
  atLeast(consumer(require, 'concurrently'), 'shell-quote', '1.11.0');
  atLeast(api, 'joi', '17.13.8');
  const sdk = consumer(api, '@modelcontextprotocol/sdk/server/streamableHttp.js');
  atLeast(sdk, '@hono/node-server', '1.19.17');
  assert.equal(semver.major(version(sdk, '@hono/node-server')), 1);
  assert.equal(typeof api('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport, 'function');
  for (const workspace of ['api', 'parser', 'server', 'ui']) {
    const loader = createRequire(path.join(root, `packages/api-nova-${workspace}/package.json`));
    atLeast(loader, 'axios', '1.20.0');
    atLeast(loader, 'js-yaml', '4.3.2');
  }
});

test('all installed copies of the selected patched families agree with the lock', () => {
  const floors = {
    'proxy-addr': '2.0.8', compression: '1.8.2', 'engine.io': '6.6.10',
    'socket.io-parser': '4.2.7', multer: '2.4.0', axios: '1.20.0',
    lodash: '4.18.1', 'shell-quote': '1.11.0', handlebars: '4.7.10',
    joi: '17.13.8', figlet: '1.11.3',
  };
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  let checked = 0;
  for (const [location, metadata] of Object.entries(lock.packages)) {
    const name = location.split('node_modules/').at(-1);
    if (!floors[name]) continue;
    assert(semver.gte(metadata.version, floors[name]), `${location}: stale lock version ${metadata.version}`);
    const actual = JSON.parse(fs.readFileSync(path.join(root, location, 'package.json'), 'utf8'));
    assert.equal(actual.version, metadata.version, `${location}: installation differs from lock`);
    checked++;
  }
  assert(checked >= Object.keys(floors).length);
});

test('compression emits valid gzip and closes the real zlib stream on client abort', { timeout: 15000 }, async () => {
  const streams = [], original = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  Object.defineProperty(zlib, 'createGzip', { ...original, value(...args) {
    const stream = original.value(...args);
    streams.push(stream);
    return stream;
  } });
  const express = api('express'), compression = api('compression');
  const app = express();
  app.use(compression({ threshold: 0 }));
  app.get('/normal', (_req, res) => res.type('text').send('synthetic-response'));
  app.get('/abort', (_req, res) => {
    res.type('text').write('synthetic-stream');
    res.flush();
  });
  const server = http.createServer(app);
  let client;
  try {
    const base = await listening(server);
    const response = await new Promise((resolve, reject) => {
      http.get(`${base}/normal`, { headers: { 'accept-encoding': 'gzip' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(response.encoding, 'gzip');
    assert.equal(zlib.gunzipSync(response.body).toString(), 'synthetic-response');
    await new Promise((resolve, reject) => {
      client = http.get(`${base}/abort`, { headers: { 'accept-encoding': 'gzip' } }, res => {
        res.once('data', () => {
          const stream = streams.at(-1);
          stream.once('close', resolve);
          res.destroy(); client.destroy();
        });
      });
      client.on('error', reject);
    });
    assert.equal(streams.length, 2);
    assert.equal(streams.at(-1).destroyed, true);
  } finally {
    client?.destroy();
    await close(server);
    Object.defineProperty(zlib, 'createGzip', original);
  }
});

test('Socket.IO polling upgrades to websocket and round-trips binary attachments', { timeout: 15000 }, async () => {
  const { Server } = api('socket.io'), { io } = ui('socket.io-client');
  const server = http.createServer();
  const socketServer = new Server(server, { transports: ['polling', 'websocket'], allowEIO3: true });
  socketServer.on('connection', socket => socket.on('np02', (data, ack) => ack(data)));
  let client;
  try {
    const base = await listening(server);
    client = io(base, { transports: ['polling', 'websocket'], reconnection: false });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const echoed = await new Promise(resolve => client.emit('np02', Buffer.from('synthetic-binary'), resolve));
    assert.equal(Buffer.from(echoed).toString(), 'synthetic-binary');
    if (client.io.engine.transport.name !== 'websocket')
      await new Promise(resolve => client.io.engine.once('upgrade', resolve));
    assert.equal(client.io.engine.transport.name, 'websocket');
  } finally {
    client?.disconnect();
    await new Promise(resolve => socketServer.close(resolve));
  }
});

test('Axios explicit zero redirects makes one request and exposes the 302', { timeout: 10000 }, async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(302, { location: '/target' }); res.end(); });
  try {
    const base = await listening(server);
    await assert.rejects(api('axios').get(`${base}/source`, { maxRedirects: 0, proxy: false }),
      error => error.response?.status === 302);
    assert.equal(hits, 1);
  } finally { await close(server); }
});

test('patched YAML accepts existing ordinary anchors and JSON-compatible schemas', () => {
  const yaml = api('js-yaml');
  assert.deepEqual(yaml.load('base: &base {name: api}\ncopy: {<<: *base, version: 1}\n'),
    { base: { name: 'api' }, copy: { name: 'api', version: 1 } });
  assert.deepEqual(yaml.load('openapi: 3.0.3\npaths: {}', { schema: yaml.JSON_SCHEMA }),
    { openapi: '3.0.3', paths: {} });
});
