'use strict';
// Node >=20 contract. Only isolated files and loopback HTTP are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const semver = require('semver');
const root = path.resolve(process.env.API_NOVA_SECURITY_CANDIDATE_ROOT || path.join(__dirname, '..'));
const api = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const sdk = createRequire(api.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'));
const metadata = (req, name) => {
  const entry = name === '@modelcontextprotocol/sdk' ? name + '/server/streamableHttp.js' : name;
  let directory = path.dirname(req.resolve(entry));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fsSync.existsSync(file)) {
      const value = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      if (value.name === name) return value;
    }
    directory = path.dirname(directory);
  }
  throw Error('Package metadata unavailable: ' + name);
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = async server => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
};
const get = (port, requestPath) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
    response.on('error', reject);
  }).on('error', reject);
});

test('API and Server SDK consumers use patched Hono 2 with the Node20 engine contract', () => {
  for (const workspace of ['api', 'server']) {
    const req = createRequire(path.join(root, `packages/api-nova-${workspace}/package.json`));
    const consumer = createRequire(req.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'));
    assert.equal(metadata(consumer, '@hono/node-server').version, '2.1.5');
    assert.equal(metadata(req, '@modelcontextprotocol/sdk').version, '1.32.2');
    assert.equal(metadata(consumer, 'zod').version, '4.6.7', workspace + ' SDK must not reuse a stale Zod3 peer');
    assert(semver.satisfies('20.0.0', metadata(consumer, '@hono/node-server').engines.node));
    assert(semver.satisfies('20.0.0', metadata(req, '@modelcontextprotocol/sdk').engines.node));
  }
  const lock = JSON.parse(fsSync.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [location, value] of Object.entries(lock.packages)) {
    if (location.endsWith('node_modules/@hono/node-server')) assert.equal(value.version, '2.1.5', location);
  }
});

test('Hono static adapter prevents malformed-percent middleware bypass while serving normal encoded filenames', { timeout: 10000 }, async () => {
  const { Hono } = sdk('hono');
  const { getRequestListener } = sdk('@hono/node-server');
  const { serveStatic } = sdk('@hono/node-server/serve-static');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-hono-regression-'));
  const app = new Hono();
  await fs.mkdir(path.join(directory, 'static', 'admin'), { recursive: true });
  await fs.writeFile(path.join(directory, 'static', 'admin', 'secret.txt'), 'synthetic-private-file');
  await fs.writeFile(path.join(directory, 'static', 'hello world.txt'), 'public-file');
  app.use('/static/admin/*', c => c.text('denied', 403));
  app.use('/static/*', serveStatic({ root: directory }));
  const listener = http.createServer(getRequestListener(app.fetch));
  try {
    const port = await listen(listener);
    assert.deepEqual(await get(port, '/static/hello%20world.txt'), { status: 200, body: 'public-file' });
    assert.equal((await get(port, '/static/admin/secret.txt')).status, 403);
    // GHSA-rmxm-3fg6-px4f: routing and filesystem lookup must see the same path.
    const bypass = await get(port, '/static/%%36%31dmin/secret.txt');
    assert.equal(bypass.status, 404);
    assert(!bypass.body.includes('synthetic-private-file'));
  } finally { await close(listener); await fs.rm(directory, { recursive: true, force: true }); }
});

test('real SDK Streamable HTTP initializes, lists, validates, calls and closes over the Hono2 adapter', { timeout: 15000 }, async () => {
  const { McpServer } = api('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = api('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { LATEST_PROTOCOL_VERSION } = api('@modelcontextprotocol/sdk/types.js');
  const { z } = sdk('zod');
  const server = new McpServer({ name: 'migration-regression', version: '1' });
  server.registerTool('echo', { inputSchema: { value: z.string().min(1) } }, async ({ value }) => ({ content: [{ type: 'text', text: value }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);
  const listener = http.createServer((req, res) => {
    transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  try {
    const port = await listen(listener);
    const url = `http://127.0.0.1:${port}/mcp`;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const send = body => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const initialized = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'regression', version: '1' } } });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.protocolVersion, LATEST_PROTOCOL_VERSION);
    const sessionId = initialized.headers.get('mcp-session-id'); assert(sessionId);
    headers['mcp-session-id'] = sessionId; headers['mcp-protocol-version'] = LATEST_PROTOCOL_VERSION;
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202); await notification.arrayBuffer();
    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tool = (await listed.json()).result.tools[0];
    assert.equal(tool.name, 'echo'); assert.equal(tool.inputSchema.properties.value.type, 'string');
    const called = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'accepted' } } });
    assert.equal((await called.json()).result.content[0].text, 'accepted');
    const invalid = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 42 } } });
    const rejected = await invalid.json(); assert(rejected.error || rejected.result?.isError);
    const deleted = await fetch(url, { method: 'DELETE', headers });
    assert.equal(deleted.status, 200); await deleted.arrayBuffer();
    const retired = await send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    assert.equal(retired.status, 404); await retired.arrayBuffer();
  } finally { await server.close(); await close(listener); }
});
