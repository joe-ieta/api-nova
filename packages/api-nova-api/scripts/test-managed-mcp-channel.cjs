'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const Module = require('node:module');
const { once, EventEmitter } = require('node:events');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apinova-managed-channel-'));
const serverRoot = path.resolve(__dirname, '../../api-nova-server');
// Compile only the two dependency-free managed entry files, never shared dist.
const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
  path.join(serverRoot, 'src/managed/entry.ts'), path.join(serverRoot, 'src/managed/handoff.ts'),
  '--outDir', directory, '--module', 'commonjs', '--target', 'ES2020', '--types', 'node', '--skipLibCheck'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stdout + build.stderr);
const ts = require('typescript');
const channelPath = path.resolve(__dirname, '../src/modules/servers/services/managed-mcp-channel.ts');
const check = ts.createProgram([channelPath], { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10, strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true,
  types: ['node'], typeRoots: [path.dirname(path.dirname(require.resolve('@types/node/package.json')))],
  paths: { 'api-nova-server': [path.join(serverRoot, 'src/managed/handoff.ts')] } });
const diagnostics = ts.getPreEmitDiagnostics(check);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
const entry = path.join(directory, 'entry.js');
const wire = require(path.join(directory, 'handoff.js'));
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const originalResolve = Module._resolveFilename;
let selectedEntry = entry;
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-server') return path.join(directory, 'handoff.js');
  if (name === 'api-nova-server/dist/managed/entry.js') return selectedEntry;
  return originalResolve.call(this, name, ...rest);
};
const { startManagedMcpChannel, buildManagedEnvironment } = require('../src/modules/servers/services/managed-mcp-channel.ts');
after(() => { Module._resolveFilename = originalResolve; fs.rmSync(directory, { recursive: true, force: true }); });
const payload = () => ({ version: 1, launchId: 'launch-fixture', managedServerId: 'server-fixture', runtimeAssetId: 'runtime-fixture',
  inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-fixture', verificationRunId: 'verification-fixture', behaviorFingerprint: 'a'.repeat(64),
  transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' }, openApiData: { openapi: '3.0.3', paths: {} },
  trustedOperationBindings: [], registrySource: { configId: 'fixture', path: path.join(directory, 'unread-source.json'), format: 'json', environment: 'test', expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } });
const input = () => ({ launchId: 'launch-fixture', serverId: 'server-fixture', payload: payload(), approvedEnvironmentNames: [], environmentValues: {} });

test('actual dedicated child ACK is not READY and terminates with fixed failure when activation dependencies are unavailable', async () => {
  const handle = await startManagedMcpChannel(input());
  assert.equal(handle.state, 'handoffAccepted'); assert.ok(handle.pid > 0);
  assert.deepEqual(await handle.closed, { code: 'MANAGED_RUNTIME_FAILED' });
  await Promise.all([handle.close(), handle.close()]);
  assert.throws(() => process.kill(handle.pid, 0));
  assert.deepEqual(Object.keys(handle).sort(), ['close', 'closed', 'launchId', 'pid', 'ready', 'state']);
});

test('real child sees exact approved environment, no ambient NODE_OPTIONS/management secrets or secret argv', async () => {
  const report = path.join(directory, 'environment-report.json'), wrapper = path.join(directory, 'report-entry.cjs');
  fs.writeFileSync(wrapper, `require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv:process.argv, env:process.env })); require(${JSON.stringify(entry)}).runManagedEntry();`);
  const names = ['SYNTHETIC_PRIVATE', 'JWT_SECRET', 'NODE_OPTIONS'];
  const saved = names.map(name => process.env[name]);
  process.env.SYNTHETIC_PRIVATE = 'must-not-inherit'; process.env.JWT_SECRET = 'synthetic-management-secret'; process.env.NODE_OPTIONS = '--require nonexistent-fixture';
  selectedEntry = wrapper;
  try {
    const request = input(); request.approvedEnvironmentNames = ['SYNTHETIC_ALLOWED']; request.environmentValues = { SYNTHETIC_ALLOWED: 'synthetic-provider-value' };
    const handle = await startManagedMcpChannel(request); await handle.closed;
    const actual = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(actual.env.SYNTHETIC_ALLOWED, 'synthetic-provider-value');
    for (const name of names) assert.equal(actual.env[name], undefined);
    assert.ok(!JSON.stringify(actual.argv).includes('synthetic-provider-value'));
    assert.ok(!JSON.stringify(handle).includes('synthetic-provider-value'));
    assert.ok(!actual.argv.some(value => /bearer-token|custom-header|openapi/.test(value)));
  } finally { selectedEntry = entry; names.forEach((name, n) => { if (saved[n] === undefined) delete process.env[name]; else process.env[name] = saved[n]; }); }
});

test('environment rejects injection, unapproved values, case collisions, absent values and getters', () => {
  for (const [names, values] of [[['NODE_OPTIONS'], { NODE_OPTIONS: '--require fixture' }], [['PATH'], { PATH: 'fixture' }], [[], { SECRET: 'fixture' }], [['TOKEN', 'token'], {}], [['TOKEN'], {}]]) {
    assert.throws(() => buildManagedEnvironment(names, values), /MANAGED_ENVIRONMENT_REJECTED/);
  }
  const values = Object.defineProperty({}, 'TOKEN', { enumerable: true, get() { throw Error('private-getter'); } });
  assert.throws(() => buildManagedEnvironment(['TOKEN'], values), /^ManagedChannelError: MANAGED_ENVIRONMENT_REJECTED$/);
});

test('shared wire rejects unknown fields, malformed data, getters, limit overflow and child READY', () => {
  for (const mutate of [p => delete p.inboundAuthMode, p => p.inboundAuthMode = 'api_key', p => p.inboundAuthMode = 'unknown', p => p.secret = 'fixture', p => p.version = 2, p => p.openApiData = null, p => p.registrySource.path = 'relative.json',
    p => p.openApiData = { text: 'x'.repeat(wire.MANAGED_HANDOFF_LIMITS.bytes) },
    p => p.trustedOperationBindings = new Array(10001).fill({ method: 'GET', path: '/', endpointDefinitionId: 'e', sourceServiceAssetId: 's' })]) {
    const p = payload(); mutate(p); assert.throws(() => wire.captureManagedHandoff(p), /INVALID_MANAGED_HANDOFF/);
  }
  const captured = wire.captureManagedHandoff(payload()); assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.registrySource));
  const p = payload(); Object.defineProperty(p, 'openApiData', { enumerable: true, get() { throw Error('getter-secret'); } });
  assert.throws(() => wire.captureManagedHandoff(p), /^ManagedChannelError: INVALID_MANAGED_HANDOFF$/);
  assert.throws(() => wire.parseManagedChildMessage({ type: 'runtimeReady', launchId: 'launch-fixture' }, 'launch-fixture'), /INVALID_MANAGED_HANDOFF/);
});

test('missing IPC exits fixed and never starts CLI or a business listener', async () => {
  const child = spawn(process.execPath, [entry], { env: buildManagedEnvironment([], {}), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const [code] = await once(child, 'close'); assert.equal(code, 1); assert.equal(output, 'MANAGED_IPC_REQUIRED\n');
});

async function direct(messages, disconnect = false) {
  const child = spawn(process.execPath, [entry], { env: buildManagedEnvironment([], {}), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const replies = []; let output = '';
  child.on('message', value => replies.push(value)); child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const done = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  for (const message of messages) child.send(message, () => undefined);
  if (disconnect) child.disconnect();
  const [code] = await done; clearTimeout(deadline);
  child.stdout.destroy(); child.stderr.destroy();
  return { code, replies, output };
}
test('real child rejects malformed handoff, wrong ID and unknown fields without raw error details', async () => {
  for (const message of [{ type: 'handoff', version: 2, launchId: 'launch-fixture', payload: payload() },
    { type: 'handoff', version: 1, launchId: 'wrong', payload: payload() },
    { type: 'handoff', version: 1, launchId: 'launch-fixture', payload: payload(), secret: 'synthetic-hidden' }]) {
    const result = await direct([message]); assert.equal(result.code, 1);
    assert.equal(result.replies[0].code, 'INVALID_MANAGED_HANDOFF'); assert.equal(result.output, '');
    assert.ok(!JSON.stringify(result).includes('synthetic-hidden'));
  }
});
test('actual child handles duplicate handoff and parent disconnect with bounded exit', async () => {
  const message = { type: 'handoff', version: 1, launchId: 'launch-fixture', payload: payload() };
  const duplicate = await direct([message, message]);
  assert.equal(duplicate.code, 1); assert.ok(duplicate.replies.some(x => x.type === 'failed'));
  const disconnected = await direct([], true);
  assert.equal(disconnected.code, 0);
});

test('parent rejects identity mismatch before spawn without inspecting a registry file', async () => {
  const request = input(); request.serverId = 'wrong';
  await assert.rejects(startManagedMcpChannel(request), /INVALID_MANAGED_HANDOFF/);
  assert.equal(fs.existsSync(payload().registrySource.path), false);
});


// Isolate timer/spawn doubles in a VM; never replace the real test runner clock.
function sandbox() {
  const timers = new Set(), launches = [];
  const stream = () => ({ resume() {}, end() {}, destroy() {} });
  const child = new EventEmitter(); Object.assign(child, { pid: 999999, connected: true,
    stdout: stream(), stderr: stream(), stdin: stream(), send(_value, callback) { callback?.(); },
    kill() { child.emit('exit', null, 'SIGKILL'); return true; } });
  const localRequire = name => name === 'api-nova-server' ? { ...wire,
    // VM object literals have different prototypes; normalize the simulated IPC realm.
    parseManagedParentMessage: value => wire.parseManagedParentMessage(JSON.parse(JSON.stringify(value))),
  } : name === 'node:child_process' ? {
    spawn(binary, args, options) { launches.push({ binary, args, options }); return child; },
  } : require(name);
  localRequire.resolve = () => entry;
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(channelPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  require('node:vm').runInNewContext(code, { exports, require: localRequire, process: { execPath: process.execPath, platform: process.platform, env: {} },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); } });
  return { api: exports, child, timers, launches, fire(ms) { const timer = [...timers].find(t => t.ms === ms); assert.ok(timer, `missing ${ms} deadline`); timer.fn(); } };
}
test('bounded parent handshake uses exact spawn flags and cleans listeners after forced exit', async () => {
  const f = sandbox(); const waiting = f.api.startManagedMcpChannel(input());
  const rejection = assert.rejects(waiting, /MANAGED_HANDSHAKE_TIMEOUT/);
  assert.equal(f.launches[0].options.shell, false); assert.deepEqual(Array.from(f.launches[0].options.stdio), ['pipe', 'pipe', 'pipe', 'ipc']);
  assert.deepEqual(Array.from(f.launches[0].args), [entry]);
  f.fire(30000); f.fire(5000); await rejection;
  assert.equal(f.timers.size, 0); assert.equal(f.child.eventNames().length, 0);
});
test('ACK followed by IPC disconnect cannot leave an accepted handle alive indefinitely', async () => {
  const f = sandbox(); const waiting = f.api.startManagedMcpChannel(input());
  f.child.emit('message', { type: 'handoffAccepted', launchId: 'launch-fixture' });
  const handle = await waiting;
  f.child.connected = false; f.child.emit('disconnect'); f.fire(5000);
  assert.equal((await handle.closed).code, 'MANAGED_CHANNEL_FAILED');
  const first = handle.close(), second = handle.close(); assert.equal(first, second); await first;
  assert.equal(f.timers.size, 0); assert.equal(f.child.eventNames().length, 0);
});
test('unknown READY, mismatched launch and duplicate ACK fail closed rather than mark RUNNING', async () => {
  for (const message of [{ type: 'runtimeReady', launchId: 'launch-fixture' }, { type: 'handoffAccepted', launchId: 'wrong' }]) {
    const f = sandbox(); const waiting = f.api.startManagedMcpChannel(input());
    const rejected = assert.rejects(waiting, /INVALID_MANAGED_HANDOFF/);
    f.child.emit('message', message); f.fire(5000); await rejected;
  }
  const f = sandbox(); const waiting = f.api.startManagedMcpChannel(input());
  const ack = { type: 'handoffAccepted', launchId: 'launch-fixture' };
  f.child.emit('message', ack); const handle = await waiting; f.child.emit('message', ack); f.fire(5000);
  assert.equal((await handle.closed).code, 'INVALID_MANAGED_HANDOFF');
});const readyMessage = () => ({ type:'runtimeReady',launchId:'launch-fixture',nonSecretRevisions:{candidateRevision:'candidate-fixture',verificationRunId:'verification-fixture',behaviorFingerprint:'a'.repeat(64),registryRevision:'r1',registryContentDigest:'b'.repeat(64),authMode:'api_key',credentialMode:'single-hop'} });
test('READY must follow ACK, match captured revisions, and occur only once',async()=>{
 for(const defect of ['before-ack','revision','extra-secret','duplicate']){
  const f=sandbox(),waiting=f.api.startManagedMcpChannel(input());
  if(defect==='before-ack'){
   const rejected=assert.rejects(waiting,/INVALID_MANAGED_HANDOFF/);f.child.emit('message',readyMessage());f.fire(5000);await rejected;continue;
  }
  f.child.emit('message',{type:'handoffAccepted',launchId:'launch-fixture'});const handle=await waiting;
  const message=readyMessage();if(defect==='revision')message.nonSecretRevisions.registryRevision='other';if(defect==='extra-secret')message.nonSecretRevisions.secret='synthetic-only';
  f.child.emit('message',message);
  if(defect==='duplicate'){await handle.ready;assert.equal(handle.state,'runtimeReady');assert.equal([...f.timers].some(t=>t.ms===30000),false);f.child.emit('message',message);}
  f.fire(5000);assert.equal((await handle.closed).code,'INVALID_MANAGED_HANDOFF');
 }
});
test('READY digest fields reject regex-coercible arrays rather than accepting non-string revisions',()=>{
 const message=readyMessage();message.nonSecretRevisions.behaviorFingerprint=['a'.repeat(64)];
 assert.throws(()=>wire.parseManagedChildMessage(message,'launch-fixture'),/INVALID_MANAGED_HANDOFF/);
});

test('parent rejects a valid API-key READY when captured persistent mode differs',async()=>{
 for(const mode of ['private_jwt','anonymous']){
  const f=sandbox(),request=input();request.payload.inboundAuthMode=mode;
  const waiting=f.api.startManagedMcpChannel(request);
  f.child.emit('message',{type:'handoffAccepted',launchId:'launch-fixture'});const handle=await waiting;
  f.child.emit('message',readyMessage());f.fire(5000);
  await assert.rejects(handle.ready,/INVALID_MANAGED_HANDOFF/);assert.equal((await handle.closed).code,'INVALID_MANAGED_HANDOFF');
 }
});

test('real child rejects old and unknown persisted-mode envelopes before ACK',async()=>{
 for(const mode of [undefined,'unknown','api_key']){
  const p=payload();if(mode===undefined)delete p.inboundAuthMode;else p.inboundAuthMode=mode;
  const result=await direct([{type:'handoff',version:1,launchId:p.launchId,payload:p}]);
  assert.equal(result.code,1);assert.equal(result.replies[0].code,'INVALID_MANAGED_HANDOFF');
  assert.ok(!result.replies.some(message=>message.type==='handoffAccepted'||message.type==='runtimeReady'));
  assert.equal(result.output,'');
 }
});
