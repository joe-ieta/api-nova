'use strict';
// SEC-B3-02: fresh Parser/Server builds required. No SDK upgrade.
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { once } = require('node:events'),
  { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const parser = require('api-nova-parser');
const {
  installMcpToolListScopeFilter,
  assertMcpToolExecutionScopes,
} = require('../dist/tools/runtime-security.js');
const { startStreamableMcpServer } = require('../dist/transportUtils/stream.js');
const { startSseMcpServer } = require('../dist/transportUtils/sse.js');
const names = (result) => result.tools.map((tool) => tool.name).sort();
test('SDK 1.29.0 dispatcher: shape, late registration and idempotence', async () => {
  const sdkRoot = path.resolve(
    path.dirname(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')),
    '../../..',
  );
  assert.equal(JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8')).version, '1.29.0');
  assert.throws(
    () => installMcpToolListScopeFilter({ server: { _requestHandlers: {} } }),
    /Unsupported MCP tool-list dispatcher/,
  );
  assert.doesNotThrow(() => installMcpToolListScopeFilter({}));
  const server = new McpServer({ name: 'dispatcher-contract', version: '1' });
  try {
    assert.ok(server.server._requestHandlers instanceof Map);
    installMcpToolListScopeFilter(server);
    server.registerTool('late', {}, async () => ({ content: [] }));
    const original = server.server._requestHandlers.get('tools/list');
    installMcpToolListScopeFilter(server);
    const wrapped = server.server._requestHandlers.get('tools/list');
    assert.notEqual(wrapped, original);
    installMcpToolListScopeFilter(server);
    assert.equal(server.server._requestHandlers.get('tools/list'), wrapped);
    assert.deepEqual(names(await wrapped({ method: 'tools/list', params: {} }, {})), ['late']);
    assert.equal(server.server.getCapabilities().tools.listChanged, true);
  } finally {
    await server.close();
  }
});
for (const protocol of ['streamable', 'sse'])
  test(protocol + ': real SDK session identity and notification boundary', { timeout: 20000 }, async (t) => {
    const saved = { ...process.env },
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-sdk-contract-'));
    const signals = Object.fromEntries(['SIGINT', 'SIGTERM'].map((name) => [name, process.listeners(name)]));
    let listener, client;
    t.after(async () => {
      await client?.close();
      if (listener) {
        listener.closeAllConnections?.();
        await new Promise((resolve) => listener.close(resolve));
      }
      await parser.flushRuntimeAudit();
      for (const [name, previous] of Object.entries(signals))
        for (const handler of process.listeners(name))
          if (!previous.includes(handler)) process.off(name, handler);
      process.env = saved;
      assert.equal(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith('api-nova-sdk-contract-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    for (const key of Object.keys(process.env))
      if (key.startsWith('API_NOVA_RUNTIME_') || key === 'API_NOVA_TEMPORARY_ANONYMOUS')
        delete process.env[key];
    Object.assign(process.env, {
      API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
      API_NOVA_AUDIT_DIR: root,
      API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
      API_NOVA_MCP_TOOL_SCOPES: JSON.stringify({ write: ['write'] }),
    });
    const secrets = [randomUUID(), randomUUID(), randomUUID()],
      keys = secrets.map((secret, i) => 'sdk_' + i + '.' + secret);
    const credentials = secrets.map((secret, i) => ({
      version: 1,
      id: 'id-' + i,
      keyId: 'sdk_' + i,
      subject: i === 2 ? 'other' : 'owner',
      secretHash: parser.auditDigest(secret),
      status: 'active',
      expiresAt: Math.floor(Date.now() / 1000) + 120,
      protocols: ['mcp'],
      runtimeAssetId: 'sdk-contract',
      scopes: ['write'],
      toolScopes: ['*'],
      actorId: 'contract-admin',
    }));
    const publish = () => {
      process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = JSON.stringify({
        version: 1,
        runtimeAssetId: 'sdk-contract',
        credentials,
      });
    };
    publish();
    let instance,
      writeTool,
      executed = 0,
      sentNotifications = 0;
    const factory = async () => {
      instance = new McpServer({ name: 'session-contract', version: '1' });
      instance.registerTool('read', {}, async () => ({ content: [] }));
      writeTool = instance.registerTool('write', {}, async () => {
        await assertMcpToolExecutionScopes('write');
        executed++;
        return { content: [] };
      });
      const notify = instance.server.sendToolListChanged.bind(instance.server);
      instance.server.sendToolListChanged = async (...args) => {
        sentNotifications++;
        return notify(...args);
      };
      installMcpToolListScopeFilter(instance);
      return instance;
    };
    listener = await (protocol === 'sse' ? startSseMcpServer : startStreamableMcpServer)(factory, '/mcp', 0, {
      host: '127.0.0.1',
    });
    if (!listener.listening) await once(listener, 'listening');
    const url = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
    let currentKey = keys[0],
      postUrl;
    const authorizedFetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('x-api-key', currentKey);
      if (init?.method === 'POST') postUrl = String(input);
      return fetch(input, { ...init, headers });
    };
    const transport =
      protocol === 'streamable'
        ? new StreamableHTTPClientTransport(url, { fetch: authorizedFetch })
        : new SSEClientTransport(url, {
            fetch: authorizedFetch,
            eventSourceInit: { fetch: authorizedFetch },
          });
    client = new Client({ name: 'contract-client', version: '1' });
    let receivedNotifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      receivedNotifications++;
    });
    await client.connect(transport);
    assert.equal(client.getServerCapabilities().tools.listChanged, true);
    assert.deepEqual(names(await client.listTools()), ['read', 'write']);
    await t.test(
      protocol === 'streamable'
        ? 'cross-subject POST/GET/DELETE reject before dispatch'
        : 'cross-subject SSE message POST rejects before dispatch',
      async () => {
        const headers = {
          'x-api-key': keys[2],
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        };
        if (protocol === 'streamable') headers['mcp-session-id'] = transport.sessionId;
        for (const method of protocol === 'streamable' ? ['POST', 'GET', 'DELETE'] : ['POST']) {
          const response = await fetch(method === 'POST' ? postUrl : url, {
            method,
            headers,
            ...(method === 'POST'
              ? { body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list' }) }
              : {}),
          });
          assert.equal(response.status, 403, method);
          await response.text();
        }
        assert.deepEqual(names(await client.listTools()), ['read', 'write']);
      },
    );
    await t.test('same-subject successor retains session and uses current scopes', async () => {
      currentKey = keys[1];
      assert.deepEqual(names(await client.listTools()), ['read', 'write']);
      credentials[1].scopes = [];
      publish();
      assert.deepEqual(names(await client.listTools()), ['read']);
      const result = await client.callTool({ name: 'write', arguments: {} }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      assert.ok(result.error || result.value?.isError);
      assert.equal(executed, 0);
      // listChanged advertises catalog changes; it does not promise a scope-change push.
      // Re-listing and execution admission must work without any notification.
      assert.equal(sentNotifications, 0, 'credential scope mutation has no catalog-notification producer');
      assert.equal(receivedNotifications, 0);
    });
    await t.test('host scopes update lists without unsolicited list_changed', async () => {
      process.env.API_NOVA_MCP_TOOL_SCOPES = '{}';
      assert.deepEqual(names(await client.listTools()), ['read', 'write']);
      assert.equal(sentNotifications, 0);
      assert.equal(receivedNotifications, 0);
    });
    await t.test('actual SDK registration change emits catalog notification', async () => {
      writeTool.disable();
      for (let i = 0; i < 100 && receivedNotifications === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sentNotifications, 1);
      assert.equal(receivedNotifications, 1);
      assert.deepEqual(names(await client.listTools()), ['read']);
      assert.equal(executed, 0);
    });
  });
