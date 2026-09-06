const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { generateKeyPair, exportJWK, SignJWT } = createRequire(require.resolve('api-nova-parser'))('jose');
const { createMcpServer, startStreamableMcpServer, startSseMcpServer } = require('../dist/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { listObservedRuntimeCallers, flushRuntimeAudit } = require('api-nova-parser');

async function main() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'api-nova-mcp-audit-'));
  const original = { ...process.env };
  process.env.API_NOVA_AUDIT_DIR = directory;
  process.env.API_NOVA_RUNTIME_AUTH_MODE = 'oauth';
  process.env.API_NOVA_RUNTIME_ISSUER = 'https://issuer.example';
  process.env.API_NOVA_MCP_RESOURCE = 'https://runtime.example/mcp';
  process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'api:invoke';
  process.env.API_NOVA_MCP_TOOL_SCOPES = '{}';
  delete process.env.API_NOVA_RUNTIME_JWKS_URI;
  const keys = await generateKeyPair('RS256');
  process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test' }] });
  const mint = (subject, overrides = {}) => new SignJWT({ sub: subject, iss: process.env.API_NOVA_RUNTIME_ISSUER,
    aud: process.env.API_NOVA_MCP_RESOURCE, scope: 'api:invoke', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const token = await mint('caller-a');
  const other = await mint('caller-b');
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls++;
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: input.message, password: 'upstream-secret' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const spec = { openapi: '3.0.3', info: { title: 'Audit', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstream.address().port}` }], paths: { '/echo': { post: {
      operationId: 'echo', 'x-runtime-asset-id': 'runtime-a', 'x-endpoint-definition-id': 'api-a',
      'x-source-service-instance-id': 'instance-a',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        properties: { message: { type: 'string' } }, required: ['message'] } } } },
      responses: { '200': { description: 'OK' } } } } } };
  const server = await startStreamableMcpServer(() => createMcpServer({ openApiData: spec },
    { registerSignalHandlers: false }), '/mcp', 0);
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let sseServer, sseClient;
  let id = 1;
  async function request(method, params, session, accessToken = token) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (session) headers['mcp-session-id'] = session;
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
    const text = await response.text();
    let message;
    for (const line of text.split('\n')) if (line.startsWith('data: ')) message = JSON.parse(line.slice(6));
    if (!message && text) { try { message = JSON.parse(text); } catch {} }
    return { response, message, text };
  }
  const init = accessToken => request('initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'audit-test', version: '1' } }, undefined, accessToken);
  try {
    const missing = await init('');
    assert.equal(missing.response.status, 401);
    assert.match(missing.response.headers.get('www-authenticate'), /^Bearer resource_metadata=/);
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json()).authorization_servers, ['https://issuer.example']);
    assert.equal((await init(await mint('caller-a', { aud: 'https://wrong.example' }))).response.status, 401);
    assert.equal((await init(await mint('caller-a', { scope: '' }))).response.status, 403);
    assert.equal((await fetch(`${base}/mcp`, { method: 'OPTIONS' })).status, 204);
    assert.equal((await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://untrusted.example' } })).status, 403);

    const first = await init(token);
    assert.equal(first.response.status, 200, first.text);
    const session = first.response.headers.get('mcp-session-id');
    assert.ok(session);
    const tools = await request('tools/list', {}, session);
    const toolName = tools.message.result.tools[0].name;
    assert.equal((await request('tools/list', {}, session, other)).response.status, 403);
    for (const method of ['GET', 'DELETE']) {
      const invalid = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${other}`,
        'mcp-session-id': session, accept: 'text/event-stream' } });
      assert.equal(invalid.status, 403);
      await invalid.text();
    }
    process.env.API_NOVA_MCP_TOOL_SCOPES = JSON.stringify({ [toolName]: ['echo:write'] });
    const denied = await request('tools/call', { name: toolName, arguments: { message: 'denied' } }, session);
    assert.equal(denied.response.status, 403);
    assert.match(denied.response.headers.get('www-authenticate'), /echo:write/);
    assert.equal(upstreamCalls, 0);
    process.env.API_NOVA_MCP_TOOL_SCOPES = '{}';
    const payload = 'x'.repeat(9000);
    const calls = await Promise.all([1, 2].map(() => request('tools/call',
      { name: toolName, arguments: { message: payload } }, session)));
    assert.ok(calls.every(call => call.response.status === 200 && !call.message.result.isError));
    assert.equal(upstreamCalls, 2);
    const refreshed = await mint('caller-a', { jti: 'renewed' });
    assert.equal((await request('tools/list', {}, session, refreshed)).response.status, 200);
    const invalidJson = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'mcp-session-id': session }, body: '{"password":"invalid-json-secret"' });
    assert.equal(invalidJson.status, 400);
    assert.ok(!(await invalidJson.text()).includes('invalid-json-secret'));
    process.env.API_NOVA_AUDIT_MAX_BODY_BYTES = '128';
    assert.equal((await request('tools/call', { name: toolName, arguments: { message: payload } }, session)).response.status, 413);
    delete process.env.API_NOVA_AUDIT_MAX_BODY_BYTES;
    const end = await fetch(`${base}/mcp`, { method: 'DELETE', headers: {
      authorization: `Bearer ${refreshed}`, 'mcp-session-id': session } });
    assert.equal(end.status, 200);
    await end.text();

    sseServer = await startSseMcpServer(() => createMcpServer({ openApiData: spec },
      { registerSignalHandlers: false }), '/sse', 0);
    if (!sseServer.listening) await once(sseServer, 'listening');
    const sseBase = `http://127.0.0.1:${sseServer.address().port}`;
    const unauthenticatedSse = await fetch(`${sseBase}/sse`);
    assert.equal(unauthenticatedSse.status, 401);
    await unauthenticatedSse.text();
    let messagesUrl;
    const sseTransport = new SSEClientTransport(new URL(`${sseBase}/sse`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, options) => {
        if (String(url).includes('/messages?')) messagesUrl = String(url);
        return fetch(url, options);
      },
    });
    sseClient = new Client({ name: 'audit-sse-test', version: '1' });
    await sseClient.connect(sseTransport);
    const sseTools = await sseClient.listTools();
    assert.ok(messagesUrl);
    const wrongSseCaller = await fetch(messagesUrl, { method: 'POST', headers: {
      authorization: `Bearer ${other}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }) });
    assert.equal(wrongSseCaller.status, 403);
    await wrongSseCaller.text();
    const sseCall = await sseClient.callTool({ name: sseTools.tools[0].name, arguments: { message: payload } });
    assert.ok(!sseCall.isError);
    assert.equal(upstreamCalls, 3);
    await sseClient.close();

    await flushRuntimeAudit();
    const files = (await fs.readdir(directory)).filter(file => /^\d{4}-/.test(file));
    const lines = (await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('');
    assert.ok(!lines.includes('upstream-secret'));
    assert.ok(!lines.includes(token));
    const records = lines.trim().split('\n').map(line => JSON.parse(line));
    const apiCalls = records.filter(record => record.kind === 'api');
    const toolCalls = records.filter(record => record.kind === 'tool' && record.outcome === 'success');
    assert.equal(apiCalls.length, 3);
    assert.equal(toolCalls.length, 3);
    assert.ok(records.some(record => record.kind === 'tool' && record.errorCode === 'insufficient_scope' && record.toolName === toolName));
    for (const call of apiCalls) {
      assert.equal(call.endpointDefinitionId, 'api-a');
      assert.equal(call.sourceServiceInstanceId, 'instance-a');
      assert.equal(JSON.parse(call.request.data).message, payload);
      assert.equal(JSON.parse(call.response.data).echo, payload);
      const parent = toolCalls.find(tool => tool.invocationId === call.parentInvocationId);
      assert.ok(parent);
      assert.equal(parent.callerId, call.callerId);
      assert.equal(parent.requestId, call.requestId);
    }
    const inventory = await listObservedRuntimeCallers();
    assert.equal(inventory.filter(caller => caller.subject === 'caller-a').length, 1);
    console.log('RUNTIME_SECURITY_AUDIT_SMOKE_OK');
  } finally {
    if (sseClient) await sseClient.close();
    if (sseServer) { sseServer.closeAllConnections(); await new Promise(resolve => sseServer.close(resolve)); }
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await flushRuntimeAudit();
    process.env = original;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
