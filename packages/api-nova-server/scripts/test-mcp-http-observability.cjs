'use strict';
const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { setTimeout: sleep } = require('node:timers/promises');
const { generateKeyPair, exportJWK, SignJWT } = createRequire(require.resolve('api-nova-parser'))('jose');
const parser = require('api-nova-parser');
const { createBaseHttpServer } = require('../dist/tools/httpServer.js');
const { getBody } = require('../dist/tools/getBody.js');
const { assertMcpToolScopes } = require('../dist/tools/runtime-security.js');
const { getMcpHttpAuditHealth } = require('../dist/tools/mcp-http-audit.js');
let keys, publicKey, token, server, root, env, handler, signals;
before(async () => {
  keys = await generateKeyPair('RS256'); publicKey = { ...await exportJWK(keys.publicKey), kid: 'http-audit' };
});
async function mint(expiry = '5m') {
  return new SignJWT({ sub: 'caller-http', iss: 'https://issuer.example', aud: 'https://runtime.example/mcp', scope: 'api:invoke' })
    .setProtectedHeader({ alg: 'RS256', kid: 'http-audit' }).setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}
beforeEach(async () => {
  env = { ...process.env };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-mcp-http-'));
  Object.assign(process.env, {
    API_NOVA_AUDIT_DIR: root, API_NOVA_RUNTIME_AUTH_MODE: 'jwt',
    API_NOVA_RUNTIME_ISSUER: 'https://issuer.example', API_NOVA_MCP_RESOURCE: 'https://runtime.example/mcp',
    API_NOVA_RUNTIME_REQUIRED_SCOPES: 'api:invoke', API_NOVA_MCP_TOOL_SCOPES: '{}',
    API_NOVA_RUNTIME_JWKS_JSON: JSON.stringify({ keys: [publicKey] }),
  });
  for (const name of ['API_NOVA_RUNTIME_JWKS_URI', 'API_NOVA_AUDIT_MAX_BODY_BYTES',
    'API_NOVA_AUDIT_CAPTURE_BODY', 'API_NOVA_AUDIT_MEMORY_BUDGET_BYTES']) delete process.env[name];
  token = await mint();
  handler = async (req, res) => {
    const body = await getBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: body, password: 'response-secret' }));
  };
  signals = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.listeners(name))]));
  server = createBaseHttpServer(0, '/mcp', { serverType: 'HTTP Streamable Server',
    handleRequest: (req, res) => handler(req, res) }, '127.0.0.1');
  if (!server.listening) await once(server, 'listening');
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await sleep(10);
  await parser.flushRuntimeAudit();
  for (const [name, original] of signals) for (const listener of process.listeners(name))
    if (!original.has(listener)) process.removeListener(name, listener);
  process.env = env;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('api-nova-mcp-http-'));
  await fs.rm(root, { recursive: true, force: true });
});
function send(options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method: options.method || 'POST',
      path: options.path || '/mcp', agent: false,
      headers: { ...(options.token === false ? {} : { authorization: 'Bearer ' + (options.token || token) }),
        'content-type': 'application/json', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(4000, () => request.destroy(new Error('HTTP fixture timeout')));
    request.on('error', reject);
    if (options.chunks) { for (const chunk of options.chunks) request.write(chunk); request.end(); }
    else request.end(options.body);
  });
}
async function records() {
  await parser.flushRuntimeAudit();
  const names = (await fs.readdir(root)).filter(name => name.startsWith('calls-v2-'));
  const all = (await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))))
    .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  for (const row of all) parser.normalizeRuntimeAuditRecord(row);
  return all;
}
function terminals(all) { return all.filter(row => row.phase === 'finished'); }
function ingress(all) {
  const rows = terminals(all).filter(row => row.spanKind === 'mcp_protocol');
  assert.equal(rows.length, 1); return rows[0];
}

test('authenticated HTTP ingress captures actual JSON bytes, headers and safe caller identity', async () => {
  const body = Buffer.from(JSON.stringify({ value: 'hello', token: 'request-secret' }));
  const response = await send({ body, headers: { 'content-length': body.length, 'x-request-id': 'client-id',
    'x-forwarded-for': '198.51.100.4', 'mcp-session-id': 'private-session' } });
  assert.equal(response.status, 200);
  const all = await records(), call = ingress(all);
  assert.equal(call.request.totalBytes, body.length);
  assert.equal(call.response.totalBytes, response.body.length);
  assert.equal(call.request.state, 'complete'); assert.equal(call.response.state, 'complete');
  assert.equal(call.response.contentType, 'application/json');
  assert.equal(call.authState, 'authenticated'); assert.equal(call.callerSubject, 'caller-http');
  assert.equal(call.clientIp, '127.0.0.1'); assert.equal(call.peerIp, '127.0.0.1');
  assert.equal(call.proxyTrusted, false); assert.equal(call.ipSource, 'peer');
  assert.equal(call.clientRequestId, 'client-id'); assert.notEqual(call.requestId, 'client-id');
  assert.equal(response.headers['x-request-id'], call.requestId);
  assert.equal(call.measurementStage, 'mcp_http'); assert.equal(call.byteMeasurement, 'observed_body');
  assert.notEqual(call.parentInvocationId, call.invocationId);
  const text = JSON.stringify(all);
  for (const secret of ['request-secret', 'response-secret', token, 'private-session']) assert.ok(!text.includes(secret));
});

test('authentication failure never drains the request or invents a caller or empty payload', async () => {
  const response = await send({ token: false, body: '{"token":"unread-secret"}' });
  assert.equal(response.status, 401);
  const all = await records(), call = ingress(all);
  assert.equal(call.authState, 'authentication_failed');
  assert.equal(call.callerId, undefined); assert.equal(call.request, undefined);
  assert.equal(call.response.totalBytes, response.body.length);
  assert.equal(call.errorCategory, 'authentication');
  assert.ok(!JSON.stringify(all).includes('unread-secret'));
});

test('host policy rejection is distinguished from authentication failure', async () => {
  const response = await send({ headers: { host: 'untrusted.example' } });
  assert.equal(response.status, 403);
  const call = ingress(await records());
  assert.equal(call.errorCategory, 'policy');
  assert.equal(call.errorCode, 'MCP_HEADER_REJECTED');
  assert.notEqual(call.authState, 'authenticated');
  assert.notEqual(call.authState, 'authentication_failed');
});

test('chunked response and request measurements count UTF-8 bytes exactly once', async () => {
  handler = async (req, res) => {
    await getBody(req);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write(Buffer.from([0xe4, 0xbd, 0xa0])); res.end('abc');
  };
  const chunks = [Buffer.from('{"value":"'), Buffer.from([0xe4, 0xbd, 0xa0]), Buffer.from('"}')];
  const response = await send({ chunks });
  const call = ingress(await records());
  assert.equal(call.request.totalBytes, Buffer.concat(chunks).length);
  assert.equal(call.response.totalBytes, 6); assert.equal(response.body.length, 6);
});

test('SSE frames are bounded metadata only even when content type is supplied by writeHead', async () => {
  handler = async (req, res) => {
    await getBody(req);
    res.writeHead(200, ['Content-Type', 'text/event-stream']);
    res.write('event: endpoint\ndata: /messages?sessionId=raw-session-secret\n\n');
    res.end('data: {"token":"raw-frame-secret"}\n\n');
  };
  const response = await send();
  const all = await records(), call = ingress(all);
  assert.equal(call.response.totalBytes, response.body.length);
  assert.equal(call.response.state, 'omitted');
  assert.equal(call.response.reason, 'sse_framing_not_captured');
  assert.equal(call.response.data, undefined);
  assert.ok(!JSON.stringify(all).includes('raw-session-secret'));
  assert.ok(!JSON.stringify(all).includes('raw-frame-secret'));
});

test('HEAD suppression records a truly empty response body', async () => {
  const response = await send({ method: 'HEAD' });
  assert.equal(response.body.length, 0);
  const call = ingress(await records());
  assert.equal(call.response.state, 'empty'); assert.equal(call.response.totalBytes, 0);
});

test('OPTIONS 204 response records empty observed content without an authenticated caller', async () => {
  const response = await send({ method: 'OPTIONS', token: false });
  assert.equal(response.status, 204);
  const call = ingress(await records());
  assert.equal(call.response.state, 'empty');
  assert.notEqual(call.authState, 'authenticated');
});

test('JSON-RPC error in an HTTP 200 response is an error outcome', async () => {
  handler = async (req, res) => {
    await getBody(req); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unsupported' } }));
  };
  const response = await send();
  assert.equal(response.status, 200);
  const call = ingress(await records());
  assert.equal(call.outcome, 'error'); assert.equal(call.protocolErrorCode, -32601);
});

test('invalid JSON preserves measured bytes without retaining invalid secret fragments', async () => {
  const body = '{"token":"invalid-fragment';
  const response = await send({ body });
  assert.equal(response.status, 400);
  const all = await records(), call = ingress(all);
  assert.equal(call.request.totalBytes, Buffer.byteLength(body));
  assert.equal(call.request.state, 'omitted'); assert.equal(call.request.reason, 'invalid_json');
  assert.ok(!JSON.stringify(all).includes('invalid-fragment'));
});

test('oversized JSON retains observed bytes while omitting body content', async () => {
  process.env.API_NOVA_AUDIT_MAX_BODY_BYTES = '64';
  const body = JSON.stringify({ token: 'oversized-secret', padding: 'x'.repeat(200) });
  const response = await send({ body });
  assert.equal(response.status, 413);
  const all = await records(), call = ingress(all);
  assert.equal(call.request.totalBytes, Buffer.byteLength(body));
  assert.equal(call.request.data, undefined);
  assert.ok(['omitted', 'incomplete'].includes(call.request.state));
  assert.ok(!JSON.stringify(all).includes('oversized-secret'));
});

test('handler failure after headers cannot be recorded as a complete successful response', async () => {
  handler = async (req, res) => {
    await getBody(req); res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"token":"partial-response-secret');
    throw new Error('private-handler-secret');
  };
  const response = await send();
  assert.equal(response.status, 200);
  const all = await records(), call = ingress(all);
  assert.equal(call.outcome, 'incomplete'); assert.equal(call.response.state, 'incomplete');
  assert.equal(call.response.data, undefined); assert.equal(call.errorCode, 'MCP_HANDLER_FAILED');
  assert.ok(!JSON.stringify(all).includes('partial-response-secret'));
  assert.ok(!JSON.stringify(all).includes('private-handler-secret'));
});

test('client response disconnect cancels the ingress once and releases captured memory', async () => {
  handler = async (req, res) => {
    await getBody(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    const interval = setInterval(() => res.write('data: next\n\n'), 10);
    res.once('close', () => clearInterval(interval));
  };
  await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/mcp',
      headers: { authorization: 'Bearer ' + token }, agent: false }, res => {
      res.once('data', () => { request.destroy(); resolve(); }); res.on('error', () => undefined);
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await sleep(30);
  const call = ingress(await records());
  assert.equal(call.outcome, 'cancelled'); assert.equal(call.response.state, 'incomplete');
  assert.equal(parser.getRuntimeAuditHealth().activeCalls, 0);
  assert.equal(parser.getRuntimeAuditHealth().captureMemoryBytes, 0);
});

test('aborted upload retains incomplete byte evidence and never captures the partial secret', async () => {
  let consuming;
  const ready = new Promise(resolve => { consuming = resolve; });
  handler = async (req, res) => { consuming(); await getBody(req); res.end('unexpected'); };
  const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/mcp', method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': '1000' }, agent: false });
  request.on('error', () => undefined);
  request.write('{"token":"upload-fragment');
  await ready; await sleep(10); request.destroy();
  await sleep(30);
  const all = await records(), call = ingress(all);
  assert.equal(call.outcome, 'cancelled'); assert.equal(call.request.state, 'incomplete');
  assert.ok(call.request.totalBytes > 0); assert.equal(call.request.data, undefined);
  assert.ok(!JSON.stringify(all).includes('upload-fragment'));
});

test('Tool permission rejection is linked to authenticated HTTP ingress with logical byte measurement', async () => {
  process.env.API_NOVA_MCP_TOOL_SCOPES = JSON.stringify({ sample: ['tool:invoke'] });
  handler = async (req, res) => { const body = await getBody(req); await assertMcpToolScopes(body); res.end('unexpected'); };
  const response = await send({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sample' } }) });
  assert.equal(response.status, 403);
  const all = await records(), protocol = ingress(all), tool = terminals(all).find(row => row.spanKind === 'mcp_tool');
  assert.ok(tool); assert.equal(tool.parentInvocationId, protocol.invocationId);
  assert.equal(tool.identitySource, 'authenticated');
  assert.equal(protocol.errorCategory, 'authorization');
  assert.equal(tool.byteMeasurement, 'serialized_payload');
  assert.equal(tool.measurementStage, 'logical_payload');
  assert.equal(protocol.authState, 'authenticated');
});

test('audit directory failure cannot replace an authenticated successful response', async () => {
  const blocker = path.join(root, 'blocked'); await fs.writeFile(blocker, 'fixture');
  process.env.API_NOVA_AUDIT_DIR = blocker;
  const before = parser.getRuntimeAuditHealth().writeFailures;
  const response = await send({ body: '{}' });
  await parser.flushRuntimeAudit();
  assert.equal(response.status, 200);
  assert.ok(parser.getRuntimeAuditHealth().writeFailures > before);
  assert.equal(parser.getRuntimeAuditHealth().activeCalls, 0);
  assert.equal(parser.getRuntimeAuditHealth().captureMemoryBytes, 0);
  assert.equal(getMcpHttpAuditHealth().instrumentationFailures, 0);
});
