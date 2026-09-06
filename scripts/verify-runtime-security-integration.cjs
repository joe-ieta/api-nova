/* Isolated process/HTTPS integration. Never targets the operator's database or services. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { fork, spawnSync } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const root = path.resolve(__dirname, '..');
const apiDist = path.join(root, 'packages/api-nova-api/dist/src');
const serverDist = path.join(root, 'packages/api-nova-server/dist');
const parser = require('api-nova-parser');
const { generateKeyPair, exportJWK, SignJWT } = createRequire(require.resolve('api-nova-parser'))('jose');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepareDatabase(fixture) {
  const { AppDataSource: db } = require(path.join(apiDist, 'database/data-source.js'));
  db.setOptions({ migrations: [path.join(apiDist, 'database/migrations/*Canonical*.js')] });
  await db.initialize();
  try {
    await db.runMigrations({ transaction: 'all' });
    const { RuntimeAssetEntity } = require(path.join(apiDist, 'database/entities/runtime-asset.entity.js'));
    const { GatewayRouteSnapshotEntity } = require(path.join(apiDist, 'database/entities/gateway-route-snapshot.entity.js'));
    const { GatewayPolicyService } = require(path.join(apiDist, 'modules/gateway-runtime/services/gateway-policy.service.js'));
    const { GatewayRouteSnapshotService } = require(path.join(apiDist, 'modules/gateway-runtime/services/gateway-route-snapshot.service.js'));
    const runtime = await db.getRepository(RuntimeAssetEntity).save({ id: fixture.runtimeId,
      name: 'isolated-security-fixture', type: 'gateway_service', status: 'active', servicePrefix: 'secure',
      metadata: { activeRevision: 'integration-fixture' } });
    const routeBinding = { id: fixture.routeId, routePath: '/echo', routeMethod: 'POST',
      upstreamPath: '/echo', upstreamMethod: 'POST', pathMatchMode: 'exact', authPolicyRef: 'oauth',
      timeoutMs: 3000, createdAt: new Date(), updatedAt: new Date() };
    const entry = { runtimeAsset: runtime, membership: { id: fixture.membershipId, publicationRevision: 1 },
      publishBinding: { id: fixture.bindingId }, routeBinding, endpointDefinition: { id: fixture.endpointId, path: '/echo' },
      sourceServiceInstance: { id: fixture.instanceId, credentialRef: 'env-headers:Authorization=INTEGRATION_UPSTREAM_CREDENTIAL' },
      sourceServiceAsset: { id: fixture.sourceId }, upstreamBaseUrl: fixture.upstream,
      normalizedRoutePath: '/secure/echo', routeMethod: 'POST',
      policies: new GatewayPolicyService().compileForRoute(routeBinding) };
    const snapshotService = Object.create(GatewayRouteSnapshotService.prototype);
    await db.getRepository(GatewayRouteSnapshotEntity).save({ runtimeAssetId: runtime.id,
      revision: 'integration-fixture', fingerprint: snapshotService.fingerprintEntries([entry]),
      routeCount: 1, payload: [entry], activatedAt: new Date() });
  } finally { await db.destroy(); }
}

async function childMode(mode) {
  const fixture = JSON.parse(await fs.readFile(process.env.INTEGRATION_FIXTURE, 'utf8'));
  if (mode === '--prepare') { await prepareDatabase(fixture); return; }
  if (mode === '--api') {
    require(path.join(apiDist, 'main.js'));
    process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
    process.on('disconnect', () => process.emit('SIGTERM'));
    return;
  }
  const { createMcpServer, startStreamableMcpServer } = require(path.join(serverDist, 'index.js'));
  const server = await startStreamableMcpServer(() => createMcpServer({ openApiData: fixture.spec },
    { registerSignalHandlers: false }), '/mcp', Number(process.env.MCP_PORT),
    { allowedOrigins: [new URL(process.env.API_NOVA_MCP_RESOURCE).origin] });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await parser.flushRuntimeAudit();
    process.exit(0);
  };
  process.on('message', message => { if (message === 'stop') void stop(); });
  process.on('disconnect', () => void stop());
}

async function port() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}

function tlsFetch(ca) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method || 'GET', ca,
      headers: Object.fromEntries(new Headers(init.headers || {})), signal: init.signal }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = [204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res);
      resolve(new Response(body, { status: res.statusCode, headers }));
    });
    req.on('error', reject);
    req.end(init.body || undefined);
  });
}

async function main() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'api-nova-security-integration-'));
  const children = [], services = [], childLogs = [];
  let mcpClient;
  const checks = [];
  const check = name => { checks.push(name); console.log(`[security-integration] PASS ${name}`); };
  const originalEnv = { ...process.env };
  try {
    const certPath = path.join(directory, 'test-ca.pem'), keyPath = path.join(directory, 'test-key.pem');
    const openssl = process.env.API_NOVA_TEST_OPENSSL || (process.platform === 'win32'
      ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
    const tlsConfig = path.join(directory, 'openssl.cnf');
    await fs.writeFile(tlsConfig, '[req]\ndistinguished_name=dn\n[dn]\nCN=ApiNova Integration Test\n');
    const certificate = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=ApiNova Integration Test',
      '-config', tlsConfig, '-addext', 'subjectAltName=IP:127.0.0.1'], { windowsHide: true, encoding: 'utf8' });
    if (certificate.status !== 0) throw new Error(`Test certificate creation failed: ${certificate.error?.message || certificate.stderr}`);
    const ca = await fs.readFile(certPath), privateTlsKey = await fs.readFile(keyPath);
    const fetchTls = tlsFetch(ca);
    const apiPort = await port(), mcpPort = await port();
    const upstreamCredential = 'Bearer ' + randomBytes(24).toString('hex');
    let upstreamCalls = 0, upstreamCredentialCorrect = true;
    const upstream = http.createServer(async (req, res) => {
      upstreamCalls++;
      upstreamCredentialCorrect &&= req.headers.authorization === upstreamCredential;
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: input.message, password: 'response-private-value' }));
      } catch { if (!res.destroyed) res.writeHead(400).end('{}'); }
    });
    services.push(upstream); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    const firstKeys = await generateKeyPair('RS256'), secondKeys = await generateKeyPair('RS256');
    const firstJwk = { ...await exportJWK(firstKeys.publicKey), kid: 'first' };
    const secondJwk = { ...await exportJWK(secondKeys.publicKey), kid: 'rotated' };
    let publishedKeys = [firstJwk], jwksReads = 0;
    const proxy = https.createServer({ key: privateTlsKey, cert: ca }, (req, res) => {
      if (req.url === '/issuer/jwks') {
        jwksReads++; res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ keys: publishedKeys }));
      }
      let targetPort = apiPort, targetPath = req.url;
      if (req.url.startsWith('/edge/mcp')) { targetPort = mcpPort; targetPath = req.url.replace('/edge/mcp', '/mcp'); }
      if (req.url === '/.well-known/oauth-protected-resource/edge/mcp') {
        targetPort = mcpPort; targetPath = '/.well-known/oauth-protected-resource/mcp';
      }
      if (req.url.startsWith('/edge/gateway')) targetPath = req.url.replace('/edge/gateway', '/api/v1/gateway/secure');
      const forward = http.request({ hostname: '127.0.0.1', port: targetPort, path: targetPath,
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { if (!res.writableEnded) forward.destroy(); });
      req.pipe(forward);
    });
    services.push(proxy); proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const base = `https://127.0.0.1:${proxy.address().port}`;
    const fixture = { upstream: upstreamUrl, runtimeId: randomUUID(), mcpRuntimeId: randomUUID(), mcpServerId: randomUUID(), endpointId: randomUUID(),
      instanceId: randomUUID(), routeId: randomUUID(), membershipId: randomUUID(), bindingId: randomUUID(), sourceId: randomUUID() };
    fixture.spec = { openapi: '3.0.3', info: { title: 'Integration', version: '1' }, servers: [{ url: upstreamUrl }],
      paths: { '/echo': { post: { operationId: 'echo', 'x-runtime-asset-id': fixture.mcpRuntimeId,
        'x-endpoint-definition-id': fixture.endpointId, 'x-source-service-instance-id': fixture.instanceId,
        'x-api-nova-credential-ref': 'env-headers:Authorization=INTEGRATION_UPSTREAM_CREDENTIAL',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          properties: { message: { type: 'string' } }, required: ['message'] } } } },
        responses: { '200': { description: 'OK' } } } } } };
    const fixturePath = path.join(directory, 'fixture.json'); await fs.writeFile(fixturePath, JSON.stringify(fixture));
    const adminPassword = `Test!${randomBytes(18).toString('hex')}`;
    const env = { ...process.env, NODE_ENV: 'test', PORT: String(apiPort), MCP_PORT: String(mcpPort),
      DB_TYPE: 'sqlite', DB_SQLITE_PATH: path.join(directory, 'isolated.sqlite'), DB_SYNCHRONIZE: 'false',
      DB_LOGGING: 'false', JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      SUPER_ADMIN_USERNAME: 'integration-admin', SUPER_ADMIN_EMAIL: 'integration@example.invalid', SUPER_ADMIN_PASSWORD: adminPassword,
      API_NOVA_RUNTIME_AUTH_MODE: 'oauth', API_NOVA_RUNTIME_ISSUER: `${base}/issuer`,
      API_NOVA_RUNTIME_JWKS_URI: `${base}/issuer/jwks`, API_NOVA_RUNTIME_JWKS_JSON: '',
      API_NOVA_GATEWAY_RESOURCE: `${base}/edge/gateway`, API_NOVA_MCP_RESOURCE: `${base}/edge/mcp`,
      API_NOVA_RUNTIME_REQUIRED_SCOPES: 'api:invoke', API_NOVA_MCP_TOOL_SCOPES: '{}',
      API_NOVA_AUDIT_DIR: path.join(directory, 'audit'), API_NOVA_AUDIT_SERVER_ID: fixture.runtimeId,
      NODE_EXTRA_CA_CERTS: certPath, INTEGRATION_FIXTURE: fixturePath, INTEGRATION_UPSTREAM_CREDENTIAL: upstreamCredential,
      THROTTLE_LIMIT: '1000', LOG_DIRECTORY: path.join(directory, 'logs'), PID_DIRECTORY: path.join(directory, 'pids') };
    function start(mode) {
      const child = fork(__filename, [mode], { cwd: directory,
        env: mode === '--mcp' ? { ...env, API_NOVA_AUDIT_SERVER_ID: fixture.mcpServerId } : env,
        silent: true, windowsHide: true });
      children.push(child);
      child.stdout.on('data', chunk => childLogs.push(chunk.toString()));
      child.stderr.on('data', chunk => childLogs.push(chunk.toString()));
      return child;
    }
    const prepared = start('--prepare');
    assert.equal((await once(prepared, 'exit'))[0], 0, 'isolated fixture database initialization');
    start('--api'); start('--mcp');
    const waitUntil = async (predicate, message, timeout = 30000) => {
      const until = Date.now() + timeout;
      do { try { if (await predicate()) return; } catch {} await delay(200); } while (Date.now() < until);
      throw new Error(message);
    };
    await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${apiPort}/api/health/ready`)).json()).status === 'ready', 'API did not become ready');
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${mcpPort}/health`)).ok, 'MCP did not start');
    check('real API and MCP processes with isolated SQLite');
    const metadata = await fetchTls(`${base}/.well-known/oauth-protected-resource/edge/mcp`);
    assert.equal(metadata.status, 200); assert.equal((await metadata.json()).resource, env.API_NOVA_MCP_RESOURCE);
    const gatewayMetadata = await fetchTls(`${base}/.well-known/oauth-protected-resource/edge/gateway`);
    assert.equal(gatewayMetadata.status, 200); assert.equal((await gatewayMetadata.json()).resource, env.API_NOVA_GATEWAY_RESOURCE);
    const preflight = await fetchTls(`${base}/edge/mcp`, { method: 'OPTIONS', headers: { origin: base } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), base);
    check('HTTPS prefixed protected-resource metadata');
    const mint = (audience, rotated = false) => new SignJWT({ sub: 'external-caller', scope: 'api:invoke' })
      .setProtectedHeader({ alg: 'RS256', kid: rotated ? 'rotated' : 'first' })
      .setIssuer(env.API_NOVA_RUNTIME_ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('5m')
      .sign(rotated ? secondKeys.privateKey : firstKeys.privateKey);
    const gatewayToken = await mint(env.API_NOVA_GATEWAY_RESOURCE), mcpToken = await mint(env.API_NOVA_MCP_RESOURCE);
    const payload = 'p'.repeat(9000);
    const gatewayCall = token => fetchTls(`${base}/edge/gateway/echo`, { method: 'POST',
      signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message: payload }) });
    const missing = await gatewayCall(); assert.equal(missing.status, 401);
    assert.ok(missing.headers.get('www-authenticate').includes(`${base}/.well-known/oauth-protected-resource/edge/gateway`));
    await missing.text();
    const wrong = await gatewayCall(mcpToken); assert.equal(wrong.status, 401); await wrong.text();
    const gatewayResponse = await gatewayCall(gatewayToken);
    assert.equal(gatewayResponse.status, 200, 'real Gateway POST status');
    assert.equal((await gatewayResponse.json()).echo, payload);
    check('Gateway auth, audience isolation and streamed 9 KB POST');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    let currentMcpToken = mcpToken;
    const mcpTransport = new StreamableHTTPClientTransport(new URL(`${base}/edge/mcp`), {
      fetch: (url, init = {}) => { const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${currentMcpToken}`);
        return fetchTls(url, { ...init, headers }); },
    });
    mcpClient = new Client({ name: 'cross-process-integration', version: '1' });
    await mcpClient.connect(mcpTransport);
    const tools = await mcpClient.listTools();
    assert.ok(!(await mcpClient.callTool({ name: tools.tools[0].name, arguments: { message: payload } })).isError);
    assert.ok(upstreamCredentialCorrect); check('SDK client through TLS proxy; upstream credential separation');
    publishedKeys = [firstJwk, secondJwk];
    const newGatewayToken = await mint(env.API_NOVA_GATEWAY_RESOURCE, true);
    const early = await gatewayCall(newGatewayToken); assert.equal(early.status, 401); await early.text();
    console.log('[security-integration] Waiting for the documented JWKS refresh cooldown (31 seconds)');
    await delay(31000);
    const rotatedGateway = await gatewayCall(newGatewayToken); assert.equal(rotatedGateway.status, 200); await rotatedGateway.text();
    currentMcpToken = await mint(env.API_NOVA_MCP_RESOURCE, true);
    assert.ok((await mcpClient.listTools()).tools.length);
    assert.ok(jwksReads >= 4); check('remote JWKS rotation in both processes and same-caller session renewal');
    const login = await fetchTls(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'integration-admin', password: adminPassword }) });
    assert.equal(login.status, 200, 'management login');
    const loginBody = await login.json(); const adminToken = loginBody.accessToken || loginBody.data?.accessToken;
    assert.ok(adminToken, 'management access token');
    const inventoryPath = `${base}/api/v1/monitoring/management/external-callers`;
    assert.equal((await fetchTls(inventoryPath)).status, 401);
    assert.equal((await fetchTls(inventoryPath, { headers: { authorization: `Bearer ${mcpToken}` } })).status, 401);
    const inventoryResponse = await fetchTls(inventoryPath, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(inventoryResponse.status, 200);
    const inventory = await inventoryResponse.json();
    const callerRows = inventory.data.data.filter(item => item.subject === 'external-caller');
    assert.equal(callerRows.length, 1); assert.deepEqual(callerRows[0].transports.sort(), ['gateway', 'mcp']);
    check('protected management caller inventory merges both processes without registration');
    await mcpClient.close(); mcpClient = undefined;
    const files = (await fs.readdir(env.API_NOVA_AUDIT_DIR)).filter(file => /^\d{4}-/.test(file));
    const raw = (await Promise.all(files.map(file => fs.readFile(path.join(env.API_NOVA_AUDIT_DIR, file), 'utf8')))).join('');
    for (const secret of [upstreamCredential, gatewayToken, mcpToken, 'response-private-value']) assert.ok(!raw.includes(secret), 'no credentials in audit');
    const calls = raw.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.kind === 'api');
    assert.equal(calls.length, 3); assert.equal(new Set(calls.map(call => call.callerId)).size, 1);
    for (const call of calls) {
      assert.equal(call.endpointDefinitionId, fixture.endpointId);
      assert.equal(call.runtimeAssetId, call.transport === 'mcp' ? fixture.mcpRuntimeId : fixture.runtimeId);
      if (call.transport === 'mcp') assert.equal(call.serverId, fixture.mcpServerId);
      assert.equal(JSON.parse(call.request.data).message, payload); assert.equal(JSON.parse(call.response.data).echo, payload);
    }
    assert.equal(upstreamCalls, 3); check('per-API full payload evidence and stable cross-process caller identity');
    console.log(JSON.stringify({ marker: 'RUNTIME_SECURITY_INTEGRATION_OK', checks, upstreamCalls, jwksReads }));
  } catch (error) {
    // Only sanitized diagnostics: never echo environment, JWTs, or test credentials.
    console.error(parser.redactAuditValue(childLogs.join('').slice(-5000)));
    throw error;
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, 'exit');
      if (child.connected) child.send('stop'); else child.kill();
      if (!(await Promise.race([ended.then(() => true), delay(5000).then(() => false)]))) child.kill();
      await ended;
    }
    for (const service of services.reverse()) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
    process.env = originalEnv;
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('api-nova-security-integration-'))
      throw new Error('Refusing unsafe temporary directory cleanup');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

if (process.argv[2]?.startsWith('--')) childMode(process.argv[2]).catch(error => { console.error(error.message); process.exit(1); });
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
