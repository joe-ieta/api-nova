'use strict';
// ENV-01: real full-health evidence without changing host policy or health thresholds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'packages/api-nova-api');
const entry = path.join(apiDir, 'dist/src/main.js');
const mcpEntry = path.join(root, 'packages/api-nova-server/dist/cli.js');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const workDir = fs.mkdtempSync(path.join(root, '.tmp/env-01-'));
const evidence = { startedAt: new Date().toISOString(), platform: process.platform, release: os.release(), node: process.version,
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  workDir, limits: ['Local Windows only; no deployment signoff', 'Readiness only measures process uptime', 'MCP health does not prove tool business correctness'] };
const children = [];
const secrets = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
function redact(text) { for (const secret of secrets) text = text.split(secret).join('[redacted]'); return text; }
function save() { fs.writeFileSync(path.join(workDir, 'evidence.json'), redact(JSON.stringify(evidence, null, 2))); }
async function port() { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const result = server.address().port; await new Promise(r => server.close(r)); return result; }
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; }
async function wait(url, child, predicate) { const until = Date.now() + 90000; while (Date.now() < until) { if (child.exitCode !== null) throw new Error(`Child exited ${child.exitCode}; inspect owned logs`); try { const r = await get(url); if (predicate(r)) return r; } catch {} await delay(300); } throw new Error(`Timed out: ${url}`); }
function launch(name, args, env, cwd) { const fd = fs.openSync(path.join(workDir, `${name}.log`), 'w'); const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); children.push(child); return child; }
async function main() {
  assert.equal(process.platform, 'win32', 'ENV-01 is a Windows host verification');
  for (const file of [entry, mcpEntry]) assert.ok(fs.existsSync(file), `Build missing: ${file}`);
  evidence.artifacts = [__filename, entry, mcpEntry, path.join(apiDir, 'dist/src/modules/health/health.controller.js')].map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  const apiPort = await port(); let mcpPort = await port(); while (mcpPort === apiPort) mcpPort = await port();
  evidence.ports = { api: apiPort, mcp: mcpPort };
  const jwt = randomBytes(32).toString('hex'); const password = `Env01!${randomBytes(18).toString('hex')}`; secrets.push(jwt, password);
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_)/i.test(key)) delete env[key];
  Object.assign(env, { NODE_ENV: 'test', PORT: String(apiPort), MCP_SERVER_HOST: '127.0.0.1', MCP_SERVER_PORT: String(mcpPort), MCP_PORT: String(mcpPort),
    DB_TYPE: 'sqlite', DB_SQLITE_PATH: path.join(workDir, 'acceptance.sqlite'), DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', JWT_SECRET: jwt, JWT_REFRESH_SECRET: jwt,
    SUPER_ADMIN_USERNAME: 'env01admin', SUPER_ADMIN_EMAIL: 'env01@example.invalid', SUPER_ADMIN_PASSWORD: password,
    API_NOVA_RUNTIME_AUTH_MODE: 'api_key', API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database', API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK: 'true',
    API_NOVA_AUDIT_DIR: path.join(workDir, 'audit'), PID_DIRECTORY: path.join(workDir, 'pids'), LOG_DIRECTORY: path.join(workDir, 'logs'), API_BASE_URL: `http://127.0.0.1:${apiPort}` });
  const migrate = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run migration:run --workspace api-nova-api'], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 32e6 });
  fs.writeFileSync(path.join(workDir, 'migration.log'), redact(`${migrate.stdout}\n${migrate.stderr}`)); assert.equal(migrate.status, 0, 'Isolated migration failed');
  const withMonitoring = process.argv.includes('--with-monitoring');
  if (withMonitoring) {
    const uiDist = path.join(root, 'packages/api-nova-ui/dist');
    assert.ok(fs.existsSync(path.join(uiDist, 'index.html')), 'Build UI first for packaged SPA verification');
    fs.symlinkSync(uiDist, path.join(workDir, 'public'), 'junction');
  }
  const api = launch('api', [entry], env, withMonitoring ? workDir : apiDir); const base = `http://127.0.0.1:${apiPort}`;
  evidence.ready = await wait(`${base}/api/health/ready`, api, r => r.status === 200 && r.body.status === 'ready');
  if (withMonitoring) {
    const uiPort = await port(); evidence.ports.ui = uiPort;
    const ui = launch('ui', [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { ...env, VITE_PROXY_TARGET: base }, path.join(root, 'packages/api-nova-ui'));
    const uiBase = `http://127.0.0.1:${uiPort}`;
    await wait(`${uiBase}/api/health/ready`, ui, r => r.status === 200 && r.body.status === 'ready');
    evidence.monitoring = [];
    for (const [mode, origin] of [['packaged', base], ['vite', uiBase]]) {
      const page = await get(`${origin}/monitoring`); assert.equal(page.status, 200); assert.match(page.body, /<div id="app"><\/div>/);
      const ready = await get(`${origin}/api/health/ready`); assert.equal(ready.body.status, 'ready');
      const missing = await get(`${origin}/api/env01-no-such-route`); assert.equal(missing.status, 404); assert.equal(typeof missing.body, 'object');
      const handshake = await get(`${origin}/socket.io/?EIO=4&transport=polling`); assert.equal(handshake.status, 200); assert.match(handshake.body, /^0\{"sid":/);
      evidence.monitoring.push({ mode, pageStatus: page.status, readyStatus: ready.status, missingApiStatus: missing.status, socketHandshakeStatus: handshake.status });
    }
  }
  evidence.live = await get(`${base}/api/health/live`); assert.equal(evidence.live.body.status, 'alive');
  evidence.fullIdle = await get(`${base}/health`); assert.equal((evidence.fullIdle.body.details || evidence.fullIdle.body.error?.details?.details).mcp_server.status, 'down');
  const policies = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-ExecutionPolicy -List | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  evidence.executionPolicies = { status: policies.status, output: policies.stdout?.trim(), error: policies.stderr?.trim() };
  try { const disk = await require('check-disk-space').default('C:\\'); evidence.systemDisk = { ...disk, usedRatio: (disk.size - disk.free) / disk.size, requiredFreeBytes: Math.ceil(disk.size * 0.1), additionalFreeBytesNeeded: Math.max(0, Math.ceil(disk.size * 0.1 - disk.free)) }; }
  catch (error) { evidence.systemDisk = { error: error.message }; }
  const mcp = launch('mcp', [mcpEntry, '--transport', 'streamable', '--host', '127.0.0.1', '--port', String(mcpPort)], env, workDir);
  evidence.mcpDirect = await wait(`http://127.0.0.1:${mcpPort}/health`, mcp, r => r.status === 200);
  evidence.fullRunning = await get(`${base}/health`); assert.equal((evidence.fullRunning.body.details || evidence.fullRunning.body.error?.details?.details).mcp_server.status, 'up');
  for (const check of ['memory_heap', 'memory_rss']) assert.equal((evidence.fullRunning.body.details || evidence.fullRunning.body.error?.details?.details)[check].status, 'up', `${check} is not healthy`);
  const failures = Object.entries(evidence.fullRunning.body.details || evidence.fullRunning.body.error?.details?.details).filter(([, value]) => value.status !== 'up').map(([key]) => key);
  evidence.remainingFailures = failures;
  if (failures.length) { assert.deepEqual(failures, ['disk']); assert.equal(evidence.fullRunning.status, 503); assert.ok(evidence.systemDisk.error || evidence.systemDisk.usedRatio > 0.9); evidence.outcome = 'LIMITED_HOST_DISK'; }
  else { assert.equal(evidence.fullRunning.status, 200); evidence.outcome = 'FULL_HEALTH_PASSED'; }
  evidence.contractSatisfied = true;
}
async function finish() {
  for (const child of children) if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  await delay(400);
  evidence.cleanup = {};
  for (const [name, value] of Object.entries(evidence.ports || {})) { try { await fetch(`http://127.0.0.1:${value}/health`, { signal: AbortSignal.timeout(1000) }); evidence.cleanup[name] = false; } catch { evidence.cleanup[name] = true; } }
  for (const name of ['api.log', 'mcp.log', 'ui.log']) { const file = path.join(workDir, name); if (fs.existsSync(file)) fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8'))); }
  if (Object.values(evidence.cleanup).some(ok => !ok)) { evidence.contractSatisfied = false; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save(); console.log(`ENV_01_${evidence.contractSatisfied ? 'EVIDENCE_COMPLETE' : 'FAILED'} ${path.join(workDir, 'evidence.json')}`);
}
main().catch(error => { evidence.error = redact(error.stack); process.exitCode = 1; console.error(error.message); }).finally(finish);
