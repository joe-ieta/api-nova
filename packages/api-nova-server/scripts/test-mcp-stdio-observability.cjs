'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');

async function fixtureMain() {
  const { z } = require('zod');
  const { createMcpServer, startStdioMcpServer } = require('../dist/index.js');
  const { flushRuntimeAudit, getRuntimeAuditHealth } = require('api-nova-parser');
  const notify = message => new Promise((resolve, reject) =>
    process.send(message, error => error ? reject(error) : resolve()));
  const config = JSON.parse(process.env.API_NOVA_STDIO_TEST_CONFIG);
  const spec = { openapi: '3.0.3', info: { title: 'STDIO audit fixture', version: '1' },
    servers: [{ url: config.origin }], paths: { '/echo': { post: {
      operationId: 'upstream_echo', 'x-runtime-asset-id': 'stdio-runtime',
      'x-endpoint-definition-id': 'stdio-endpoint', 'x-source-service-instance-id': 'stdio-upstream',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', properties: { message: { type: 'string' }, token: { type: 'string' } },
        required: ['message'],
      } } } }, responses: { '200': { description: 'OK' } },
    } } } };
  const server = await createMcpServer({ openApiData: spec, debugHeaders: config.debug === true },
    { registerSignalHandlers: false });
  server.registerTool('fixture_echo', { inputSchema: { value: z.string(), token: z.string().optional() } },
    async args => {
      await new Promise(resolve => setImmediate(resolve));
      return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    });
  server.registerTool('fixture_error', { inputSchema: {} }, async () => ({
    isError: true, content: [{ type: 'text', text: 'Expected fixture failure' }],
  }));
  server.registerTool('fixture_pending', { inputSchema: {} }, async () => {
    await notify({ kind: 'pending-entered' });
    return new Promise(() => undefined);
  });
  server.registerTool('fixture_bulk', { inputSchema: {} }, async () => {
    const result = { content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] };
    // Persist the started facts before Windows stdout can block this event loop.
    await flushRuntimeAudit();
    await notify({ kind: 'bulk-created' });
    return result;
  });
  let closing = false;
  process.on('message', async message => {
    try {
      if (message.op === 'snapshot') {
        await flushRuntimeAudit();
        await notify({ kind: 'snapshot', id: message.id, health: getRuntimeAuditHealth() });
      } else if (message.op === 'close' && !closing) {
        closing = true;
        await server.close();
        await flushRuntimeAudit();
        await notify({ kind: 'closed', health: getRuntimeAuditHealth() });
        process.disconnect();
      }
    } catch {
      process.stderr.write('[STDIO_FIXTURE_CONTROL_FAILED] Fixture control failed.\n');
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  });
  await startStdioMcpServer(server);
  await notify({ kind: 'ready' });
}

if (process.argv.includes('--fixture')) {
  fixtureMain().catch(() => {
    process.stderr.write('[STDIO_FIXTURE_START_FAILED] Fixture startup failed.\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
} else {
  const test = require('node:test');
  const { LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/sdk/types.js');

  async function createFixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'api-nova-stdio-audit-'));
    const auditDir = path.join(root, 'audit');
    if (options.failAudit) await fs.writeFile(auditDir, 'owned failure fixture');
    else await fs.mkdir(auditDir);
    const upstreamRequests = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        upstreamRequests.push({ headers: req.headers, body });
        const input = JSON.parse(body.toString('utf8'));
        res.writeHead(options.upstreamStatus || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: input.message, password: 'upstream-stdio-secret' }));
      });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, API_NOVA_AUDIT_DIR: auditDir, API_NOVA_AUDIT_SERVER_ID: 'stdio-fixture',
      API_NOVA_AUDIT_MAX_BODY_BYTES: String(16 * 1024 * 1024), NO_PROXY: '127.0.0.1,localhost',
      API_NOVA_STDIO_TEST_CONFIG: JSON.stringify({
        origin: 'http://127.0.0.1:' + upstream.address().port, debug: options.debug === true,
      }),
    };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'NODE_TEST_CONTEXT', 'API_NOVA_AUDIT_CAPTURE_BODY', 'API_NOVA_AUDIT_MEMORY_BUDGET_BYTES']) delete env[name];
    const child = spawn(process.execPath, [__filename, '--fixture'], {
      cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [], frames = [], invalid = [], waits = new Set();
    let stdoutBuffer = '', stderr = '', nextId = 10, controlId = 0, exitResult;
    let resolveExit;
    const exit = new Promise(resolve => { resolveExit = resolve; });
    const publish = value => {
      messages.push(value);
      for (const entry of [...waits]) if (entry.predicate(value)) {
        waits.delete(entry); clearTimeout(entry.timer); entry.resolve(value);
      }
    };
    const waitFor = (predicate, label, timeout = 8000) => {
      const ready = messages.find(predicate);
      if (ready) return Promise.resolve(ready);
      if (exitResult) return Promise.reject(new Error('Fixture already exited: ' + label));
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve, reject, timer: undefined };
        entry.timer = setTimeout(() => { waits.delete(entry); reject(new Error('Timed out: ' + label)); }, timeout);
        waits.add(entry);
      });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      let end;
      while ((end = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, end);
        stdoutBuffer = stdoutBuffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.jsonrpc !== '2.0') throw new Error('Non-protocol stdout');
          frames.push(frame); publish({ kind: 'frame', frame });
        } catch { invalid.push(line.slice(0, 160)); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => undefined);
    child.on('message', publish);
    child.on('error', error => {
      for (const entry of waits) { clearTimeout(entry.timer); entry.reject(error); }
      waits.clear();
    });
    child.on('exit', (code, signal) => {
      exitResult = { code, signal }; resolveExit(exitResult);
      for (const entry of waits) { clearTimeout(entry.timer); entry.reject(new Error('Fixture exited before response')); }
      waits.clear();
    });
    const post = (method, params, id = nextId++) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
      return id;
    };
    const response = id => waitFor(value => value.kind === 'frame' && value.frame.id === id, 'response ' + id)
      .then(value => value.frame);
    const request = (method, params) => response(post(method, params));
    const snapshot = async () => {
      const id = ++controlId;
      child.send({ op: 'snapshot', id });
      return waitFor(value => value.kind === 'snapshot' && value.id === id, 'audit snapshot');
    };
    const readJournal = async () => {
      if (options.failAudit) return [];
      const files = (await fs.readdir(auditDir)).filter(name => name.startsWith('calls-v2-'));
      assert.ok(files.length > 0, 'new source audit files must exist');
      return (await Promise.all(files.map(name => fs.readFile(path.join(auditDir, name), 'utf8'))))
        .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
    };
    const records = async () => {
      await snapshot();
      return readJournal();
    };
    const stop = async () => {
      if (exitResult) return exitResult;
      child.stdout.resume();
      child.send({ op: 'close' });
      await waitFor(value => value.kind === 'closed', 'graceful close');
      return Promise.race([exit, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not exit')), 5000);
        exit.finally(() => clearTimeout(timer));
      })]);
    };
    t.after(async () => {
      try {
        if (!exitResult) {
          try { await stop(); }
          catch {
            child.kill();
            await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1000))]);
          }
        }
      } finally {
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        const target = path.resolve(root);
        assert.equal(path.dirname(target), path.resolve(tmpdir()));
        assert.ok(path.basename(target).startsWith('api-nova-stdio-audit-'));
        await fs.rm(target, { recursive: true, force: true });
      }
    });
    // Send immediately, before fixture readiness, as a real STDIO client may do.
    const initializationId = post('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: 'stdio-audit-client', version: '1' } });
    await waitFor(value => value.kind === 'ready', 'startup');
    const initialized = await response(initializationId);
    assert.equal(initialized.error, undefined);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { child, request, post, response, snapshot, records, readJournal, stop, waitFor, frames, upstreamRequests,
      initializationId, auditDir, get stderr() { return stderr; },
      assertProtocolOutput() { assert.deepEqual(invalid, []); assert.equal(stdoutBuffer, ''); },
    };
  }

  function finished(rows, kind) {
    return rows.filter(row => row.phase === 'finished' && (!kind || row.spanKind === kind));
  }
  function protocolFor(rows, id) {
    const calls = finished(rows, 'mcp_protocol').filter(row => row.request?.data && JSON.parse(row.request.data).id === id);
    assert.equal(calls.length, 1, 'one protocol terminal for response id');
    return calls[0];
  }
  function assertChain(rows, protocol) {
    const tools = finished(rows, 'mcp_tool').filter(row => row.parentInvocationId === protocol.invocationId);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].traceId, protocol.traceId);
    assert.equal(tools[0].rootInvocationId, protocol.invocationId);
    assert.equal(tools[0].requestId, protocol.requestId);
    return tools[0];
  }

  test('real STDIO startup and tool discovery emit only protocol frames, including debug mode', { timeout: 20000 }, async t => {
    const f = await createFixture(t, { debug: true });
    const listed = await f.request('tools/list', {});
    assert.ok(listed.result.tools.some(tool => tool.name === 'fixture_echo'));
    const rows = await f.records();
    const initialization = protocolFor(rows, f.initializationId);
    assert.equal(initialization.outcome, 'success');
    assert.equal(initialization.protocolTransport, 'stdio');
    assert.equal(initialization.byteMeasurement, 'serialized_payload');
    assert.equal(initialization.measurementStage, 'logical_payload');
    assert.equal(initialization.identitySource, 'anonymous');
    assert.equal(initialization.clientIp, undefined);
    assert.equal(initialization.callerId, undefined);
    assert.equal(finished(rows, 'mcp_tool').length, 0);
    assert.equal(finished(rows, 'upstream_api').length, 0);
    const notifications = finished(rows, 'mcp_protocol').filter(row => row.method === 'notifications/initialized');
    assert.equal(notifications.length, 1); assert.equal(notifications[0].outcome, 'unknown');
    f.assertProtocolOutput();
  });

  test('real STDIO logical payload preserves scalar strings and redacts request/response secrets', { timeout: 20000 }, async t => {
    const f = await createFixture(t);
    const result = await f.request('tools/call', { name: 'fixture_echo', arguments: { value: '2.0 \u4e2d\u6587', token: 'stdio-request-secret' } });
    assert.equal(JSON.parse(result.result.content[0].text).token, 'stdio-request-secret');
    const rows = await f.records();
    const protocol = protocolFor(rows, result.id);
    const tool = assertChain(rows, protocol);
    assert.equal(tool.outcome, 'success');
    assert.equal(JSON.parse(tool.request.data).arguments.value, '2.0 \u4e2d\u6587');
    assert.equal(tool.byteMeasurement, 'serialized_payload');
    assert.equal(tool.response.state, 'complete');
    assert.ok(!JSON.stringify(rows).includes('stdio-request-secret'));
    assert.equal(finished(rows, 'upstream_api').length, 0);
    assert.equal((await f.snapshot()).health.activeCalls, 0);
    f.assertProtocolOutput();
  });

  test('real STDIO transformed tool links protocol, tool and one physical upstream request', { timeout: 20000 }, async t => {
    const f = await createFixture(t);
    const listed = await f.request('tools/list', {});
    const generated = listed.result.tools.filter(tool => !tool.name.startsWith('fixture_'));
    assert.equal(generated.length, 1);
    const result = await f.request('tools/call', { name: generated[0].name,
      arguments: { message: 'hello', token: 'stdio-upstream-request-secret' } });
    assert.equal(result.result.isError, false);
    const rows = await f.records();
    const protocol = protocolFor(rows, result.id), tool = assertChain(rows, protocol);
    const upstream = finished(rows, 'upstream_api');
    assert.equal(upstream.length, 1); assert.equal(f.upstreamRequests.length, 1);
    const call = upstream[0];
    assert.equal(call.parentInvocationId, tool.invocationId);
    assert.equal(call.traceId, protocol.traceId); assert.equal(call.rootInvocationId, protocol.invocationId);
    assert.equal(call.requestId, protocol.requestId);
    assert.equal(call.runtimeAssetId, 'stdio-runtime'); assert.equal(call.endpointDefinitionId, 'stdio-endpoint');
    assert.equal(call.protocolTransport, 'stdio');
    assert.equal(call.measurementStage, 'upstream_http'); assert.equal(call.byteMeasurement, 'observed_body');
    assert.equal(call.request.totalBytes, f.upstreamRequests[0].body.length);
    assert.equal(call.attemptIndex, 1); assert.equal(call.redirectHopIndex, 0);
    assert.equal(call.outcome, 'success');
    assert.ok(!JSON.stringify(rows).includes('stdio-upstream-request-secret'));
    assert.ok(!JSON.stringify(rows).includes('upstream-stdio-secret'));
    f.assertProtocolOutput();
  });

  test('real STDIO tool failures and JSON-RPC errors are not successful transport outcomes', { timeout: 20000 }, async t => {
    const f = await createFixture(t);
    const failed = await f.request('tools/call', { name: 'fixture_error', arguments: {} });
    const unknown = await f.request('fixture/unknown-method', {});
    assert.equal(failed.result.isError, true); assert.equal(unknown.error.code, -32601);
    const rows = await f.records();
    const tool = assertChain(rows, protocolFor(rows, failed.id));
    assert.equal(tool.outcome, 'error'); assert.equal(tool.toolIsError, true);
    assert.equal(protocolFor(rows, failed.id).outcome, 'error');
    const protocolError = protocolFor(rows, unknown.id);
    assert.equal(protocolError.outcome, 'error'); assert.equal(protocolError.protocolErrorCode, -32601);
    assert.equal(finished(rows, 'upstream_api').length, 0);
    f.assertProtocolOutput();
  });

  test('real STDIO concurrent calls have separate trace trees and exactly one terminal per invocation', { timeout: 20000 }, async t => {
    const f = await createFixture(t);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, id) =>
      f.request('tools/call', { name: 'fixture_echo', arguments: { value: String(id) } })));
    const rows = await f.records();
    const protocols = responses.map(result => protocolFor(rows, result.id));
    assert.equal(new Set(protocols.map(row => row.traceId)).size, 8);
    responses.forEach((result, index) => {
      const tool = assertChain(rows, protocols[index]);
      assert.equal(JSON.parse(tool.request.data).arguments.value, String(index));
      assert.equal(JSON.parse(result.result.content[0].text).value, String(index));
    });
    const terminals = finished(rows);
    assert.equal(new Set(terminals.map(row => row.invocationId)).size, terminals.length);
    assert.equal((await f.snapshot()).health.activeCalls, 0);
    f.assertProtocolOutput();
  });

  test('explicit server shutdown cancels a real STDIO pending call and flushes before process exit', { timeout: 20000 }, async t => {
    const f = await createFixture(t);
    const id = f.post('tools/call', { name: 'fixture_pending', arguments: {} });
    await f.waitFor(value => value.kind === 'pending-entered', 'pending handler');
    assert.equal((await f.snapshot()).health.activeCalls, 2);
    const result = await f.stop();
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    const files = (await fs.readdir(f.auditDir)).filter(name => name.startsWith('calls-v2-'));
    const rows = (await Promise.all(files.map(name => fs.readFile(path.join(f.auditDir, name), 'utf8'))))
      .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const protocol = protocolFor(rows, id), tool = assertChain(rows, protocol);
    for (const call of [protocol, tool]) {
      assert.equal(call.outcome, 'cancelled'); assert.equal(call.errorCode, 'MCP_SESSION_CLOSED');
      assert.equal(call.response, undefined);
    }
    assert.equal(f.frames.some(frame => frame.id === id), false);
    f.assertProtocolOutput();
  });

  test('real STDIO output backpressure delays successful terminals until the reader resumes', { timeout: 25000 }, async t => {
    const f = await createFixture(t);
    f.child.stdout.pause();
    const id = f.post('tools/call', { name: 'fixture_bulk', arguments: {} });
    await f.waitFor(value => value.kind === 'bulk-created', 'bulk response created');
    // Observe from the parent only while Windows synchronous stdout blocks the child.
    // Buffered pipe bytes prove the actual response write has begun, without consuming it.
    const deadline = Date.now() + 8000;
    while (f.child.stdout.readableLength === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(f.child.stdout.readableLength > 0, 'response bytes must reach the paused reader');
    const during = await f.readJournal();
    const protocolStarts = during.filter(row => row.phase === 'started' && row.spanKind === 'mcp_protocol'
      && row.request?.data && JSON.parse(row.request.data).id === id);
    assert.equal(protocolStarts.length, 1, 'protocol started evidence must already be durable');
    const toolStarts = during.filter(row => row.phase === 'started' && row.spanKind === 'mcp_tool'
      && row.parentInvocationId === protocolStarts[0].invocationId);
    assert.equal(toolStarts.length, 1, 'tool started evidence must already be durable');
    const pendingIds = new Set([protocolStarts[0].invocationId, toolStarts[0].invocationId]);
    assert.equal(finished(during).filter(row => pendingIds.has(row.invocationId)).length, 0,
      'neither protocol nor tool may finish before the reader resumes');
    f.child.stdout.resume();
    const response = await f.response(id);
    assert.equal(response.result.content[0].text.length, 8 * 1024 * 1024);
    const rows = await f.records();
    const protocol = protocolFor(rows, id), tool = assertChain(rows, protocol);
    assert.equal(protocol.outcome, 'success'); assert.equal(tool.outcome, 'success');
    assert.equal((await f.snapshot()).health.activeCalls, 0);
    f.assertProtocolOutput();
  });

  test('real STDIO audit storage failure preserves protocol success and reports only safe diagnostics', { timeout: 20000 }, async t => {
    const f = await createFixture(t, { failAudit: true });
    const response = await f.request('tools/call', { name: 'fixture_echo',
      arguments: { value: 'business-ok', token: 'must-not-reach-stderr' } });
    assert.equal(JSON.parse(response.result.content[0].text).value, 'business-ok');
    const snapshot = await f.snapshot();
    assert.ok(snapshot.health.writeFailures > 0); assert.equal(snapshot.health.activeCalls, 0);
    assert.ok(f.stderr.includes('RUNTIME_AUDIT_WRITE_FAILED'));
    assert.ok(!f.stderr.includes('must-not-reach-stderr'));
    f.assertProtocolOutput();
  });
}
