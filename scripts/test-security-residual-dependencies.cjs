'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { deflateRawSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const root = path.resolve(process.env.API_NOVA_SECURITY_CANDIDATE_ROOT || path.join(__dirname, '..'));
const apiRequire = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const serverRequire = createRequire(path.join(root, 'packages/api-nova-server/package.json'));
const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function consumer(name) { return createRequire(apiRequire.resolve(name)); }
async function fileTypeProbe() {
  const common = consumer('@nestjs/common');
  const directory = path.dirname(common.resolve('file-type/core'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version, '21.3.4');
  const { fileTypeFromBuffer } = await import(pathToFileURL(path.join(directory, 'core.js')).href);
  const { FileTypeValidator } = apiRequire('@nestjs/common');
  const valid = (type, buffer) => new FileTypeValidator({ fileType: type }).isValid({ mimetype: type, buffer });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
  assert.equal(await valid('image/png', png), true);
  assert.equal(await valid('image/png', Buffer.from('{}')), false);
  const asf = Buffer.alloc(55); Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex').copy(asf);
  assert.equal(await fileTypeFromBuffer(asf), undefined);
  assert.equal(await valid('video/x-ms-asf', asf), false);
  // Bounded regression fixture: lies about a 2 MiB XML entry's uncompressed size.
  // It exercises the inflate limit without generating the upstream 256 MiB sample.
  const xml = Buffer.from('<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>' + ' '.repeat(2 * 1024 * 1024));
  const name = Buffer.from('[Content_Types].xml'), compressed = deflateRawSync(xml), header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(512, 22); header.writeUInt16LE(name.length, 26);
  const zip = Buffer.concat([header, name, compressed]);
  assert.deepEqual(await fileTypeFromBuffer(zip), { ext: 'zip', mime: 'application/zip' });
  assert.equal(await valid('application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip), false);
  console.log('FILE_TYPE_PROBE_PASS');
}
if (process.argv[2] === '--file-type-probe') {
  fileTypeProbe().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  test('all actual UUID consumers resolve the patched CommonJS implementation', () => {
    for (const [label, req] of [['API', apiRequire], ['server', serverRequire],
      ['schedule', consumer('@nestjs/schedule')], ['Nest TypeORM', consumer('@nestjs/typeorm')],
      ['TypeORM', consumer('typeorm')]]) {
      assert.equal(req('uuid/package.json').version, '11.1.1', label);
      assert.match(req('uuid').v4(), v4, label);
    }
  });
  test('UUID namespace/time-based helpers reject out-of-bounds buffers without partial writes', () => {
    const uuid = apiRequire('uuid');
    for (const method of ['v3', 'v5', 'v6']) {
      const output = new Uint8Array(8).fill(170), before = output.slice();
      assert.throws(() => method === 'v6' ? uuid.v6({}, output, 4) : uuid[method]('x', uuid.v5.DNS, output, 4), RangeError);
      assert.deepEqual(output, before);
    }
  });
  test('Nest scheduler and TypeORM generate v4 identifiers using their real dependency chains', () => {
    const { SchedulerOrchestrator } = apiRequire('@nestjs/schedule/dist/scheduler.orchestrator');
    const scheduler = new SchedulerOrchestrator({});
    scheduler.addTimeout(() => {}, 100); scheduler.addInterval(() => {}, 100);
    scheduler.addCron(() => {}, { cronTime: '* * * * *', disabled: true });
    const ids = [...Object.keys(scheduler.timeouts), ...Object.keys(scheduler.intervals), ...Object.keys(scheduler.cronJobs)];
    assert.equal(new Set(ids).size, 3); ids.forEach(id => assert.match(id, v4));
    assert.match(apiRequire('@nestjs/typeorm/dist/common/typeorm.utils').generateString(), v4);
    // No onApplicationBootstrap: registration checks do not start timers or cron jobs.
  });
  test('real Nest file validator accepts valid content and bounds malicious ASF/ZIP detection', () => {
    // A process boundary also bounds regressions that block the event loop.
    const result = spawnSync(process.execPath, [__filename, '--file-type-probe'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, API_NOVA_SECURITY_CANDIDATE_ROOT: root }, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FILE_TYPE_PROBE_PASS/);
  });
}
