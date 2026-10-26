'use strict';

// Reproducible, dependency-free backport of Nest commit
// 0f962c75a474b08fbc1bdf072b89eda14151c856 (MIT).
// Input: npm pack @nestjs/core@10.4.22 --pack-destination <directory>
// Usage: node scripts/build-nest-sse-backport.cjs <upstream.tgz> [output.tgz]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const UPSTREAM_INTEGRITY = 'sha512-6IX9+VwjiKtCjx+mXVPncpkQ5ZjKfmssOZPFexmT+6T9H9wZ3svpYACAo7+9e7Nr9DZSoRZw3pffkJP7Z0UjaA==';
const ORIGINAL_FILE_SHA256 = '157ba6f0a1949a441c91e122188c1c168189c0863ba56289280b6b1fd1f64fac';
const TARGET = 'package/router/sse-stream.js';
const OLD_LINES = [
  "        let data = message.type ? `event: ${message.type}\\n` : '';",
  "        data += message.id ? `id: ${message.id}\\n` : '';",
  "        data += message.retry ? `retry: ${message.retry}\\n` : '';",
].join('\n');
const NEW_LINES = [
  "        const sanitize = (val) => String(val).replace(/[\\r\\n]/g, '');",
  "        let data = message.type ? `event: ${sanitize(message.type)}\\n` : '';",
  "        data += message.id ? `id: ${sanitize(message.id)}\\n` : '';",
  "        data += message.retry ? `retry: ${sanitize(message.retry)}\\n` : '';",
].join('\n');
function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}
function buildBackport(input) {
  assert.equal(`sha512-${digest(input, 'sha512', 'base64')}`, UPSTREAM_INTEGRITY, 'Unexpected upstream archive; do not patch an unreviewed version');
  const tar = zlib.gunzipSync(input);
  const chunks = [];
  let offset = 0;
  let replacements = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ''), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid upstream tar entry');
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (name === TARGET) {
      assert(header[156] === 48 || header[156] === 0, 'Target is not a regular file');
      const original = tar.subarray(offset + 512, offset + 512 + size);
      assert.equal(digest(original), ORIGINAL_FILE_SHA256, 'Unexpected SSE source');
      assert.equal(original.toString().split(OLD_LINES).length, 2, 'Patch must match once');
      const patched = Buffer.from(original.toString().replace(OLD_LINES, NEW_LINES));
      const nextHeader = Buffer.from(header);
      nextHeader.write(patched.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      nextHeader.fill(32, 148, 156);
      const checksum = nextHeader.reduce((sum, byte) => sum + byte, 0);
      nextHeader.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      chunks.push(nextHeader, patched, Buffer.alloc((512 - patched.length % 512) % 512));
      replacements++;
    } else {
      chunks.push(tar.subarray(offset, end));
    }
    offset = end;
  }
  assert.equal(replacements, 1, 'Expected one SSE module');
  chunks.push(tar.subarray(offset));
  // Tar entry order, timestamps, permissions and all other contents are preserved.
  // The gzip header is deterministic (no timestamp or filename); compression is fixed.
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}
if (require.main === module) {
  assert(process.argv[2], 'Provide the npm @nestjs/core@10.4.22 archive');
  const output = path.resolve(process.argv[3] || 'vendor/nestjs-core-10.4.22-apinova-sse.1.tgz');
  const bytes = buildBackport(fs.readFileSync(process.argv[2]));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  console.log(JSON.stringify({ output, sha256: digest(bytes), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` }));
}
module.exports = { buildBackport, UPSTREAM_INTEGRITY, ORIGINAL_FILE_SHA256 };
