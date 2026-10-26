'use strict';
// A same-version npm install may retain stale registry bytes. Verify the module
// actually resolved by the API before build/release/start; never patch at runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function verifyNestSseBackport(root, { archiveOnly = false } = {}) {
  root = path.resolve(root);
  const provenance = readJson(path.join(root, 'vendor/nestjs-core-sse-backport.json'));
  const archive = fs.readFileSync(path.join(root, provenance.archive));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const cores = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/@nestjs/core'));
  assert.equal(cores.length, 1, 'Expected one reviewed Nest core installation');
  assert.equal(cores[0][1].resolved, `file:${provenance.archive}`, 'Nest core must resolve to the reviewed local archive');
  assert.equal(cores[0][1].integrity, `sha512-${digest(archive, 'sha512', 'base64')}`, 'Archive differs from dependency lock');
  assert.equal(digest(archive), provenance.archiveSha256, 'Archive differs from reviewed provenance');
  if (!archiveOnly) {
    const apiRequire = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
    const file = apiRequire.resolve('@nestjs/core/router/sse-stream');
    assert.equal(digest(fs.readFileSync(file)), provenance.patchedFileSha256,
      'Installed Nest core is stale or modified. Run npm ci at the product root, then retry; npm install can retain same-version registry bytes.');
  }
  return { package: provenance.package, version: provenance.version, patch: provenance.localPatch, archiveOnly };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const root = args.find(arg => arg !== '--archive-only') || path.resolve(__dirname, '..');
  try {
    console.log(JSON.stringify(verifyNestSseBackport(root, { archiveOnly: args.includes('--archive-only') })));
  } catch (error) {
    console.error(`[ApiNova] Nest SSE dependency verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { verifyNestSseBackport };
