'use strict';

// Run only after fresh Parser and Server builds. No external services.
// Real McpServer registration/dispatch; only OpenAPI transformation is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const parser = require('api-nova-parser');
const transform = require('../dist/transform/transformOpenApiToMcpTools.js');
const { Transformer } = require('../dist/core/Transformer.js');
const main = require('../dist/tools/initTools.js');
const lib = require('../dist/lib/initTools.js');
const { startStreamableMcpServer } = require('../dist/transportUtils/stream.js');
const { startSseMcpServer } = require('../dist/transportUtils/sse.js');
const { installMcpToolListScopeFilter } = require('../dist/tools/runtime-security.js');
const names = result => result.tools.map(tool => tool.name).sort();
const all = ['read_fixture', 'write_fixture'];
const rules = value => { process.env.API_NOVA_MCP_TOOL_SCOPES = typeof value === 'string' ? value : JSON.stringify(value); };
const context = (scopes, protocol = 'streamable', identitySource = 'authenticated') => ({
  transport: 'mcp', protocolTransport: protocol, identitySource, scopes,
  callerId: identitySource === 'authenticated' ? randomUUID() : undefined, requestId: randomUUID(),
});

async function environment(t) {
  const saved = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-tool-list-'));
  process.env.API_NOVA_AUDIT_DIR = root;
  process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = '';
  rules({});
  t.after(async () => {
    await parser.flushRuntimeAudit();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

async function fixture(entry) {
  let executed = 0;
  const tools = all.map(name => ({ id: name, name, description: name + ' description',
    inputSchema: entry === 'main' ? { type: 'object', properties: {} } : {},
    handler: async () => { executed++; return { content: [{ type: 'text', text: 'executed' }] }; },
  }));
  const server = new McpServer({ name: 'tool-list-' + entry, version: '1' });
  const methods = ['transformFromFile', 'transformFromUrl', 'transformFromSpec'];
  const originals = methods.map(name => Transformer.prototype[name]);
  const original = transform.transformOpenApiToMcpTools;
  try {
    transform.transformOpenApiToMcpTools = async () => tools;
    for (const name of methods) Transformer.prototype[name] = async () => tools;
    if (entry === 'main') await main.initTools(server, { fixture: randomUUID() });
    if (entry === 'file') await lib.initTools(server, 'injected-not-read.json');
    if (entry === 'url') await lib.initToolsFromUrl(server, 'http://127.0.0.1/injected-not-fetched');
    if (entry === 'spec') await lib.initToolsFromSpec(server, { fixture: true });
  } finally {
    transform.transformOpenApiToMcpTools = original;
    methods.forEach((name, i) => { Transformer.prototype[name] = originals[i]; });
  }
  const invoke = (method, params = {}) => {
    const handler = server.server._requestHandlers.get(method);
    assert.equal(typeof handler, 'function', 'real SDK handler must be installed');
    return handler({ method, params }, { signal: new AbortController().signal,
      requestId: randomUUID(), sendNotification: async () => {}, sendRequest: async () => ({}) });
  };
  return { server, invoke, executed: () => executed };
}

for (const entry of ['main', 'file', 'url', 'spec']) {
  test(entry + ': real SDK list bridge and request-local authorization', { timeout: 15000 }, async t => {
    await environment(t);
    const f = await fixture(entry);
    t.after(() => f.server.close());
    const list = ctx => parser.withRuntimeCallContext(ctx, () => f.invoke('tools/list'));
    await t.test('scope filters metadata without executing tools', async () => {
      rules({ write_fixture: ['write'] });
      const result = await list(context(['read']));
      assert.deepEqual(names(result), ['read_fixture']);
      assert.equal(result.tools[0].description, 'read_fixture description');
      assert.deepEqual(result.tools[0].inputSchema, { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} });
      assert.equal(f.executed(), 0);
    });
    await t.test('same handler concurrent identities never share filtered results', async () => {
      rules({ write_fixture: ['write'] });
      const requests = Array.from({ length: 24 }, (_, i) => list(context(i % 2 ? ['write'] : [], i % 3 ? 'streamable' : 'sse')));
      const results = await Promise.all(requests);
      results.forEach((result, i) => assert.deepEqual(names(result), i % 2 ? all : ['read_fixture']));
    });
    await t.test('current rules are reread rather than cached', async () => {
      const ctx = context(['read']);
      rules({});
      assert.deepEqual(names(await list(ctx)), all);
      rules({ write_fixture: ['write'] });
      assert.deepEqual(names(await list(ctx)), ['read_fixture']);
      rules({ write_fixture: ['read'] });
      assert.deepEqual(names(await list(ctx)), all);
    });
    await t.test('Anonymous cannot list scoped tools', async () => {
      rules({ read_fixture: [], write_fixture: ['write'] });
      assert.deepEqual(names(await list(context([], 'sse', 'anonymous'))), ['read_fixture']);
    });
    await t.test('invalid JSON and invalid matching rule fail closed with fixed SDK error', async () => {
      for (const invalid of ['{', '[]', { write_fixture: 'write' }, { write_fixture: [1] }]) {
        rules(invalid);
        await assert.rejects(() => list(context([])), error =>
          error.code === -32603 && error.message.includes('Invalid MCP tool scope configuration'));
      }
    });
    await t.test('no rules, stdio and absent context preserve SDK list behavior', async () => {
      rules({});
      assert.deepEqual(names(await list(context([]))), all);
      rules({ read_fixture: ['never'], write_fixture: ['never'] });
      assert.deepEqual(names(await list(context([], 'stdio', 'anonymous'))), all);
      assert.equal(parser.getRuntimeCallContext(), undefined);
      assert.deepEqual(names(await f.invoke('tools/list')), all);
      assert.equal(parser.getRuntimeCallContext(), undefined);
    });
    await t.test('repeat installation does not mutate shared registration or weaken call authorization', async () => {
      installMcpToolListScopeFilter(f.server);
      rules({});
      const ctx = context([]);
      assert.deepEqual(names(await list(ctx)), all);
      rules({ write_fixture: ['write'] });
      const denied = await parser.withRuntimeCallContext(ctx, () => f.invoke('tools/call', { name: 'write_fixture', arguments: {} }));
      assert.equal(denied.isError, true);
      assert.ok(denied.content.some(item => item.type === 'text' && item.text.includes('insufficient_scope')));
      assert.equal(f.executed(), 0);
      const allowed = await parser.withRuntimeCallContext(context(['write']), () => f.invoke('tools/call', { name: 'write_fixture', arguments: {} }));
      assert.notEqual(allowed.isError, true);
      assert.equal(f.executed(), 1);
      assert.deepEqual(names(await list(context(['write']))), all);
    });
  });
}

for (const protocol of ['streamable', 'sse']) {
  test(protocol + ': real loopback SDK sessions retain concurrent scope isolation', { timeout: 20000 }, async t => {
    await environment(t);
    process.env.API_NOVA_RUNTIME_AUTH_MODE = 'api_key';
    process.env.API_NOVA_MCP_RESOURCE = 'https://tool-list-fixture.invalid/mcp';
    const keys = [randomUUID(), randomUUID()];
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify(keys.map((key, i) => ({ id: 'key-' + i,
      subject: 'caller-' + i, secretHash: parser.auditDigest(key), expiresAt: Math.floor(Date.now() / 1000) + 120,
      resources: [process.env.API_NOVA_MCP_RESOURCE], scopes: i ? ['write'] : [],
    })));
    rules({ write_fixture: ['write'] });
    // Pre-register serially: injection must not overlap across async session creation.
    const fixtures = [await fixture('main'), await fixture('main')];
    let next = 0;
    const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]));
    const start = protocol === 'sse' ? startSseMcpServer : startStreamableMcpServer;
    const server = await start(async () => {
      assert.ok(next < fixtures.length, 'only owned sessions may be created');
      return fixtures[next++].server;
    }, '/mcp', 0, { host: '127.0.0.1' });
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const [name, previous] of Object.entries(listeners)) {
        for (const listener of process.listeners(name)) if (!previous.includes(listener)) process.off(name, listener);
      }
    });
    if (!server.listening) await once(server, 'listening');
    const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    for (const key of keys) {
      const headers = { 'x-api-key': key };
      const transport = protocol === 'streamable'
        ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
        : new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: {
          fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }),
        } });
      const client = new Client({ name: 'tool-list-client', version: '1' });
      clients.push(client);
      await client.connect(transport);
    }
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => clients[i % 2].listTools()));
    results.forEach((result, i) => assert.deepEqual(names(result), i % 2 ? all : ['read_fixture']));
    rules({ write_fixture: ['revoked'] });
    assert.deepEqual(names(await clients[1].listTools()), ['read_fixture']);
    const denied = await clients[1].callTool({ name: 'write_fixture', arguments: {} }).then(
      value => ({ value }), error => ({ error }));
    assert.ok(denied.error || denied.value?.isError === true, 'hidden tool must remain unauthorized at call ingress');
    assert.equal(fixtures.reduce((sum, f) => sum + f.executed(), 0), 0);
  });
}
