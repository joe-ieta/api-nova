'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  project: require('node:path').resolve(__dirname, '../tsconfig.json'),
});
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { generateKeyPair, exportJWK, SignJWT } =
  createRequire(require.resolve('api-nova-parser'))('jose');
const { mcpInboundSpawnEnv, persistedMcpInboundMode } =
  require('../src/modules/servers/services/mcp-inbound-process-env.ts');

const cli = path.resolve(__dirname, '../../api-nova-server/dist/cli.js');
const resource = 'https://b2-runtime.example/mcp';
const issuer = 'https://b2-issuer.example';
const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'b2-http-check', version: '1' } },
});

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitReady(child, port, output) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('CLI exited before readiness: ' + output());
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch { /* The isolated child may still be binding its port. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('CLI health timeout: ' + output());
}

async function request(port, headers = {}) {
  const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', ...headers },
    body: initialize,
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  return { status: response.status, body };
}

async function launch(t, mode, inherited, runtimeAssetId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-b2-http-'));
  const spec = path.join(root, 'openapi.json');
  await fs.writeFile(spec, JSON.stringify({
    openapi: '3.0.3', info: { title: 'B2 Auth Fixture', version: '1' },
    servers: [{ url: 'http://127.0.0.1' }], paths: {},
  }));
  const port = await freePort();
  const selected = persistedMcpInboundMode({ inboundAuthMode: mode, config: { runtimeAssetId } }, inherited);
  const env = mcpInboundSpawnEnv(selected, {
    ...inherited,
    API_NOVA_AUDIT_DIR: root,
    API_NOVA_RUNTIME_REQUIRED_SCOPES: '',
    API_NOVA_MCP_TOOL_SCOPES: '{}',
  }, runtimeAssetId);
  const child = spawn(process.execPath, [cli, '--transport', 'streamable',
    '--host', '127.0.0.1', '--port', String(port), '--endpoint', '/mcp',
    '--openapi', spec], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let captured = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { captured = (captured + chunk.toString()).slice(-6000); });
  }
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('api-nova-b2-http-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, { recursive: true, force: true });
  });
  await waitReady(child, port, () => captured);
  return port;
}

test('private_api_key child enforces missing/wrong keys and accepts its own key', { timeout: 25000 }, async t => {
  const key = 'synthetic-b2-api-key';
  const inherited = {
    ...process.env,
    API_NOVA_RUNTIME_AUTH_MODE: 'anonymous',
    API_NOVA_MCP_RESOURCE: resource,
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{
      id: 'b2-key', subject: 'consumer',
      secretHash: createHash('sha256').update(key).digest('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 120,
      resources: [resource], scopes: [],
    }]),
  };
  const port = await launch(t, 'private_api_key', inherited);
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { 'x-api-key': 'wrong' })).status, 401);
  const accepted = await request(port, { 'x-api-key': key });
  assert.equal(accepted.status, 200, accepted.body);
});

test('private_jwt child enforces missing/wrong tokens and accepts signed token', { timeout: 25000 }, async t => {
  const keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'b2-key', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({ sub: 'consumer', iss: issuer, aud: resource })
    .setProtectedHeader({ alg: 'RS256', kid: 'b2-key' })
    .setIssuedAt().setExpirationTime('2m').sign(keys.privateKey);
  const inherited = {
    ...process.env,
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
    API_NOVA_MCP_RESOURCE: resource,
    API_NOVA_RUNTIME_ISSUER: issuer,
    API_NOVA_RUNTIME_JWKS_JSON: JSON.stringify({ keys: [publicKey] }),
  };
  delete inherited.API_NOVA_RUNTIME_JWKS_URI;
  const port = await launch(t, 'private_jwt', inherited);
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { authorization: 'Bearer wrong' })).status, 401);
  const accepted = await request(port, { authorization: 'Bearer ' + token });
  assert.equal(accepted.status, 200, accepted.body);
});

test('anonymous child admits requests despite protected global mode', { timeout: 25000 }, async t => {
  const inherited = {
    ...process.env,
    API_NOVA_RUNTIME_AUTH_MODE: 'jwt',
    API_NOVA_MCP_RESOURCE: resource,
    API_NOVA_RUNTIME_ISSUER: issuer,
    API_NOVA_RUNTIME_JWKS_JSON: '{"keys":[]}',
  };
  const port = await launch(t, 'anonymous', inherited);
  const accepted = await request(port);
  assert.equal(accepted.status, 200, accepted.body);
});

test('unified key envelope reaches a real CLI child without legacy fallback', { timeout: 25000 }, async t => {
  const runtimeAssetId = 'unified-runtime';
  const credentials = [{ version: 1, id: 'shared-key', keyId: 'shared',
    secretHash: createHash('sha256').update('synthetic-secret').digest('hex'), status: 'active',
    subject: 'worker', protocols: ['mcp'], runtimeAssetId, toolScopes: [], scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 120 }];
  const inherited = { ...process.env, API_NOVA_RUNTIME_API_KEYS: 'invalid-legacy-not-used',
    API_NOVA_RUNTIME_ACCESS_CREDENTIALS: JSON.stringify({ version: 1, runtimeAssetId, credentials }) };
  assert.throws(() => persistedMcpInboundMode({ inboundAuthMode: 'private_api_key', config: { runtimeAssetId: 'other' } }, inherited));
  const port = await launch(t, 'private_api_key', inherited, runtimeAssetId);
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { 'x-api-key': 'shared.wrong' })).status, 401);
  assert.equal((await request(port, { 'x-api-key': 'shared.synthetic-secret' })).status, 200);
});
