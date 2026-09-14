'use strict';

// Built artifacts only. The coordinator must build Parser, then Server first.
// Transformation is injected; registration, authentication, SDK and transports are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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
const entries = ['main', 'file', 'url', 'spec'];
const toolName = 'execution_scope_fixture';

async function registered(entry, handler) {
  const tool = { id: toolName, name: toolName, description: 'Owned authorization fixture',
    inputSchema: entry === 'main' ? { type: 'object', properties: {} } : {}, handler };
  const registrations = [];
  const fake = { registerTool(name, config, callback) { registrations.push({ name, config, callback }); } };
  const originalTransform = transform.transformOpenApiToMcpTools;
  const methods = ['transformFromFile', 'transformFromUrl', 'transformFromSpec'];
  const originals = methods.map(name => Transformer.prototype[name]);
  try {
    transform.transformOpenApiToMcpTools = async () => [tool];
    for (const name of methods) Transformer.prototype[name] = async () => [tool];
    if (entry === 'main') await main.initTools(fake, { fixture: randomUUID() });
    if (entry === 'file') await lib.initTools(fake, 'injected-not-read.json');
    if (entry === 'url') await lib.initToolsFromUrl(fake, 'http://127.0.0.1/injected-not-fetched');
    if (entry === 'spec') await lib.initToolsFromSpec(fake, { fixture: true });
    assert.equal(registrations.length, 1, entry + ' must register the injected tool');
    return registrations[0];
  } finally {
    transform.transformOpenApiToMcpTools = originalTransform;
    methods.forEach((name, i) => { Transformer.prototype[name] = originals[i]; });
  }
}

function configure(t, root, mode) {
  const values = {
    API_NOVA_AUDIT_DIR: root,
    API_NOVA_RUNTIME_AUTH_MODE: mode,
    API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
    API_NOVA_MCP_RESOURCE: 'https://execution-fixture.invalid/mcp',
    API_NOVA_MCP_TOOL_SCOPES: '{}',
    API_NOVA_AUDIT_MAX_BODY_BYTES: '65536',
  };
  const token = randomUUID();
  values.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([{ id: 'owned-key', subject: 'owned-caller',
    secretHash: parser.auditDigest(token), expiresAt: Math.floor(Date.now() / 1000) + 120,
    resources: [values.API_NOVA_MCP_RESOURCE], scopes: ['allowed:execute'] }]);
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  return mode === 'api_key' ? { 'x-api-key': token } : {};
}

async function records(root) {
  await parser.flushRuntimeAudit();
  const files = (await fs.readdir(root)).filter(name => /^calls-v2-.*\.jsonl$/.test(name));
  const values = await Promise.all(files.map(name => fs.readFile(path.join(root, name), 'utf8')));
  return values.flatMap(value => value.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
}

for (const entry of entries) {
  for (const protocol of ['streamable', 'sse']) {
    for (const mode of ['api_key', 'anonymous']) {
      test(`${entry}/${protocol}/${mode}: live admission then tightened execution scope`,
        { timeout: 20000, concurrency: false }, async t => {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-execution-scope-'));
          const headers = configure(t, root, mode);
          let calls = 0, tighten = false, deniedContext;
          const registration = await registered(entry, async () => {
            calls++;
            return { content: [{ type: 'text', text: 'executed' }] };
          });
          const factory = async () => {
            const server = new McpServer({ name: 'execution-scope-test', version: '1' });
            server.registerTool(registration.name, registration.config, async (...args) => {
              const context = parser.getRuntimeCallContext();
              assert.equal(context.protocolTransport, protocol);
              assert.equal(context.identitySource, mode === 'api_key' ? 'authenticated' : 'anonymous');
              if (tighten) {
                // This callback can only be reached after HTTP admission has passed.
                deniedContext = { ...context };
                process.env.API_NOVA_MCP_TOOL_SCOPES = JSON.stringify({ [toolName]: ['new:required'] });
              }
              return registration.callback(...args);
            });
            return server;
          };
          const signals = Object.fromEntries(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]));
          const start = protocol === 'sse' ? startSseMcpServer : startStreamableMcpServer;
          const httpServer = await start(factory, '/mcp', 0, { host: '127.0.0.1' });
          let client;
          t.after(async () => {
            if (client) await client.close();
            httpServer.closeAllConnections?.();
            await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
            for (const [name, existing] of Object.entries(signals)) {
              for (const listener of process.listeners(name)) if (!existing.includes(listener)) process.off(name, listener);
            }
            await parser.flushRuntimeAudit();
          });
          if (!httpServer.listening) await once(httpServer, 'listening');
          const endpoint = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
          const transport = protocol === 'streamable'
            ? new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } })
            : new SSEClientTransport(endpoint, { requestInit: { headers }, eventSourceInit: {
              fetch: (url, init) => fetch(url, { ...init,
                headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }),
            } });
          client = new Client({ name: 'execution-scope-client', version: '1' });
          await client.connect(transport);
          process.env.API_NOVA_MCP_TOOL_SCOPES = JSON.stringify({ [toolName]: mode === 'api_key' ? ['allowed:execute'] : [] });
          const allowed = await client.callTool({ name: toolName, arguments: {} });
          assert.equal(allowed.isError, undefined);
          assert.equal(calls, 1);
          tighten = true;
          const denied = await client.callTool({ name: toolName, arguments: {} });
          // Execution denial is a normal JSON-RPC tools/call result with isError,
          // not a transport-level 403, disconnected session, or raw thrown exception.
          assert.equal(denied.isError, true);
          assert.ok(denied.content.some(item => item.type === 'text' && item.text.includes('insufficient_scope')));
          assert.equal(calls, 1, 'denied callback must never reach the underlying handler');
          assert.ok(deniedContext, 'the second request must pass admission before rules tighten');
          const audit = await records(root);
          assert.ok(audit.some(row => row.toolName === toolName && row.errorCode === 'insufficient_scope' &&
            row.failureStage === 'admission' && row.requestId === deniedContext.requestId),
            'reuse the existing correlated authorization rejection audit boundary');
          tighten = false;
          process.env.API_NOVA_MCP_TOOL_SCOPES = '{}';
          const recovered = await client.callTool({ name: toolName, arguments: {} });
          assert.equal(recovered.isError, undefined);
          assert.equal(calls, 2, 'same session remains usable after authorization denial');
        });
    }
  }
  test(`${entry}: stdio and absent context do not acquire HTTP identity`,
    { concurrency: false }, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-local-execution-'));
      configure(t, root, 'jwt');
      process.env.API_NOVA_MCP_TOOL_SCOPES = JSON.stringify({ [toolName]: ['never:granted'] });
      const observed = [];
      const registration = await registered(entry, async () => {
        observed.push(parser.getRuntimeCallContext());
        return { content: [{ type: 'text', text: 'local' }] };
      });
      assert.equal(parser.getRuntimeCallContext(), undefined);
      await registration.callback({});
      assert.equal(observed[0], undefined);
      const local = { transport: 'mcp', protocolTransport: 'stdio', identitySource: 'anonymous', requestId: randomUUID() };
      await parser.withRuntimeCallContext(local, () => registration.callback({}));
      assert.equal(observed.length, 2);
      assert.equal(observed[1].protocolTransport, 'stdio');
      assert.equal(observed[1].identitySource, 'anonymous');
      assert.equal(observed[1].callerId, undefined);
      assert.equal(observed[1].credentialId, undefined);
      assert.equal(parser.getRuntimeCallContext(), undefined);
    });
}
