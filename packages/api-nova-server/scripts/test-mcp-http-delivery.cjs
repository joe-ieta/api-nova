'use strict';

// Run after the coordinating task builds api-nova-server. Never builds dist.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { startSseMcpServer, startStreamableMcpServer } = require('../dist/index.js');
const { flushRuntimeAudit, getRuntimeAuditHealth } = require('api-nova-parser');

const BULK_BYTES = 16 * 1024 * 1024;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(operation, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.fail('Timed out: ' + label);
}
function parseResponse(text) {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const frames = text.split('\n').filter(line => line.startsWith('data: '))
    .map(line => line.slice(6)).filter(Boolean).map(line => JSON.parse(line));
  return frames.findLast(frame => Object.hasOwn(frame, 'id'));
}
async function readResponse(res) {
  res.socket?.resume();
  const chunks = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function fixture(t, transport, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'api-nova-http-delivery-'));
  const original = { ...process.env };
  process.env.API_NOVA_AUDIT_DIR = root;
  process.env.API_NOVA_RUNTIME_AUTH_MODE = 'anonymous';
  process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = '';
  process.env.API_NOVA_MCP_TOOL_SCOPES = '{}';
  process.env.API_NOVA_AUDIT_MAX_BODY_BYTES = '65536';
  delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
  delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
  const calls = new Map(), clients = new Set(), responses = [];
  const makeServer = async () => {
    const server = new McpServer({ name: 'http-delivery-fixture', version: '1' });
    server.registerTool('delivery_fixture', { inputSchema: { key: z.string(), mode: z.string() } },
      async ({ key, mode }) => {
        const gate = calls.get(key);
        gate.entered.resolve();
        await gate.release.promise;
        gate.returned.resolve();
        if (mode === 'error') return { isError: true, content: [{ type: 'text', text: 'Expected tool failure' }] };
        return { content: [{ type: 'text', text: mode === 'bulk' ? 'x'.repeat(BULK_BYTES) : key }] };
      });
    return server;
  };
  let server, sseResponse, endpoint, session, nextId = 1, sseBuffer = '';
  const frames = [];
  t.after(async () => {
    for (const gate of calls.values()) gate.release.resolve();
    for (const request of clients) request.destroy();
    sseResponse?.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
    await flushRuntimeAudit();
    process.env = original;
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('api-nova-http-delivery-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  if (options.native) {
    const { randomUUID } = require('node:crypto');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { InMemoryEventStore } = require('../dist/tools/InMemoryEventStore.js');
    const { createBaseHttpServer } = require('../dist/tools/httpServer.js');
    const { getBody } = require('../dist/tools/getBody.js');
    const nativeServer = await makeServer();
    const nativeTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, eventStore: new InMemoryEventStore(),
      enableDnsRebindingProtection: true,
    });
    await nativeServer.connect(nativeTransport);
    server = await createBaseHttpServer(0, '/mcp', {
      serverType: 'HTTP Streamable Server',
      handleRequest: async (req, res) => {
        const body = req.method === 'POST' ? await getBody(req) : undefined;
        await nativeTransport.handleRequest(req, res, body);
      },
      cleanup: () => { void nativeServer.close(); },
    }, '127.0.0.1');
  } else {
    server = transport === 'sse'
      ? await startSseMcpServer(makeServer, '/sse', 0, { host: '127.0.0.1' })
      : await startStreamableMcpServer(makeServer, '/mcp', 0, { host: '127.0.0.1' });
  }
  if (!server.listening) await once(server, 'listening');
  // Read-only observation of real ServerResponse buffers, with no mocked writes.
  server.on('request', (req, res) => { responses.push({ req, res }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  function open(method, url, message) {
    const headers = { accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26' };
    if (message) headers['content-type'] = 'application/json';
    if (session) headers['mcp-session-id'] = session;
    const request = http.request(new URL(url, origin), { method, headers });
    clients.add(request);
    request.once('close', () => clients.delete(request));
    const received = new Promise((resolve, reject) => {
      request.once('response', res => {
        // Keep the actual socket reader paused until the test consumes it.
        res.pause();
        res.socket?.pause();
        res.on('error', () => undefined);
        resolve(res);
      });
      request.once('error', reject);
    });
    void received.catch(() => undefined);
    request.end(message ? JSON.stringify(message) : undefined);
    return { request, received };
  }
  const frame = id => eventually(() => frames.find(value => value.id === id), 'SSE response ' + id);
  if (transport === 'sse') {
    const stream = open('GET', '/sse');
    sseResponse = await stream.received;
    assert.equal(sseResponse.statusCode, 200);
    sseResponse.setEncoding('utf8');
    sseResponse.on('data', chunk => {
      sseBuffer += chunk;
      let end;
      while ((end = sseBuffer.indexOf('\n\n')) >= 0) {
        const event = sseBuffer.slice(0, end);
        sseBuffer = sseBuffer.slice(end + 2);
        const data = event.split('\n').find(line => line.startsWith('data: '))?.slice(6);
        if (!data) continue;
        if (event.startsWith('event: endpoint')) endpoint = data;
        else frames.push(JSON.parse(data));
      }
    });
    sseResponse.socket?.resume();
    sseResponse.resume();
    await eventually(() => endpoint, 'SSE endpoint');
  } else endpoint = '/mcp';
  async function rpc(message) {
    const call = open('POST', endpoint, message);
    const res = await call.received;
    const body = await readResponse(res);
    if (transport === 'sse') {
      assert.equal(res.statusCode, 202);
      return Object.hasOwn(message, 'id') ? frame(message.id) : undefined;
    }
    assert.ok(res.statusCode === 200 || res.statusCode === 202);
    session ||= res.headers['mcp-session-id'];
    return body ? parseResponse(body) : undefined;
  }
  const initialized = await rpc({ jsonrpc: '2.0', id: nextId++, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-http-fixture', version: '1' } } });
  assert.equal(initialized.result.protocolVersion, '2025-03-26');
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  async function rows() {
    await flushRuntimeAudit();
    const files = (await fs.readdir(root)).filter(name => name.startsWith('calls-v2-'));
    return (await Promise.all(files.map(name => fs.readFile(path.join(root, name), 'utf8'))))
      .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  function call(mode) {
    const id = nextId++, key = 'call-' + id;
    const gate = { entered: deferred(), release: deferred(), returned: deferred() };
    calls.set(key, gate);
    const raw = open('POST', endpoint, { jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'delivery_fixture', arguments: { key, mode } } });
    const accepted = transport === 'sse' ? raw.received.then(async res => {
      assert.equal(res.statusCode, 202);
      await readResponse(res);
    }) : Promise.resolve();
    void accepted.catch(() => undefined);
    return { id, ...gate, raw,
      async complete() {
        await accepted;
        if (transport === 'sse') return frame(id);
        const res = await raw.received;
        assert.equal(res.statusCode, 200);
        return parseResponse(await readResponse(res));
      },
      disconnect() {
        if (transport === 'sse') sseResponse.destroy();
        else {
          raw.request.destroy();
          void raw.received.then(res => res.destroy(), () => undefined);
        }
      },
    };
  }
  const tools = records => records.filter(row => row.spanKind === 'mcp_tool' && row.phase === 'finished');
  return { call, rows, tools, frames,
    pause() { sseResponse?.pause(); sseResponse?.socket?.pause(); },
    resume() { sseResponse?.socket?.resume(); sseResponse?.resume(); },
    holdWrites() {
      const output = responses.findLast(({ req, res }) =>
        req.method === (transport === 'sse' ? 'GET' : 'POST') && !res.writableEnded)?.res;
      assert.ok(output, 'active native HTTP response');
      // Windows loopback can acknowledge a large write before a paused peer reads it.
      // Native cork makes the local queued-write boundary deterministic, without
      // replacing write(), its callback, or the SDK's serialization/routing.
      output.cork();
      return () => output.uncork();
    },
    outputState() {
      const output = responses.findLast(({ req }) => req.method === 'POST')?.res;
      return { corked: output?.writableCorked, buffered: output?.writableLength,
        finished: output?.writableFinished, needDrain: output?.writableNeedDrain,
        socketBuffered: output?.socket?.writableLength };
    },
    deliveryFinished() {
      return responses.findLast(({ req }) => req.method === 'POST')?.res.writableFinished === true;
    },
    async blocked() {
      try {
        return await eventually(() => responses.find(({ req, res }) =>
          req.method === (transport === 'sse' ? 'GET' : 'POST') &&
          (res.writableLength > 0 || (res.socket?.writableLength || 0) > 0)), 'real HTTP write backpressure');
      } catch (error) {
        console.error('DELIVERY_DIAGNOSTIC', JSON.stringify({ responses: responses.map(({ req, res }) => ({ method: req.method,
          ended: res.writableEnded, finished: res.writableFinished, buffered: res.writableLength,
          socketBuffered: res.socket?.writableLength })), tools: tools(await rows()).map(row => ({ outcome: row.outcome,
            response: row.response && { state: row.response.state, totalBytes: row.response.totalBytes } })) }));
        throw error;
      }
    },
    async terminal() {
      return eventually(async () => {
        const records = await rows();
        return tools(records).length ? records : undefined;
      }, 'Tool terminal');
    },
  };
}

for (const transport of ['sse', 'streamable']) {
  test(transport + ': real paused reader records success only after local HTTP delivery', { timeout: 25000 }, async t => {
    const f = await fixture(t, transport);
    f.pause();
    const call = f.call('bulk');
    await call.entered.promise;
    const releaseWrites = transport === 'sse' ? f.holdWrites() : undefined;
    call.release.resolve();
    if (transport === 'sse') await f.blocked();
    else await call.raw.received;
    const during = await f.rows();
    assert.equal(during.filter(row => row.spanKind === 'mcp_tool' && row.phase === 'started').length, 1);
    if (transport === 'sse') {
      assert.equal(f.tools(during).length, 0, 'SDK write return must not finalize a queued Tool response');
    } else {
      // A paused peer is not a missing local write ACK on Windows loopback.
      // Success is legal only after the actual ServerResponse has finished.
      for (const tool of f.tools(during)) {
        assert.equal(f.deliveryFinished(), true, 'Tool success requires native HTTP finish');
        assert.equal(tool.outcome, 'success');
      }
    }
    releaseWrites?.();
    f.resume();
    const response = await call.complete();
    assert.equal(response.result.content[0].text.length, BULK_BYTES);
    const tools = f.tools(await f.terminal());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].outcome, 'success');
    assert.equal(tools[0].protocolTransport, transport);
  });

  test(transport + ': disconnect during actual buffered send records incomplete failure', { timeout: 25000 }, async t => {
    const f = await fixture(t, transport);
    f.pause();
    const call = f.call('bulk');
    await call.entered.promise;
    const releaseWrites = f.holdWrites();
    call.release.resolve();
    await f.blocked();
    assert.equal(f.tools(await f.rows()).length, 0);
    call.disconnect();
    const tools = f.tools(await f.terminal());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].outcome, 'error');
    assert.equal(tools[0].errorCode, 'MCP_SEND_FAILED');
    assert.equal(tools[0].response.state, 'incomplete');
    assert.equal(tools[0].response.data, undefined);
    assert.equal(f.frames.some(frame => frame.id === call.id), false);
    await eventually(() => getRuntimeAuditHealth().activeCalls === 0, 'released disconnected calls');
  });

  test(transport + ': disconnect before result cancels once and late completion cannot succeed', { timeout: 20000 }, async t => {
    const f = await fixture(t, transport);
    const call = f.call('echo');
    await call.entered.promise;
    call.disconnect();
    const tools = f.tools(await f.terminal());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].outcome, 'cancelled');
    assert.equal(tools[0].response, undefined);
    call.release.resolve();
    await call.returned.promise;
    await new Promise(resolve => setImmediate(resolve));
    const after = f.tools(await f.rows());
    assert.equal(after.length, 1);
    assert.equal(after[0].outcome, 'cancelled');
    await eventually(() => getRuntimeAuditHealth().activeCalls === 0, 'released cancelled calls');
  });

  test(transport + ': real Tool isError remains an error after successful HTTP delivery', { timeout: 20000 }, async t => {
    const f = await fixture(t, transport);
    const call = f.call('error');
    await call.entered.promise;
    call.release.resolve();
    assert.equal((await call.complete()).result.isError, true);
    const tools = f.tools(await f.terminal());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].outcome, 'error');
    assert.equal(tools[0].toolIsError, true);
    assert.equal(tools[0].response.state, 'complete');
  });
}

// Bounded A/B reproduction, not a passing claim for the recovery path.
// Both variants share the same HTTP ingress, tool, event store and real client.
test('streamable: bounded native SDK versus audited cork recovery comparison', { timeout: 20000 }, async t => {
  const outcomes = {};
  for (const variant of ['native', 'audited']) {
    await t.test(variant, { timeout: 9000 }, async subtest => {
      const f = await fixture(subtest, 'streamable', { native: variant === 'native' });
      const call = f.call('bulk');
      await call.entered.promise;
      const releaseWrites = f.holdWrites();
      call.release.resolve();
      await f.blocked();
      releaseWrites();
      const completed = call.complete();
      let timer;
      const result = await Promise.race([
        completed.then(response => ({ status: 'completed', response }),
          error => ({ status: 'error', error: error.code || error.message })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), 3000); }),
      ]);
      clearTimeout(timer);
      const state = f.outputState();
      outcomes[variant] = { status: result.status, state };
      subtest.diagnostic(JSON.stringify({ variant, node: process.version, platform: process.platform,
        bytes: BULK_BYTES, deadlineMs: 3000, ...outcomes[variant] }));
      if (result.status === 'completed') {
        assert.equal(result.response.result.content[0].text.length, BULK_BYTES);
        assert.equal(state.finished, true);
      } else {
        assert.equal(result.status, 'timeout', 'unexpected transport error');
        assert.equal(state.corked, 0);
        assert.equal(state.buffered, 0);
        assert.equal(state.finished, false);
        assert.equal(state.needDrain, true);
        if (variant === 'audited') {
          assert.equal(f.tools(await f.rows()).length, 0, 'unconfirmed delivery cannot become success');
        }
      }
      call.disconnect();
      await completed.catch(() => undefined);
      if (variant === 'audited' && result.status === 'timeout') {
        const terminal = f.tools(await f.terminal());
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].outcome, 'error');
        assert.equal(terminal[0].response.state, 'incomplete');
      }
    });
  }
  assert.equal(outcomes.audited.status, outcomes.native.status,
    'audited transport must match the original SDK recovery result');
  t.diagnostic(outcomes.native.status === 'timeout'
    ? 'SDK_BASELINE_LIMITATION: both transports stall after native cork/uncork with needDrain=true; recovery is not accepted.'
    : 'Both native SDK and audited transport completed cork/uncork recovery.');
});
