'use strict';
// OBS-16-04 preparation: real retained delivery worker, TLS checked in both lanes.
// Reuse the existing OBS-16-03 synthetic receiver fixture without running its matrix.
// NODE_EXTRA_CA_CERTS is applied at child-process startup, never by disabling TLS.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixturePath = path.join(root, 'packages/api-nova-api/scripts/test-obs-16-03-receiver-matrix.cjs');
const source = fs.readFileSync(fixturePath, 'utf8');
const childCase = process.argv.find(arg => arg.startsWith('--tls-case='))?.slice('--tls-case='.length);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (childCase) {
  assert.ok(['absent', 'configured'].includes(childCase), 'known isolated TLS case');
  const boundary = source.indexOf('\nafter(() =>');
  assert.ok(boundary > source.indexOf('async function fixture('), 'receiver fixture boundary must precede matrix tests');
  const prefix = source.slice(0, boundary);
  assert.equal(/\ntest\(/.test(prefix), false, 'do not accidentally run the historical matrix');
  const testSource = `
  test('TLS trust ${childCase}: real worker retains certificate verification', async t => {
    const f = await fixture(t, { protocol: 'https' });
    const report = await f.worker.runOnce(1);
    const status = await f.status();
    if (${JSON.stringify(childCase)} === 'configured') {
      assert.equal(report.succeeded, 1);
      assert.equal(status.status, 'succeeded');
      assert.equal(f.calls.length, 1);
      const call = f.calls[0];
      const expected = 'sha256=' + createHmac('sha256', SECRET)
        .update(call.headers['x-apinova-timestamp'] + '.' + call.body).digest('hex');
      assert.equal(call.headers['x-apinova-signature'], expected);
      assert.equal(call.headers['x-apinova-event-id'], f.delivery.data.eventId);
      assert.equal(call.headers['x-apinova-delivery-id'], f.delivery.data.deliveryId);
      const attempt = await f.attempts.findOneByOrFail({ deliveryId: status.id });
      assert.equal(attempt.httpStatus, 202);
      assert.equal(attempt.errorCategory, null);
    } else {
      assert.equal(f.calls.length, 0);
      assert.equal(status.lastError.category, 'tls');
      assert.notEqual(status.status, 'succeeded');
    }
    console.log('OBS_16_04_TLS_CASE ' + JSON.stringify({
      trust: ${JSON.stringify(childCase)}, status: status.status,
      received: f.calls.length, category: status.lastError.category || null,
    }));
  });`;
  const fixtureModule = new Module(fixturePath, module);
  fixtureModule.filename = fixturePath;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath));
  fixtureModule._compile(prefix + testSource, fixturePath);
} else {
  const builtWorker = path.join(root, 'packages/api-nova-api/dist/src/modules/call-observability/call-observability-delivery.worker.js');
  assert.ok(fs.existsSync(builtWorker), 'build api-nova-api before running TLS trust verification');
  const certStart = source.indexOf('const TLS_CERT = [');
  const certTerminator = "].join('\\n');";
  const certEnd = source.indexOf(certTerminator, certStart);
  assert.ok(certStart >= 0 && certEnd > certStart, 'existing synthetic receiver certificate must be available');
  const cert = vm.runInNewContext(source.slice(certStart, certEnd + certTerminator.length) + '\nTLS_CERT');
  const tempRoot = path.join(root, '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const evidenceDir = fs.mkdtempSync(path.join(tempRoot, 'obs-16-04-tls-'));
  const certPath = path.join(evidenceDir, 'receiver-ca.pem');
  fs.writeFileSync(certPath, cert);
  const results = [];
  for (const trust of ['absent', 'configured']) {
    const env = { ...process.env };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete env.NODE_EXTRA_CA_CERTS;
    if (trust === 'configured') env.NODE_EXTRA_CA_CERTS = certPath;
    const started = Date.now();
    const run = spawnSync(process.execPath, [__filename, '--tls-case=' + trust], {
      cwd: root, env, encoding: 'utf8', timeout: 30000,
    });
    const logFile = path.join(evidenceDir, trust + '.log');
    fs.writeFileSync(logFile, (run.stdout || '') + (run.stderr || '') + (run.error ? String(run.error) : ''));
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    results.push({ trust, exitCode: run.status, durationMs: Date.now() - started, logFile,
      error: run.error?.code || null });
  }
  const passed = results.every(result => result.exitCode === 0 && result.error === null);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const manifest = {
    marker: passed ? 'OBS_16_04_TLS_TRUST_OK' : 'OBS_16_04_TLS_TRUST_FAILED',
    workPackage: 'OBS-16-04', executedAt: new Date().toISOString(),
    sourceCommit: revision.status === 0 ? revision.stdout.trim() : 'unknown',
    node: process.version, platform: process.platform, arch: process.arch,
    hashes: { runner: hash(__filename), fixture: hash(fixturePath), builtWorker: hash(builtWorker),
      sourceWorker: hash(path.join(root, 'packages/api-nova-api/src/modules/call-observability/call-observability-delivery.worker.ts')) },
    results, notCovered: ['target deployment and receiver', 'hostname mismatch matrix',
      'performance and sustained load', 'backup recovery', 'automatic outbox-to-receiver integrated delivery'],
  };
  fs.writeFileSync(path.join(evidenceDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(manifest.marker + ' ' + JSON.stringify({ evidenceDir, results }));
  process.exitCode = passed ? 0 : 1;
}
