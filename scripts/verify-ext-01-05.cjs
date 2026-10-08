// EXT-01..05: local real-HTTP product lifecycle, from import/registration to authenticated consumption.
// Each run owns a fresh SQLite database and loopback ports. No existing service or data is used.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'packages/api-nova-api');
const apiEntry = path.join(apiDir, 'dist/src/main.js');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, '.tmp/ext-01-05-')));
const dbPath = path.join(workDir, 'acceptance.sqlite');
const registryPath = path.join(workDir, 'registry.json');
const evidencePath = path.join(workDir, 'evidence.json');
const secrets = [];
const children = [];
const upstreams = [];
const evidence = { marker: 'EXT_01_05_LOCAL_HTTP_V1', startedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  platform: process.platform, node: process.version, database: { type: 'sqlite', path: dbPath, isolated: true }, steps: [],
  notCovered: ['external deployed upstreams', 'PostgreSQL', 'browser interactions', 'production identity providers', 'MCP transport'] };
let apiBase, token, apiProcess;
function redact(value) { let text = String(value); for (const s of secrets) if (s) text = text.split(s).join('[redacted]'); return text; }
function save() { fs.writeFileSync(evidencePath, redact(JSON.stringify(evidence, null, 2))); }
async function step(id, fn) {
  try { const details = await fn(); evidence.steps.push({ id, passed: true, details: structuredClone(details) }); console.log(`PASS ${id}`); save(); return details; }
  catch (e) { evidence.steps.push({ id, passed: false, error: redact(e.message) }); save(); throw e; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, body: data };
}
async function api(method, url, body, expected = method === 'POST' ? 201 : 200) {
  const r = await request(`${apiBase}/api${url}`, { method, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal(r.status, expected, `${method} ${url}: ${r.status} ${redact(JSON.stringify(r.body)).slice(0, 1800)}`); return r.body;
}
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function spec(title, paths, server) { return { openapi: '3.0.3', info: { title, version: '1.0.0' }, ...(server ? { servers: [{ url: server }] } : {}),
  paths: Object.fromEntries(paths.map(p => [p, { get: { operationId: title + p.replace(/\W/g, ''), responses: { '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } } } }])) }; }
async function upstream(name) {
  const state = { name, received: [], documents: {} };
  state.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.received.push({ path: url.pathname, credentialPresent: Boolean(req.headers['x-api-key'] || req.headers.authorization) });
    res.setHeader('content-type', 'application/json');
    if (state.documents[url.pathname]) return res.end(JSON.stringify(state.documents[url.pathname]));
    res.end(JSON.stringify({ ok: true, path: url.pathname, instance: name }));
  });
  await new Promise(r => state.server.listen(0, '127.0.0.1', r)); state.port = state.server.address().port; state.url = `http://127.0.0.1:${state.port}`;
  upstreams.push(state); return state;
}
function registry(revision, sites) { return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'extclosure' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: {}, credentials: {}, sites }; }
async function reloadRegistry(records, host, revision) {
  const status = await api('GET', '/security/upstream-credentials/status');
  const grouped = new Map();
  for (const r of records) { if (!grouped.has(r.source)) grouped.set(r.source, []); grouped.get(r.source).push({ endpointDefinitionId: r.id }); }
  const sites = [...grouped].map(([source, endpoints], i) => ({ id: `site-${i}`, sourceServiceAssetId: source,
    match: { scheme: 'http', host: '127.0.0.1', port: host.port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none',
    headerPolicy: { version: 1, requestHeaders: [], responseHeaders: [] }, endpoints }));
  fs.writeFileSync(registryPath, JSON.stringify(registry(revision, sites)));
  const result = await api('POST', '/security/upstream-credentials/reload', { expectedGeneration: status.generation, reason: 'EXT lifecycle controlled loopback upstream registration' }, 200);
  assert.equal(result.generation, status.generation + 1); return { generation: result.generation };
}
async function importUrl(host, name, paths, bound) {
  const url = `${host.url}/${name}.json`; host.documents[`/${name}.json`] = spec(name, paths, bound ? host.url : undefined);
  const parsed = await api('GET', `/openapi/parse-url?url=${encodeURIComponent(url)}`); assert.equal(parsed.endpoints.length, paths.length);
  const fetched = await request(url); assert.equal(fetched.status, 200);
  const doc = await api('POST', '/documents', { name, content: JSON.stringify(fetched.body), status: 'valid', metadata: { importSource: 'url', originalUrl: url } });
  const catalog = await api('GET', '/v1/assets/endpoints');
  const endpoints = catalog.data.filter(x => x.metadata?.documentId === doc.id); assert.equal(endpoints.length, paths.length);
  const records = [];
  for (const ep of endpoints) { const d = await api('GET', `/v1/assets/endpoints/${ep.id}`); records.push({ id: ep.id, path: ep.path, source: d.sourceServiceAsset.id, documentId: doc.id }); }
  return records;
}
async function instances(source) { return (await api('GET', `/v1/assets/source-services/${source}/instances`)).data; }
async function attach(source, host) {
  return api('POST', `/v1/assets/source-services/${source}/instances`, { name: `upstream-${host.name}`, environment: 'extclosure', scheme: 'http', host: '127.0.0.1', port: host.port, basePath: '/', enabled: true, isDefault: true });
}
async function ready(record, instance) {
  await api('POST', `/v1/assets/source-services/${record.source}/instances/${instance.id}/probe`, {});
  const probe = await api('POST', `/v1/assets/endpoints/${record.id}/probe`, {}); assert.equal(probe.endpoint.status, 'verified');
  const test = await api('POST', `/v1/assets/endpoints/${record.id}/test`, { sourceServiceInstanceId: instance.id, environment: instance.environment }); assert.equal(test.test.passed, true);
  const samples = (await api('GET', `/v1/endpoint-testing/endpoints/${record.id}/test-samples`)).data; assert.ok(samples.length);
  // Compare stable business fields across host replacement; the response's instance identifies A/B separately.
  for (const sample of samples) await api('PATCH', `/v1/endpoint-testing/test-samples/${sample.id}`, { tags: ['smoke'] });
  const readiness = await api('GET', `/v1/assets/endpoints/${record.id}/readiness`); assert.equal(readiness.ready, true, JSON.stringify(readiness));
  record.instanceId = instance.id; record.environment = instance.environment; record.sampleIds = samples.map(s => s.id);
}
async function binding(record) {
  const r = await api('PUT', `/v1/runtime-memberships/${record.membershipId}/upstream-binding`, { sourceServiceAssetId: record.source,
    environment: record.environment, selectionMode: 'fixed_primary', primaryInstanceId: record.instanceId, status: 'active', candidates: [{ sourceServiceInstanceId: record.instanceId }] });
  record.bindingId = r.binding.id; record.bindingRevision = r.binding.revision;
}
async function deploy(assetId) {
  await delay(1100);
  const result = await api('POST', `/v1/runtime-assets/${assetId}/deploy-gateway`, { publishedOnly: true });
  assert.equal(result.verification?.run?.status, 'passed', JSON.stringify(result)); assert.equal(result.verification.run.activationStatus, 'activated');
  return result.verification.run;
}
async function consume(assetId, records, key, host) {
  const detail = await api('GET', `/v1/runtime-assets/${assetId}`);
  const findUrls = (value) => { if (!value || typeof value !== 'object') return []; if (Array.isArray(value.accessUrls)) return value.accessUrls; return Object.values(value).flatMap(findUrls); };
  const urls = [...new Set(findUrls(detail))]; assert.equal(urls.length, records.length, `advertised URLs ${JSON.stringify(urls)}`);
  for (const url of urls) {
    assert.equal(new URL(url).origin, apiBase); assert.ok(new URL(url).pathname.startsWith('/api/v1/gateway/closure/'));
    const count = host.received.length;
    for (const headers of [{}, { 'x-api-key': 'invalid.not-valid' }]) { const denied = await request(url, { headers }); assert.equal(denied.status, 401); }
    assert.equal(host.received.length, count, 'rejected consumers reached upstream');
    const response = await request(url, { headers: { 'x-api-key': key } }); assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.instance, host.name); assert.equal(host.received.length, count + 1); assert.equal(host.received.at(-1).credentialPresent, false, 'consumer credentials leaked upstream');
  }
  return { urls, instance: host.name, deniedRequests: urls.length * 2, successfulRequests: urls.length };
}
async function main() {
  assert.ok(fs.existsSync(apiEntry), 'Build api-nova-api first');
  const artifactPaths = [__filename, apiEntry,
    path.join(apiDir, 'dist/src/modules/asset-catalog/services/asset-catalog.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-security.service.js'),
    path.join(apiDir, 'dist/src/modules/gateway-runtime/services/gateway-candidate-replay-authority.js'),
    path.join(apiDir, 'dist/src/modules/runtime-verification/services/gateway-candidate-replay.service.js')];
  evidence.artifacts = artifactPaths.map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  evidence.workingTree = spawnSync('git', ['status', '--short', '--untracked-files=no'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const a = await upstream('A'); const b = await upstream('B'); const apiPort = await port(); const mcpPort = await port(); apiBase = `http://127.0.0.1:${apiPort}`;
  evidence.ports = { api: apiPort, mcp: mcpPort, upstreamA: a.port, upstreamB: b.port };
  const password = `ExtClosure!${randomBytes(18).toString('hex')}`; const jwt = randomBytes(32).toString('hex'); secrets.push(password, jwt);
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_)/i.test(k)) delete env[k];
  Object.assign(env, { NODE_ENV: 'test', PORT: String(apiPort), MCP_PORT: String(mcpPort), MCP_SERVER_PORT: String(mcpPort), DB_TYPE: 'sqlite', DB_SQLITE_PATH: dbPath, DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', JWT_SECRET: jwt, JWT_REFRESH_SECRET: jwt,
    SUPER_ADMIN_USERNAME: 'extclosureadmin', SUPER_ADMIN_EMAIL: 'extclosure@example.invalid', SUPER_ADMIN_PASSWORD: password,
    API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database', API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_RUNTIME_REQUIRED_SCOPES: '', API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_UPSTREAM_CREDENTIAL_FILE: registryPath, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json', API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT: 'extclosure', API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE: 'manual',
    API_NOVA_AUDIT_DIR: path.join(workDir, 'audit'), PID_DIRECTORY: path.join(workDir, 'pids'), LOG_DIRECTORY: path.join(workDir, 'logs'), API_BASE_URL: apiBase, THROTTLE_LIMIT: '10000', THROTTLE_TTL: '60' });
  fs.writeFileSync(registryPath, JSON.stringify(registry('bootstrap', [])));
  await step('isolated.migration', async () => {
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'] : ['run', 'migration:run', '--workspace', 'api-nova-api'];
    const r = spawnSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 32e6 });
    fs.writeFileSync(path.join(workDir, 'migration.log'), redact(`${r.stdout}\n${r.stderr}`)); assert.equal(r.status, 0, 'migration failed; see migration.log'); return { freshDatabase: fs.existsSync(dbPath) };
  });
  const log = fs.openSync(path.join(workDir, 'api.log'), 'w'); apiProcess = spawn(process.execPath, [apiEntry], { cwd: apiDir, env, stdio: ['ignore', log, log], windowsHide: true }); children.push(apiProcess); fs.closeSync(log);
  await step('isolated.start', async () => {
    const until = Date.now() + 90000; while (Date.now() < until) { if (apiProcess.exitCode !== null) throw new Error(`API exited ${apiProcess.exitCode}; see ${workDir}/api.log`);
      try { const r = await request(`${apiBase}/api/health/ready`); if (r.status === 200 && r.body.status === 'ready') return { port: apiPort }; } catch {} await delay(300); }
    throw new Error('API readiness timeout');
  });
  const login = await api('POST', '/auth/login', { username: 'extclosureadmin', password }, 200); token = login.accessToken; assert.ok(token); secrets.push(token);
  const records = [];
  await step('EXT01.url_import_provisional_instance', async () => {
    const imported = await importUrl(a, 'bound-source', ['/catalog', '/orders'], true); const list = await instances(imported[0].source); assert.ok(list.length, 'URL import did not create provisional instance');
    const initial = list.find(i => i.port === a.port && i.enabled); assert.ok(initial); for (const r of imported) await ready(r, initial); records.push(...imported); return { records: imported, provisionalInstanceId: initial.id };
  });
  await step('EXT02.unbound_import_attach_without_reimport', async () => {
    const [r] = await importUrl(a, 'unbound-source', ['/unbound'], false); const initial = await instances(r.source); assert.equal(initial.length, 0, 'unbound import created fake instance');
    const callsBefore = a.received.length;
    const unbound = await request(`${apiBase}/api/v1/assets/endpoints/${r.id}/test`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${token}` } });
    assert.equal(unbound.status, 400, 'unbound endpoint must be rejected before execution'); assert.equal(a.received.length, callsBefore);
    const instance = await attach(r.source, a); await ready(r, instance); const after = await api('GET', `/v1/assets/endpoints/${r.id}`); assert.equal(after.endpoint.id, r.id); records.push(r); return { endpointId: r.id, instanceId: instance.id };
  });
  await step('EXT03.manual_registration_and_governance', async () => {
    const result = await api('POST', '/v1/assets/endpoints/manual', { name: 'manual-source', baseUrl: a.url, method: 'GET', path: '/manual', description: 'Lifecycle manual endpoint' });
    const r = { id: result.id, path: result.endpoint.path, source: result.sourceServiceAsset.id };
    const list = await instances(r.source); const instance = list.find(i => i.port === a.port && i.enabled) || await attach(r.source, a); await ready(r, instance); records.push(r); return { endpointId: r.id, instanceId: instance.id };
  });
  await step('registry.upstream_A', () => reloadRegistry(records, a, 'upstream-a'));
  let assetId;
  await step('publication.aggregate_authenticated_gateway', async () => {
    const created = await api('POST', '/v1/publication/endpoints/runtime-assets', { type: 'gateway_service', name: 'closure-gateway', displayName: 'Lifecycle Gateway', servicePrefix: 'closure' }); assetId = created.runtimeAsset.id;
    for (const r of records) {
      const add = await api('POST', `/v1/publication/endpoints/runtime-assets/${assetId}/memberships`, { endpointDefinitionIds: [r.id] }); r.membershipId = add.createdMemberships[0].id;
      const route = await api('PUT', `/v1/publication/endpoints/runtime-memberships/${r.membershipId}/gateway-route`, { routePath: r.path, routeMethod: 'GET', upstreamPath: r.path, upstreamMethod: 'GET', routeVisibility: 'external', authPolicyRef: 'api-key-default', upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } } }); r.routeId = route.routeBinding.id;
      await api('PUT', `/v1/publication/endpoints/runtime-memberships/${r.membershipId}/profile`, { intentName: `closure${r.path.replace(/\W/g, '')}`, descriptionForLlm: `Read ${r.path}`, status: 'reviewed' });
      await api('POST', `/v1/publication/endpoints/runtime-memberships/${r.membershipId}/publish`, { publishToHttp: true, autoStart: false }); await binding(r);
    }
    return { assetId, records };
  });
  const issuance = await api('POST', `/v1/runtime-assets/${assetId}/runtime-access-credentials`, { name: 'Lifecycle consumer', protocols: ['gateway'], scopes: [], toolScopes: [] }); const key = issuance.apiKey; assert.ok(key); secrets.push(key, key.split('.').slice(1).join('.'));
  const first = await step('publication.verified_deploy_A', () => deploy(assetId));
  await step('EXT05.advertised_multi_endpoint_authenticated_consumer', () => consume(assetId, records, key, a));
  await step('EXT04.retire_A_attach_B_preserve_identity', async () => {
    const old = [...new Map(records.map(r => [r.instanceId, r])).values()];
    for (const r of old) await api('POST', `/v1/assets/source-services/${r.source}/instances/${r.instanceId}/archive`, {});
    await new Promise(resolve => a.server.close(resolve));
    const replacements = new Map(); for (const r of records) { if (!replacements.has(r.source)) replacements.set(r.source, await attach(r.source, b)); await ready(r, replacements.get(r.source)); await binding(r); }
    const detail = await api('GET', `/v1/runtime-assets/${assetId}`); assert.equal(detail.asset.metadata.verificationRequired, true);
    await reloadRegistry(records, b, 'upstream-b'); const second = await deploy(assetId); assert.notEqual(second.candidateRevision, first.candidateRevision);
    const catalog = await api('GET', '/v1/assets/endpoints'); for (const r of records) assert.ok(catalog.data.some(e => e.id === r.id && e.path === r.path));
    const verificationEvidence = await api('GET', `/v1/runtime-assets/${assetId}/verification-runs/${second.id}`);
    for (const r of records) {
      const verifiedBinding = verificationEvidence.run.upstreamBindingRevisions.find(x => x.runtimeMembershipId === r.membershipId);
      assert.equal(verifiedBinding?.resolvedSourceServiceInstanceId, r.instanceId, 'deployment evidence must pin replacement instance B');
      const results = verificationEvidence.results.filter(x => x.runtimeMembershipId === r.membershipId && x.kind === 'smoke');
      assert.ok(results.length, 'no persisted smoke result for switched membership');
      for (const result of results) { assert.equal(result.status, 'passed'); assert.equal(result.evidence?.responsePayload?.instance, 'B'); }
      const currentBinding = await api('GET', `/v1/runtime-memberships/${r.membershipId}/upstream-binding`);
      assert.equal(currentBinding.binding.primaryInstanceId, r.instanceId);
      const endpoint = await api('GET', `/v1/assets/endpoints/${r.id}`);
      assert.equal(endpoint.endpoint.metadata.lastProbeInstanceId, r.instanceId);
      assert.ok(String(endpoint.endpoint.metadata.probeUrl).startsWith(b.url), 'probe evidence must identify replacement host B');
    }
    const calls = await consume(assetId, records, key, b); return { records, verificationEvidence, oldRevision: first.candidateRevision, newRevision: second.candidateRevision, verificationRun: second, calls };
  });
  await step('consumer.revoke', async () => {
    await api('POST', `/v1/runtime-assets/${assetId}/runtime-access-credentials/${issuance.credential.id}/revoke`, { reason: 'Lifecycle completed' });
    const before = b.received.length; const denied = await request(`${apiBase}/api/v1/gateway/closure/catalog`, { headers: { 'x-api-key': key } }); assert.equal(denied.status, 401); assert.equal(b.received.length, before); return { rejected: true };
  });
  evidence.ok = true;
}
async function finish() {
  for (const child of children) if (child.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM'); }
  for (const up of upstreams) { up.server.closeAllConnections(); await new Promise(resolve => up.server.close(resolve)); }
  const apiLog = path.join(workDir, 'api.log'); if (fs.existsSync(apiLog)) fs.writeFileSync(apiLog, redact(fs.readFileSync(apiLog, 'utf8')));
  evidence.finishedAt = new Date().toISOString(); save(); console.log(`${evidence.ok ? 'EXT_01_05_VERIFY_OK' : 'EXT_01_05_VERIFY_FAIL'} ${evidencePath}`);
}
main().catch(e => { evidence.ok = false; evidence.error = redact(e.stack); console.error(redact(e.message)); process.exitCode = 1; }).finally(finish);
