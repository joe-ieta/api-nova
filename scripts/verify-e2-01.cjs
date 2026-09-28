'use strict';
// SEC-E2-01: current-artifact security joint matrix.
// Aggregates the authoritative existing suites for cancellation, timeout, replay
// and shutdown across Streamable HTTP, SSE, real stdio child and managed IPC, then
// fills the genuine gaps with local controlled scenarios. Loopback only, synthetic
// values, trusted mode stays default-off, no external network, no SDK upgrade.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const apiRoot = path.join(repoRoot, 'packages', 'api-nova-api');
const serverRoot = path.join(repoRoot, 'packages', 'api-nova-server');
const parserRoot = path.join(repoRoot, 'packages', 'api-nova-parser');
const tempBase = process.env.E2_01_TEMP || path.join(path.parse(repoRoot).root, 'temp', 'opencode', 'e2-01');
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.realpathSync.native(tempBase);
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-e2-01-'));

function newestSource(root) {
  let newest = 0;
  const visit = entry => {
    for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
      const target = path.join(entry, item.name);
      if (item.isDirectory()) { if (!['node_modules', 'dist', 'docs'].includes(item.name)) visit(target); continue; }
      if (!item.name.endsWith('.ts') || /\.(spec|test)\.ts$/.test(item.name)) continue;
      newest = Math.max(newest, fs.statSync(target).mtimeMs);
    }
  };
  visit(root);
  return newest;
}
function assertFresh(artifact, sourcesRoot, command) {
  if (process.env.E2_01_SKIP_FRESHNESS === '1') return;
  if (fs.statSync(artifact).mtimeMs < newestSource(sourcesRoot)) {
    throw new Error(`stale built artifact ${artifact}; run: ${command}`);
  }
}
const SERVER_DIST = path.join(serverRoot, 'dist', 'index.js');
const PARSER_DIST = path.join(parserRoot, 'dist', 'index.js');
const MANAGED_ENTRY = path.join(serverRoot, 'dist', 'managed', 'entry.js');
assertFresh(SERVER_DIST, path.join(serverRoot, 'src'), 'npm run build --workspace api-nova-server');
assertFresh(MANAGED_ENTRY, path.join(serverRoot, 'src'), 'npm run build --workspace api-nova-server');
assertFresh(PARSER_DIST, path.join(parserRoot, 'src'), 'npm run build --workspace api-nova-parser');

const parser = require(PARSER_DIST);
const { startStreamableMcpServer, startSseMcpServer } = require(SERVER_DIST);
const { registerManagedMcpTools } = require(path.join(serverRoot, 'dist', 'tools', 'initTools.js'));
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const LATEST_PROTOCOL = '2025-11-25';
const FAMILIES = ['cancellation', 'timeout', 'replay', 'shutdown'];
const TRANSPORTS = ['streamable', 'sse', 'stdio', 'managed-ipc'];
const CREDENTIALS = [
  { id: 'e2-key-a', subject: 'e2-owner-a', secret: 'e2-01-key-alpha' },
  { id: 'e2-key-b', subject: 'e2-owner-b', secret: 'e2-01-key-beta' },
];
const API_KEY_A = CREDENTIALS[0].secret;
const API_KEY_B = CREDENTIALS[1].secret;
const SYSTEM_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ'];
const TRACK = { listeners: [], upstreams: [], children: [] };

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const finishedTools = rows => rows.filter(row => row.spanKind === 'mcp_tool' && row.phase === 'finished');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(probe, timeout = 10000, label = 'condition') {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await probe(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}
async function unreachable(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
function systemEnvironment() {
  const env = {};
  for (const name of Object.keys(process.env)) if (SYSTEM_ENV.includes(name.toUpperCase())) env[name] = process.env[name];
  return env;
}
function apiKeysJson() {
  const expiresAt = Math.floor(Date.now() / 1000) + 900;
  return JSON.stringify(CREDENTIALS.map(credential => ({ id: credential.id, subject: credential.subject,
    secretHash: hash(credential.secret), resources: ['https://e2-01.invalid/mcp'], scopes: [], expiresAt })));
}

const SCENARIO_ENV_KEYS = ['API_NOVA_AUDIT_DIR', 'API_NOVA_RUNTIME_AUTH_MODE', 'API_NOVA_MCP_RESOURCE',
  'API_NOVA_RUNTIME_REQUIRED_SCOPES', 'API_NOVA_MCP_TOOL_SCOPES', 'API_NOVA_RUNTIME_API_KEYS'];
async function withScenarioEnvironment(auditDir, fn) {
  const saved = new Map(SCENARIO_ENV_KEYS.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    API_NOVA_AUDIT_DIR: auditDir,
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: 'https://e2-01.invalid/mcp',
    API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
    API_NOVA_MCP_TOOL_SCOPES: '{}',
    API_NOVA_RUNTIME_API_KEYS: apiKeysJson(),
  });
  try { return await fn(); }
  finally {
    await parser.flushRuntimeAudit().catch(() => undefined);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

async function auditRows(root) {
  await parser.flushRuntimeAudit();
  const rows = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('calls-v2-')) continue;
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const line of text.split(/\r?\n/)) if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

async function startUpstream() {
  const received = [];
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const server = http.createServer(async (request, response) => {
    received.push({ path: request.url, method: request.method, headers: { ...request.headers } });
    if (request.url === '/hang') return;
    if (request.url === '/slow') await slowGate;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  const upstream = {
    port: server.address().port, received,
    count: urlPath => received.filter(entry => entry.path === urlPath).length,
    releaseSlow,
    async close() {
      if (closed) return;
      closed = true;
      releaseSlow();
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
  TRACK.upstreams.push(upstream);
  return upstream;
}

async function startToolServer({ transport, port, upstreamPort, requestTimeout = 2000 }) {
  const paths = {};
  for (const name of ['echo', 'slow', 'hang']) {
    paths[`/${name}`] = { get: { operationId: name, responses: { 200: { description: 'ok' } } } };
  }
  const spec = { openapi: '3.0.3', info: { title: 'e2-01-fixture', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstreamPort}` }], paths };
  const tools = parser.transformToMCPTools(spec, {
    baseUrl: `http://127.0.0.1:${upstreamPort}`, includeDeprecated: true, requestTimeout,
  });
  const factory = async () => {
    const server = new McpServer({ name: 'e2-01-fixture', version: '1' }, { capabilities: { tools: {} } });
    try { registerManagedMcpTools(server, tools); return server; }
    catch (error) { await server.close(); throw error; }
  };
  const start = transport === 'sse' ? startSseMcpServer : startStreamableMcpServer;
  const listener = await start(factory, '/mcp', port, { host: '127.0.0.1' });
  if (!listener.listening) await once(listener, 'listening');
  TRACK.listeners.push(listener);
  return listener;
}
async function closeListener(listener) {
  if (!listener || !listener.listening) return;
  listener.closeAllConnections?.();
  await new Promise(resolve => listener.close(() => resolve()));
}

function parseMessages(text) {
  const messages = [];
  if (text.trim().startsWith('{')) {
    try { messages.push(JSON.parse(text)); } catch { /* not JSON */ }
    return messages;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (data) { try { messages.push(JSON.parse(data)); } catch { /* not JSON */ } }
  }
  return messages;
}
const eventIds = text => [...text.matchAll(/^id:\s*(.+)$/gm)].map(match => match[1].trim());

function createFramePump(response) {
  const frames = [];
  const listeners = new Set();
  const decoder = new TextDecoder();
  let buffer = '';
  const push = block => {
    const frame = { event: undefined, data: [], id: undefined };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('data:')) frame.data.push(line.slice(5).replace(/^ /, ''));
    }
    frame.text = frame.data.join('\n');
    if (frame.text) { try { frame.json = JSON.parse(frame.text); } catch { /* not JSON */ } }
    frames.push(frame);
    for (const listener of [...listeners]) listener(frame);
  };
  const reader = response.body.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) { push(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
      }
    } catch { /* stream aborted */ }
  })();
  return {
    frames,
    waitFor(predicate, timeout = 8000, label = 'SSE frame') {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`timed out waiting for ${label}`)); }, timeout);
        const listener = frame => {
          if (!predicate(frame)) return;
          clearTimeout(timer); listeners.delete(listener); resolve(frame);
        };
        listeners.add(listener);
      });
    },
    async close() { try { await reader.cancel(); } catch { /* closed */ } await pump.catch(() => undefined); },
  };
}
async function readFirstChunk(response, timeout = 1500) {
  const reader = response.body.getReader();
  const chunk = await Promise.race([
    reader.read().then(result => result.done ? null : result.value),
    delay(timeout).then(() => undefined),
  ]);
  try { await reader.cancel(); } catch { /* closed */ }
  return chunk ? Buffer.from(chunk).toString('utf8') : '';
}

const streamableHeaders = (key, session) => ({
  'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': key,
  ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL } : {}),
});
const streamableBody = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });
const initializeBody = id => ({ protocolVersion: LATEST_PROTOCOL, capabilities: {}, clientInfo: { name: 'e2-01', version: '1' } });
async function streamableToolCall(base, key, session, id, name, signal) {
  const response = await fetch(base, { method: 'POST', signal, headers: streamableHeaders(key, session),
    body: streamableBody(id, 'tools/call', { name, arguments: {} }) });
  const text = await response.text();
  return { status: response.status, text, ids: eventIds(text),
    message: parseMessages(text).find(message => message.id === id) };
}

async function n1StreamableJoint() {
  const checks = [];
  const auditDir = path.join(directory, 'n1-audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const upstream = await startUpstream();
  const port = await freePort();
  return withScenarioEnvironment(auditDir, async () => {
    let listener = await startToolServer({ transport: 'streamable', port, upstreamPort: upstream.port, requestTimeout: 5000 });
    try {
      const base = `http://127.0.0.1:${port}/mcp`;
      const initialize = await fetch(base, { method: 'POST', headers: streamableHeaders(API_KEY_A),
        body: streamableBody(1, 'initialize', initializeBody()) });
      assert.equal(initialize.status, 200);
      const session = initialize.headers.get('mcp-session-id');
      assert.ok(session, 'session id issued');
      await initialize.text();
      const notified = await fetch(base, { method: 'POST', headers: streamableHeaders(API_KEY_A, session),
        body: streamableBody(undefined, 'notifications/initialized') });
      assert.equal(notified.status, 202);
      await notified.text();
      checks.push('streamable session over loopback with per-request API-key admission');

      const echo1 = await streamableToolCall(base, API_KEY_A, session, 2, 'echo');
      assert.equal(echo1.status, 200);
      assert.notEqual(echo1.message?.result?.isError, true);
      assert.ok(echo1.ids.length >= 1, 'POST response carries resumability event ids');
      assert.equal(upstream.count('/echo'), 1);
      checks.push('successful tool call sends exactly one upstream request');

      const controller = new AbortController();
      void streamableToolCall(base, API_KEY_A, session, 3, 'slow', controller.signal).catch(() => undefined);
      await waitFor(() => upstream.count('/slow') === 1, 8000, 'in-flight /slow upstream request');
      controller.abort();
      await waitFor(async () => (await auditRows(auditDir)).some(row => row.spanKind === 'mcp_tool' && row.phase === 'finished' && row.outcome === 'cancelled'), 10000, 'cancelled tool terminal');
      const atCancel = await auditRows(auditDir);
      const cancelled = finishedTools(atCancel).filter(row => row.outcome === 'cancelled');
      assert.equal(cancelled.length, 1, 'cancel exactly once');
      assert.equal(cancelled[0].errorCode, 'MCP_SESSION_CLOSED');
      assert.ok(atCancel.some(row => row.spanKind === 'mcp_protocol' && row.phase === 'finished'
        && row.invocationId === cancelled[0].parentInvocationId && row.outcome === 'cancelled'), 'protocol parent cancelled with the tool');
      const sendsAtCancel = upstream.count('/slow');
      upstream.releaseSlow();
      await delay(400);
      assert.equal(upstream.count('/slow'), sendsAtCancel, 'no upstream resend/retry after cancellation');
      const afterCancel = await auditRows(auditDir);
      assert.equal(finishedTools(afterCancel).filter(row => row.invocationId === cancelled[0].invocationId).length, 1, 'late completion cannot add a second terminal');
      assert.equal(finishedTools(afterCancel).filter(row => row.invocationId === cancelled[0].invocationId && row.outcome === 'success').length, 0, 'late completion cannot become success');
      await waitFor(() => parser.getRuntimeAuditHealth().activeCalls === 0, 3000, 'released cancelled call');
      checks.push('cancel-once, no retry, no late success, activeCalls released');

      const cross = await streamableToolCall(base, API_KEY_B, session, 4, 'echo');
      assert.equal(cross.status, 403);
      assert.equal(upstream.count('/echo'), 1);
      checks.push('cross-subject session replay rejected before dispatch (zero upstream)');

      const echo2 = await streamableToolCall(base, API_KEY_A, session, 5, 'echo');
      assert.equal(echo2.status, 200);
      assert.equal(upstream.count('/echo'), 2);
      const baselineTools = finishedTools(await auditRows(auditDir)).length;
      const cursor = echo1.ids[0];
      const replay = await fetch(base, { method: 'GET', headers: { accept: 'text/event-stream', 'x-api-key': API_KEY_A,
        'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL, 'last-event-id': cursor } });
      assert.equal(replay.status, 200);
      const replayText = await readFirstChunk(replay, 1500);
      assert.ok(replayText.includes('"id":2'), `cursor replay must resend the stored response, got: ${replayText.slice(0, 200)}`);
      assert.equal(upstream.count('/echo'), 2, 'cursor replay never re-executes a tool');
      assert.equal(finishedTools(await auditRows(auditDir)).length, baselineTools, 'cursor replay adds no tool execution');
      checks.push('cursor replay resends a stored response without re-execution');

      const crossReplay = await fetch(base, { method: 'GET', headers: { accept: 'text/event-stream', 'x-api-key': API_KEY_B,
        'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL, 'last-event-id': cursor } });
      assert.equal(crossReplay.status, 403);
      await crossReplay.text();
      assert.equal(upstream.count('/echo'), 2);
      checks.push('cross-subject cursor replay rejected with zero upstream');

      const deleted = await fetch(base, { method: 'DELETE', headers: streamableHeaders(API_KEY_A, session) });
      assert.equal(deleted.status, 200);
      await deleted.text();
      const afterDelete = await streamableToolCall(base, API_KEY_A, session, 6, 'echo');
      assert.equal(afterDelete.status, 404);
      assert.equal(upstream.count('/echo'), 2);
      checks.push('replay against a deleted session rejected with zero upstream');

      await closeListener(listener);
      listener = undefined;
      await waitFor(() => unreachable(base), 8000, 'streamable port release');
      listener = await startToolServer({ transport: 'streamable', port, upstreamPort: upstream.port, requestTimeout: 5000 });
      const health = await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          const status = response.status;
          await response.text();
          return status === 200 ? status : undefined;
        } catch { return undefined; }
      }, 8000, 'restarted streamable health');
      assert.equal(health, 200);
      const reinit = await fetch(base, { method: 'POST', headers: streamableHeaders(API_KEY_A),
        body: streamableBody(7, 'initialize', initializeBody()) });
      assert.equal(reinit.status, 200);
      await reinit.text();
      checks.push('shutdown releases the port; a fresh server on the same port serves a new session');
    } finally {
      await closeListener(listener).catch(() => undefined);
    }
    return checks;
  }).finally(() => upstream.close());
}

async function n2SseJoint() {
  const checks = [];
  const auditDir = path.join(directory, 'n2-audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const upstream = await startUpstream();
  const port = await freePort();
  return withScenarioEnvironment(auditDir, async () => {
    let listener = await startToolServer({ transport: 'sse', port, upstreamPort: upstream.port, requestTimeout: 5000 });
    try {
      const base = `http://127.0.0.1:${port}/mcp`;
      const streamController = new AbortController();
      const stream = await fetch(base, { headers: { accept: 'text/event-stream', 'x-api-key': API_KEY_A }, signal: streamController.signal });
      assert.equal(stream.status, 200);
      const pump = createFramePump(stream);
      const endpointFrame = await pump.waitFor(frame => frame.event === 'endpoint', 8000, 'SSE endpoint event');
      const route = new URL(endpointFrame.text, base);
      const post = (key, body) => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body) });
      const initialized = await post(API_KEY_A, { jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeBody() });
      assert.equal(initialized.status, 202);
      await initialized.text();
      await pump.waitFor(frame => frame.json?.id === 1, 8000, 'initialize result on SSE stream');
      checks.push('SSE session over loopback with per-request API-key admission');

      const cross = await post(API_KEY_B, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
      assert.equal(cross.status, 403);
      await cross.text();
      assert.equal(upstream.count('/echo'), 0);
      checks.push('cross-subject SSE session rejected before dispatch (zero upstream)');

      const echo = await post(API_KEY_A, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } });
      assert.equal(echo.status, 202);
      await echo.text();
      await pump.waitFor(frame => frame.json?.id === 3 && frame.json?.result, 8000, 'echo result');
      assert.equal(upstream.count('/echo'), 1);

      const slow = await post(API_KEY_A, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'slow', arguments: {} } });
      assert.equal(slow.status, 202);
      await slow.text();
      await waitFor(() => upstream.count('/slow') === 1, 8000, 'in-flight /slow upstream request');
      streamController.abort();
      await pump.close();
      await waitFor(async () => (await auditRows(auditDir)).some(row => row.spanKind === 'mcp_tool' && row.phase === 'finished' && row.outcome === 'cancelled'), 10000, 'cancelled SSE tool terminal');
      const cancelled = finishedTools(await auditRows(auditDir)).filter(row => row.outcome === 'cancelled');
      assert.equal(cancelled.length, 1, 'cancel exactly once');
      assert.equal(cancelled[0].errorCode, 'MCP_SESSION_CLOSED');
      const sendsAtCancel = upstream.count('/slow');
      upstream.releaseSlow();
      await delay(300);
      assert.equal(upstream.count('/slow'), sendsAtCancel, 'no upstream resend/retry after SSE disconnect');
      assert.equal(pump.frames.some(frame => frame.json?.id === 4), false, 'cancelled SSE call produced no success frame');
      await waitFor(() => parser.getRuntimeAuditHealth().activeCalls === 0, 3000, 'released cancelled call');
      checks.push('SSE stream disconnect cancels once, no retry, no response frame');

      await delay(500);
      const replay = await post(API_KEY_A, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} } });
      assert.equal(replay.status, 404);
      await replay.text();
      assert.equal(upstream.count('/echo'), 1);
      checks.push('replay against a retired SSE session rejected with zero upstream');

      await closeListener(listener);
      listener = undefined;
      await waitFor(() => unreachable(base), 8000, 'SSE port release');
      listener = await startToolServer({ transport: 'sse', port, upstreamPort: upstream.port, requestTimeout: 5000 });
      const fresh = await waitFor(async () => {
        try {
          const response = await fetch(base, { headers: { accept: 'text/event-stream', 'x-api-key': API_KEY_A } });
          if (response.status !== 200) { await response.text(); return undefined; }
          return response;
        } catch { return undefined; }
      }, 8000, 'restarted SSE stream');
      assert.equal(fresh.status, 200);
      await fresh.body.cancel();
      checks.push('shutdown releases the port; a fresh SSE server on the same port accepts a session');
    } finally {
      await closeListener(listener).catch(() => undefined);
    }
    return checks;
  }).finally(() => upstream.close());
}

async function n3RequestTimeout() {
  const checks = [];
  for (const transport of ['streamable', 'sse']) {
    const auditDir = path.join(directory, `n3-${transport}-audit`);
    fs.mkdirSync(auditDir, { recursive: true });
    const upstream = await startUpstream();
    const port = await freePort();
    try {
      await withScenarioEnvironment(auditDir, async () => {
        const listener = await startToolServer({ transport, port, upstreamPort: upstream.port, requestTimeout: 600 });
        try {
          const base = `http://127.0.0.1:${port}/mcp`;
          let callTool, pump;
          if (transport === 'streamable') {
            const initialize = await fetch(base, { method: 'POST', headers: streamableHeaders(API_KEY_A),
              body: streamableBody(1, 'initialize', initializeBody()) });
            assert.equal(initialize.status, 200);
            const session = initialize.headers.get('mcp-session-id');
            await initialize.text();
            let nextId = 2;
            callTool = async name => {
              const call = await streamableToolCall(base, API_KEY_A, session, nextId++, name);
              assert.equal(call.status, 200);
              return { isError: call.message?.result?.isError === true, text: JSON.stringify(call.message) };
            };
          } else {
            const stream = await fetch(base, { headers: { accept: 'text/event-stream', 'x-api-key': API_KEY_A } });
            pump = createFramePump(stream);
            const endpointFrame = await pump.waitFor(frame => frame.event === 'endpoint', 8000, 'SSE endpoint event');
            const route = new URL(endpointFrame.text, base);
            const post = body => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY_A },
              body: JSON.stringify(body) });
            const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeBody() });
            assert.equal(initialized.status, 202);
            await initialized.text();
            await pump.waitFor(frame => frame.json?.id === 1, 8000, 'initialize result');
            let nextId = 2;
            callTool = async name => {
              const id = nextId++;
              const response = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
              assert.equal(response.status, 202);
              await response.text();
              const frame = await pump.waitFor(candidate => candidate.json?.id === id, 8000, `tool ${name} result`);
              return { isError: frame.json?.result?.isError === true, text: JSON.stringify(frame.json) };
            };
          }

          const timedOut = await callTool('hang');
          assert.equal(timedOut.isError, true, 'request timeout is a fixed tool failure');
          assert.match(timedOut.text, /timeout/i);
          await waitFor(async () => (await auditRows(auditDir)).some(row => row.spanKind === 'upstream_api' && row.phase === 'finished' && row.outcome === 'timeout'), 5000, 'upstream timeout terminal');
          const terminals = (await auditRows(auditDir)).filter(row => row.spanKind === 'upstream_api' && row.phase === 'finished');
          assert.equal(terminals.length, 1, 'one upstream attempt');
          assert.equal(terminals[0].errorCode, 'UPSTREAM_TIMEOUT');
          assert.equal(upstream.count('/hang'), 1);
          await delay(500);
          assert.equal(upstream.count('/hang'), 1, 'no retry or fallback after request timeout');
          const recovered = await callTool('echo');
          assert.notEqual(recovered.isError, true);
          assert.equal(upstream.count('/echo'), 1);
          await pump?.close();
          await closeListener(listener);
          await waitFor(() => parser.getRuntimeAuditHealth().activeCalls === 0, 5000, 'released timeout calls');
        } finally {
          await closeListener(listener);
        }
      });
    } finally {
      await upstream.close();
    }
    checks.push(`${transport}: fixed request-timeout failure, single upstream attempt, no fallback, server stays usable`);
  }
  return checks;
}

async function n4HandshakeTimeout() {
  const checks = [];
  const child = spawn(process.execPath, [MANAGED_ENTRY], { env: systemEnvironment(), shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  TRACK.children.push(child);
  const messages = [];
  let stdout = '', stderr = '';
  child.on('message', message => messages.push(message));
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const started = Date.now();
  let guardTimer;
  const guard = new Promise((resolve, reject) => {
    guardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('real child did not enforce the handshake deadline')); }, 45000);
  });
  const [code, signal] = await Promise.race([once(child, 'close'), guard]);
  clearTimeout(guardTimer);
  const elapsed = Date.now() - started;
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.ok(elapsed >= 29000 && elapsed < 45000, `handshake timer fired at ${elapsed}ms`);
  assert.deepEqual(messages.filter(message => message.type === 'failed').map(message => message.code), ['MANAGED_HANDSHAKE_TIMEOUT']);
  assert.equal(messages.some(message => message.type === 'handoffAccepted' || message.type === 'runtimeReady'), false);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(pidGone(child.pid), true);
  checks.push(`real built child enforced the 30s handshake deadline at ${elapsed}ms with a fixed code, exit 1, no accept/listener/diagnostics`);
  return checks;
}

async function startManagedChild({ launchId, port, registryPath, digest, upstreamPort }) {
  const spec = { openapi: '3.0.3', info: { title: 'e2-01-managed', version: '1' },
    servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
    paths: { '/items': { get: { operationId: 'items', responses: { 200: { description: 'ok' } } } } } };
  const payload = { version: 1, launchId, managedServerId: 'e2-01-managed-server', runtimeAssetId: 'e2-01-managed-asset',
    inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: hash(JSON.stringify(canonical(spec))),
    transport: { type: 'streamable', host: '127.0.0.1', port, endpoint: '/mcp' }, openApiData: spec,
    trustedOperationBindings: [{ method: 'GET', path: '/items', endpointDefinitionId: 'endpoint-items', sourceServiceAssetId: 'asset-one' }],
    registrySource: { configId: 'e2-01-registry', path: registryPath, format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: digest } };
  const env = { ...systemEnvironment(), API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: 'https://e2-01.invalid/mcp', API_NOVA_RUNTIME_API_KEYS: apiKeysJson(),
    UPSTREAM_PARENT: 'synthetic-e2-01-secret' };
  const child = spawn(process.execPath, [MANAGED_ENTRY], { env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  TRACK.children.push(child);
  const messages = [];
  let stdout = '', stderr = '';
  child.on('message', message => messages.push(message));
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  child.send({ type: 'handoff', version: 1, launchId, payload });
  await waitFor(() => messages.some(message => message.type === 'runtimeReady' || message.type === 'failed') || child.exitCode !== null,
    20000, 'managed child READY or failure');
  const ready = messages.find(message => message.type === 'runtimeReady');
  if (!ready) throw new Error(`managed child failed: ${JSON.stringify(messages)}`);
  return {
    child, messages, stdoutText: () => stdout, stderrText: () => stderr,
    async stop() {
      child.send({ type: 'stop', launchId });
      return closed;
    },
  };
}

async function n5ManagedRestart() {
  const checks = [];
  const upstream = await startUpstream();
  const port = await freePort();
  const registryPath = path.join(directory, 'n5-registry.json');
  const registry = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'r1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { parent: { type: 'bearer', secretRef: 'env:UPSTREAM_PARENT' } },
    sites: [{ id: 'site-one', sourceServiceAssetId: 'asset-one',
      match: { scheme: 'http', host: '127.0.0.1', port: upstream.port, basePath: '/' }, allowedHosts: ['127.0.0.1'],
      credential: 'parent', endpoints: [{ endpointDefinitionId: 'endpoint-items', credential: 'none' }] }] };
  const text = JSON.stringify(registry);
  fs.writeFileSync(registryPath, text);
  const digest = hash(text);
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    for (const launchId of ['e2-01-launch-one', 'e2-01-launch-two']) {
      const handle = await startManagedChild({ launchId, port, registryPath, digest, upstreamPort: upstream.port });
      try {
        const status = await waitFor(async () => {
          try {
            const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
            const value = response.status;
            await response.text();
            return value;
          } catch { return undefined; }
        }, 8000, 'managed listener');
        assert.equal(status, 401);
        const result = await handle.stop();
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.equal(handle.stdoutText(), '');
        assert.equal(handle.stderrText(), '');
        assert.equal(pidGone(handle.child.pid), true);
        await waitFor(() => unreachable(url), 8000, 'managed port release');
      } finally {
        if (!pidGone(handle.child.pid)) { try { handle.child.kill('SIGKILL'); } catch { /* gone */ } }
      }
      checks.push(`launch ${launchId}: READY -> 401 -> stop exit 0 -> port released`);
    }
    checks.push('same port is reusable by a new built child with a fresh launch (restartable consistent state)');
  } finally {
    await upstream.close();
  }
  return checks;
}

const SUITES = [
  { id: 'e0-01-adapter-contract', label: 'E0-01 raw HTTP adapter contract',
    script: path.join(serverRoot, 'scripts', 'test-mcp-adapter-contract.cjs'), cwd: serverRoot,
    evidence: [['replay', 'streamable'], ['replay', 'sse'], ['shutdown', 'streamable'], ['shutdown', 'sse']],
    note: 'Method/Header/error/session contract; DELETE closes session; SSE disconnect retires session' },
  { id: 'b3-02-sdk-session-contract', label: 'B3-02 SDK session dispatcher/notification',
    script: path.join(serverRoot, 'scripts', 'test-mcp-sdk-session-contract.cjs'), cwd: serverRoot,
    evidence: [['replay', 'streamable'], ['replay', 'sse']],
    note: 'real SDK sessions; cross-subject POST/GET/DELETE rejected before dispatch' },
  { id: 'transport-observability', label: 'transport audit instrumentation',
    script: path.join(serverRoot, 'scripts', 'test-mcp-transport-observability.cjs'), cwd: serverRoot,
    evidence: [['cancellation', 'stdio']],
    note: 'instrumented transport primitive: close during send cancels exactly once and releases pending calls' },
  { id: 'http-observability', label: 'HTTP ingress observability',
    script: path.join(serverRoot, 'scripts', 'test-mcp-http-observability.cjs'), cwd: serverRoot,
    evidence: [['cancellation', 'streamable'], ['timeout', 'streamable']],
    note: 'client response disconnect cancels ingress once; stream closes at the effective authorization deadline (jwt/api_key)' },
  { id: 'http-delivery', label: 'HTTP/SSE delivery and disconnect',
    script: path.join(serverRoot, 'scripts', 'test-mcp-http-delivery.cjs'), cwd: serverRoot,
    evidence: [['cancellation', 'streamable'], ['cancellation', 'sse']],
    note: 'disconnect before result cancels once; late completion cannot succeed' },
  { id: 'stdio-observability', label: 'real STDIO child observability',
    script: path.join(serverRoot, 'scripts', 'test-mcp-stdio-observability.cjs'), cwd: serverRoot,
    evidence: [['cancellation', 'stdio'], ['shutdown', 'stdio']],
    note: 'shutdown/stdin EOF cancels pending calls; reader disconnect/crash/kill never fabricate success' },
  { id: 'b3-01-session-revocation', label: 'B3-01 persisted revocation and reconnect',
    script: path.join(apiRoot, 'scripts', 'test-runtime-credential-session-revocation.cjs'), cwd: apiRoot,
    evidence: [['replay', 'streamable'], ['replay', 'sse']],
    note: 'real CLI PIDs and streams; revocation, replay cursor reconnect rejected 401, DB reopen' },
  { id: 'managed-channel', label: 'managed IPC channel',
    script: path.join(apiRoot, 'scripts', 'test-managed-mcp-channel.cjs'), cwd: apiRoot,
    evidence: [['timeout', 'managed-ipc'], ['shutdown', 'managed-ipc'], ['replay', 'managed-ipc']],
    note: '30s parent handshake timer with listener/timer cleanup; duplicate handoff/ACK fail closed; parent disconnect bounded exit' },
  { id: 'managed-runtime', label: 'managed runtime streamable/SSE',
    script: path.join(serverRoot, 'scripts', 'test-managed-runtime.cjs'), cwd: serverRoot,
    evidence: [['timeout', 'streamable'], ['timeout', 'sse'], ['shutdown', 'streamable'], ['shutdown', 'sse']],
    note: 'pre-listen failures with zero upstream; occupied port fails without READY/fallback; stop releases port' },
  { id: 'e1-02c1-lifecycle', label: 'E1-02C1 lifecycle wiring',
    script: path.join(apiRoot, 'scripts', 'verify-e1-02c1.cjs'), cwd: apiRoot, marker: 'E1_02C1_VERIFY_OK',
    evidence: [['shutdown', 'managed-ipc']],
    note: 'READY->RUNNING, idempotent stop, monotonic generation, no fallback' },
  { id: 'e1-02c2-restart', label: 'E1-02C2 restart/failure/legacy',
    script: path.join(apiRoot, 'scripts', 'verify-e1-02c2.cjs'), cwd: apiRoot, marker: 'E1_02C2_VERIFY_OK',
    evidence: [['shutdown', 'managed-ipc'], ['replay', 'managed-ipc']],
    note: 'crash marks failed; restart re-prepares a generation; stale captured package rejected not replayed; parent disconnect stops child' },
  { id: 'publication-endpoints', label: 'publication endpoint lifecycle',
    script: path.join(serverRoot, 'scripts', 'test-publication-endpoints.cjs'), cwd: serverRoot,
    evidence: [['shutdown', 'streamable'], ['shutdown', 'sse'], ['timeout', 'streamable'], ['timeout', 'sse']],
    note: 'custom endpoint/health; occupied requested port fails without READY or fallback port; child cleanup' },
];

const suiteResults = [];
const scenarioResults = [];
const failures = [];

function runSuite(suite) {
  const started = Date.now();
  const environment = { ...process.env, TEMP: tempRoot, TMP: tempRoot, DB_TYPE: 'sqlite', FORCE_COLOR: '0' };
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite.script],
    { cwd: suite.cwd, env: environment, encoding: 'utf8', timeout: 900000, maxBuffer: 128 * 1024 * 1024 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counter = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = counter('tests'), passed = counter('pass'), failed = counter('fail');
  const markerSeen = suite.marker ? output.includes(suite.marker) : null;
  const status = result.status === 0 && failed === 0 && (suite.marker ? markerSeen : true) ? 'passed' : 'failed';
  const record = { id: suite.id, label: suite.label, script: path.relative(repoRoot, suite.script).replace(/\\/g, '/'),
    tests, passed, failed, marker: suite.marker || null, markerSeen, status, ms: Date.now() - started,
    note: suite.note, evidence: suite.evidence, error: result.error ? String(result.error.message) : null };
  suiteResults.push(record);
  if (status === 'failed') failures.push(`suite ${suite.id}: tests=${tests} pass=${passed} fail=${failed} exit=${result.status} marker=${markerSeen}\n${output.slice(-4000)}`);
  return record;
}

async function runScenario(id, title, evidence, fn) {
  const started = Date.now();
  try {
    const checks = await fn();
    scenarioResults.push({ id, title, evidence, status: 'passed', checks, ms: Date.now() - started });
  } catch (error) {
    scenarioResults.push({ id, title, evidence, status: 'failed', checks: [], ms: Date.now() - started,
      error: String((error && error.stack) || error) });
    failures.push(`scenario ${id}: ${(error && error.message) || error}`);
  }
}

function buildCoverage() {
  const matrix = {};
  for (const family of FAMILIES) {
    matrix[family] = {};
    for (const transport of TRANSPORTS) matrix[family][transport] = { status: 'notCovered', existing: [], added: [] };
  }
  for (const suite of suiteResults) {
    if (suite.status !== 'passed') continue;
    for (const [family, transport] of suite.evidence) {
      matrix[family][transport].existing.push(suite.id);
      matrix[family][transport].status = 'covered';
    }
  }
  for (const scenario of scenarioResults) {
    if (scenario.status !== 'passed') continue;
    for (const [family, transport] of scenario.evidence) {
      matrix[family][transport].added.push(scenario.id);
      matrix[family][transport].status = 'covered';
    }
  }
  return matrix;
}

function coverageSummary(coverage) {
  return FAMILIES.map(family => `${family}[` + TRANSPORTS.map(transport => {
    const cell = coverage[family][transport];
    return `${transport}:${cell.existing.length}+${cell.added.length}`;
  }).join(' ') + ']').join(' ');
}

const notCovered = [
  { family: 'timeout', transport: 'streamable/sse', item: 'dedicated per-connection idle timeout',
    reason: 'the current Streamable/SSE transports define no idle timer; the effective authorization deadline close is covered by test-mcp-http-observability.cjs and session end is covered under shutdown' },
  { family: 'cancellation', transport: 'streamable/sse/stdio', item: 'abort of an already-admitted in-flight upstream request',
    reason: 'transport cancellation terminates the call once, blocks late success and prevents retry, but an Axios upstream request already on the wire is not aborted; in-flight revocation/cancel policy is owned by SEC-E1-04/F3' },
  { family: 'replay', transport: 'sse', item: 'event-store cursor replay',
    reason: 'the SSE transport has no resumability/event store; replay is rejected by session retirement (covered); cursor replay applies to Streamable HTTP only' },
  { family: 'timeout', transport: 'managed-ipc', item: 'parent-side 30s handshake timer against a real silent child',
    reason: 'the parent timer and listener cleanup are covered by the channel sandbox; the real built-child timer is executed here, but a real child that never ACKs requires a test double' },
  { family: 'timeout', transport: 'stdio', item: 'stdio handshake/request timeout',
    reason: 'the stdio server has no handshake or per-request timer of its own; upstream request timeouts are transport-independent (N3) and stall/EOF/crash cases are covered under cancellation and shutdown' },
  { family: 'replay', transport: 'stdio', item: 'session/cursor replay',
    reason: 'a stdio server is one process pipe per client with no session or event-store surface; there is nothing to replay and no cross-context session to target' },
  { family: 'cancellation', transport: 'managed-ipc', item: 'managed child inbound request cancellation',
    reason: 'the managed child serves the same Streamable HTTP transport covered above; E1-03 aggregates the real child path and E1-02C2 covers stop/restart' },
];

async function cleanup() {
  for (const listener of TRACK.listeners) await closeListener(listener).catch(() => undefined);
  for (const upstream of TRACK.upstreams) await upstream.close().catch(() => undefined);
  for (const child of TRACK.children) {
    if (child.pid && !pidGone(child.pid)) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  await parser.flushRuntimeAudit().catch(() => undefined);
  await delay(200);
  const target = path.resolve(directory);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('apinova-e2-01-')) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.E2_01_NEW_ONLY !== '1') {
    for (const suite of SUITES) runSuite(suite);
  }
  if (process.env.E2_01_SUITES_ONLY !== '1') {
    await runScenario('N1', 'streamable joint: cancel-once/no-retry/no-late-success, cursor replay without re-execution, cross-context and deleted-session replay rejected, restart on the same port',
      [['cancellation', 'streamable'], ['replay', 'streamable'], ['shutdown', 'streamable']], n1StreamableJoint);
    await runScenario('N2', 'SSE joint: disconnect cancels once, retired-session replay rejected, restart on the same port',
      [['cancellation', 'sse'], ['replay', 'sse'], ['shutdown', 'sse']], n2SseJoint);
    await runScenario('N3', 'request timeout: fixed tool failure, single upstream attempt, no retry/fallback, server stays usable',
      [['timeout', 'streamable'], ['timeout', 'sse']], n3RequestTimeout);
    await runScenario('N4', 'real managed child enforces the 30s handshake deadline with a fixed code and clean exit',
      [['timeout', 'managed-ipc']], n4HandshakeTimeout);
    await runScenario('N5', 'managed child stop releases the port; a fresh child restarts on the same port with consistent state',
      [['shutdown', 'managed-ipc']], n5ManagedRestart);
  }

  const coverage = buildCoverage();
  const counts = {
    aggregatedSuites: suiteResults.length,
    aggregatedTests: suiteResults.reduce((sum, suite) => sum + (suite.tests || 0), 0),
    aggregatedPassed: suiteResults.reduce((sum, suite) => sum + (suite.passed || 0), 0),
    aggregatedFailed: suiteResults.reduce((sum, suite) => sum + (suite.failed || 0), 0),
    newScenarios: scenarioResults.length,
    newChecks: scenarioResults.reduce((sum, scenario) => sum + scenario.checks.length, 0),
  };
  const report = {
    marker: failures.length ? 'E2_01_VERIFY_FAILED' : 'E2_01_VERIFY_OK',
    platform: process.platform, node: process.version, tempRoot,
    sdk: '1.29.0-locked', counts, coverage, suites: suiteResults, scenarios: scenarioResults, notCovered, failures,
  };
  console.log(JSON.stringify(report, null, 1));
  console.log('\ncoverage ' + coverageSummary(coverage));
  for (const scenario of scenarioResults) {
    console.log(`scenario ${scenario.id} ${scenario.status}: ${scenario.title}`);
    for (const check of scenario.checks) console.log(`  - ${check}`);
  }
  if (failures.length) {
    console.log(`\nE2_01_VERIFY_FAILED ${failures.length} failing groups`);
    process.exitCode = 1;
  } else {
    console.log(`\nE2_01_VERIFY_OK current-artifact security joint matrix: aggregated ${counts.aggregatedPassed}/${counts.aggregatedTests} tests in ${counts.aggregatedSuites} suites, new ${counts.newScenarios} scenarios/${counts.newChecks} checks, ${process.platform} Node ${process.version}`);
  }
}

main().then(cleanup).catch(error => {
  console.error(error && error.stack || error);
  return cleanup().then(() => { process.exitCode = 1; });
});
