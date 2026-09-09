'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const parser = require('api-nova-parser');
const { instrumentMcpTransport, getMcpTransportAuditHealth } = require('../dist/transportUtils/audit.js');
let root, environment, transports;
beforeEach(async () => {
  environment = { ...process.env };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-mcp-transport-'));
  process.env.API_NOVA_AUDIT_DIR = root;
  delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
  delete process.env.API_NOVA_AUDIT_MAX_BODY_BYTES;
  delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
  transports = [];
});
afterEach(async () => {
  for (const transport of transports) transport.onclose?.();
  await parser.flushRuntimeAudit();
  process.env = environment;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('api-nova-mcp-transport-'));
  await fs.rm(root, { recursive: true, force: true });
});
function fixture(send = async () => undefined, receive = () => undefined) {
  const transport = { send, onmessage: receive, onclose() {}, sessionId: 'private-session-secret' };
  transports.push(transport);
  instrumentMcpTransport(transport);
  return transport;
}
function request(id = 1, name = 'sample') {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { token: 'argument-secret' } } };
}
function response(id = 1, isError = false) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }], isError } };
}
async function records() {
  await parser.flushRuntimeAudit();
  const names = (await fs.readdir(root)).filter(name => name.startsWith('calls-v2-'));
  const all = (await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))))
    .flatMap(value => value.split('\n').filter(Boolean).map(value => JSON.parse(value)));
  for (const record of all) parser.normalizeRuntimeAuditRecord(record);
  return all;
}
function terminal(all, kind) { return all.filter(row => row.phase === 'finished' && (!kind || row.spanKind === kind)); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('STDIO tool request has a protocol parent and explicit child execution context', async () => {
  let context;
  const transport = fixture(undefined, () => { context = parser.getRuntimeCallContext(); });
  transport.onmessage(request());
  await transport.send(response());
  const all = await records(), protocol = terminal(all, 'mcp_protocol')[0], tool = terminal(all, 'mcp_tool')[0];
  assert.equal(terminal(all).length, 2);
  assert.equal(tool.parentInvocationId, protocol.invocationId);
  assert.equal(tool.rootInvocationId, protocol.invocationId);
  assert.equal(tool.traceId, protocol.traceId);
  assert.equal(context.parentInvocationId, tool.invocationId);
  assert.equal(context.rootInvocationId, protocol.invocationId);
  assert.equal(context.traceId, protocol.traceId);
  assert.equal(protocol.protocolTransport, 'stdio');
  assert.equal(protocol.byteMeasurement, 'serialized_payload');
  assert.equal(tool.outcome, 'success');
  assert.equal(tool.toolIsError, false);
  assert.ok(!JSON.stringify(all).includes('argument-secret'));
  assert.ok(!JSON.stringify(all).includes('private-session-secret'));
});

test('successful finish waits for the original transport send promise', async () => {
  const send = deferred();
  const transport = fixture(() => send.promise);
  transport.onmessage(request());
  const pendingSend = transport.send(response());
  assert.equal(terminal(await records()).length, 0);
  send.resolve();
  await pendingSend;
  assert.equal(terminal(await records()).length, 2);
});

test('send rejection remains the original error and no successful terminal is written', async () => {
  const error = new Error('private-send-secret');
  const transport = fixture(async () => { throw error; });
  transport.onmessage(request());
  await assert.rejects(transport.send(response()), value => value === error);
  const all = await records();
  assert.equal(terminal(all).length, 2);
  for (const row of terminal(all)) {
    assert.equal(row.outcome, 'error');
    assert.equal(row.errorCode, 'MCP_SEND_FAILED');
    assert.equal(row.failureStage, 'protocol_send');
    assert.equal(row.response.state, 'incomplete');
    assert.equal(row.response.data, undefined);
  }
  assert.ok(!JSON.stringify(all).includes('private-send-secret'));
});

test('tool isError and JSON-RPC errors are recorded independently from transport success', async () => {
  const transport = fixture();
  transport.onmessage(request(1)); await transport.send(response(1, true));
  transport.onmessage(request(2)); await transport.send({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'unsupported' } });
  const tools = terminal(await records(), 'mcp_tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].outcome, 'error'); assert.equal(tools[0].toolIsError, true);
  assert.equal(tools[1].protocolErrorCode, -32601); assert.equal(tools[1].errorCategory, 'protocol');
});

test('non-tool STDIO requests produce protocol facts without invented tool calls', async () => {
  const transport = fixture();
  transport.onmessage({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} });
  await transport.send({ jsonrpc: '2.0', id: 'init', result: { protocolVersion: 'fixture' } });
  const all = await records();
  assert.equal(terminal(all, 'mcp_protocol').length, 1);
  assert.equal(terminal(all, 'mcp_tool').length, 0);
  assert.equal(terminal(all)[0].method, 'initialize');
});

test('notifications have no fabricated response acknowledgement', async () => {
  const transport = fixture();
  transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const rows = terminal(await records());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'unknown');
  assert.equal(rows[0].response, undefined);
});

test('incoming responses and outgoing unrelated notifications are passed through unchanged', async () => {
  let received, sent;
  const transport = fixture(async message => { sent = message; }, message => { received = message; });
  const incoming = response('server-request'), outgoing = { jsonrpc: '2.0', method: 'notifications/progress', params: {} };
  transport.onmessage(incoming);
  await transport.send(outgoing);
  assert.equal(received, incoming); assert.equal(sent, outgoing);
  assert.equal(terminal(await records()).length, 0);
});

test('HTTP protocol parent is reused rather than creating a second protocol fact', async () => {
  const parent = parser.beginRuntimeCall({ transport: 'mcp', requestId: 'http-request', identitySource: 'anonymous' }, 'admission');
  let context;
  const transport = fixture(undefined, () => { context = parser.getRuntimeCallContext(); });
  parser.withRuntimeCallContext({ transport: 'mcp', requestId: parent.record.requestId, identitySource: 'anonymous',
    spanKind: 'mcp_protocol', protocolTransport: 'streamable', traceId: parent.record.traceId,
    rootInvocationId: parent.record.rootInvocationId, parentInvocationId: parent.record.invocationId,
  }, () => transport.onmessage(request()));
  await transport.send(response());
  await parent.finish({ outcome: 'success' });
  const all = await records();
  assert.equal(terminal(all, 'mcp_protocol').length, 1);
  const tool = terminal(all, 'mcp_tool')[0];
  assert.equal(tool.parentInvocationId, parent.record.invocationId);
  assert.equal(tool.traceId, parent.record.traceId);
  assert.equal(tool.protocolTransport, 'streamable');
  assert.equal(context.parentInvocationId, tool.invocationId);
});

test('concurrent STDIO requests retain separate trace trees and request ids', async () => {
  const transport = fixture();
  for (let id = 0; id < 8; id++) transport.onmessage(request(id));
  await Promise.all(Array.from({ length: 8 }, (_, id) => transport.send(response(7 - id))));
  const all = await records(), protocols = terminal(all, 'mcp_protocol'), tools = terminal(all, 'mcp_tool');
  assert.equal(protocols.length, 8); assert.equal(tools.length, 8);
  assert.equal(new Set(protocols.map(row => row.traceId)).size, 8);
  for (const tool of tools) {
    const parent = protocols.find(row => row.invocationId === tool.parentInvocationId);
    assert.ok(parent); assert.equal(tool.requestId, parent.requestId); assert.equal(tool.traceId, parent.traceId);
  }
});

test('session close during send cancels exactly once even if the send later resolves', async () => {
  const send = deferred(), transport = fixture(() => send.promise);
  transport.onmessage(request());
  const pending = transport.send(response());
  transport.onclose();
  send.resolve(); await pending; transport.onclose();
  const rows = terminal(await records());
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.outcome, 'cancelled');
});

test('synchronous handler errors preserve identity and release pending entries', async () => {
  const error = new Error('private-dispatch-secret');
  const transport = fixture(undefined, () => { throw error; });
  assert.throws(() => transport.onmessage(request()), value => value === error);
  const all = await records();
  assert.equal(terminal(all).length, 2);
  for (const row of terminal(all)) assert.equal(row.errorCode, 'MCP_DISPATCH_FAILED');
  assert.ok(!JSON.stringify(all).includes('private-dispatch-secret'));
});

test('duplicate request id rejection does not remove the original pending call', async () => {
  const sent = [], transport = fixture(async message => { sent.push(message); });
  transport.onmessage(request()); transport.onmessage(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.equal(sent[0].error.code, -32000);
  await transport.send(response());
  const tools = terminal(await records(), 'mcp_tool');
  assert.equal(tools.length, 2);
  assert.ok(tools.some(row => row.errorCode === 'MCP_CONCURRENT_CALL_LIMIT'));
  assert.ok(tools.some(row => row.outcome === 'success'));
});

test('instrumentation applied twice does not double count or wrap send twice', async () => {
  let count = 0;
  const transport = fixture(async () => { count++; });
  instrumentMcpTransport(transport);
  transport.onmessage(request()); await transport.send(response());
  assert.equal(count, 1); assert.equal(terminal(await records()).length, 2);
});

test('numeric and string JSON-RPC ids do not collide', async () => {
  const transport = fixture();
  transport.onmessage(request(1)); transport.onmessage(request('1'));
  await transport.send(response(1)); await transport.send(response('1'));
  assert.equal(terminal(await records(), 'mcp_tool').length, 2);
});

test('audit filesystem failure leaves the original send result intact and releases calls', async () => {
  const blocker = path.join(root, 'blocked');
  await fs.writeFile(blocker, 'fixture');
  process.env.API_NOVA_AUDIT_DIR = blocker;
  const before = parser.getRuntimeAuditHealth().writeFailures;
  const marker = {}, transport = fixture(async () => marker);
  transport.onmessage(request());
  assert.equal(await transport.send(response()), marker);
  await parser.flushRuntimeAudit();
  assert.ok(parser.getRuntimeAuditHealth().writeFailures > before);
  assert.equal(parser.getRuntimeAuditHealth().activeCalls, 0);
  assert.equal(getMcpTransportAuditHealth().instrumentationFailures, 0);
});
