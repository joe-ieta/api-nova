'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const input = path.resolve(process.argv[2] || '.tmp/file-type-node20/file-type-21.3.4.tgz');
const npmCli = process.argv[3] || process.env.npm_execpath;
assert(npmCli && fs.existsSync(npmCli), 'Pass the npm CLI path');
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const integrity = 'sha512-Ievi/yy8DS3ygGvT47PjSfdFoX+2isQueoYP1cntFW1JLYAuS4GD7NUPGg4zv2iZfV52uDyk5w5Z0TdpRS6Q1g==';
assert.equal('sha512-' + digest(fs.readFileSync(input), 'sha512', 'base64'), integrity);
const work = fs.mkdtempSync(path.join(root, '.tmp/file-type-node20/build-'));
cp.execFileSync('tar', ['-xf', input, '-C', work]);
const pkg = path.join(work, 'package');
const file = path.join(pkg, 'core.js');
const original = fs.readFileSync(file, 'utf8');
const marker = 'async function decompressDeflateRawWithLimit(data, {maximumLength = maximumZipEntrySizeInBytes} = {}) {';
assert.equal(original.split(marker).length, 2);
const fallback = `
\tlet decompressor;
\ttry {
\t\tdecompressor = new DecompressionStream('deflate-raw');
\t} catch (error) {
\t\tif (!globalThis.process?.versions?.node || error.code !== 'ERR_INVALID_ARG_VALUE') {
\t\t\tthrow error;
\t\t}
\t\t// Node20 lacks this Web format. Keep the same bound using native zlib;
\t\t// never inflate the complete untrusted payload and truncate afterwards.
\t\tconst nodeZlib = 'node:zlib';
\t\tconst {inflateRaw} = await import(nodeZlib);
\t\treturn new Promise((resolve, reject) => {
\t\t\tinflateRaw(data, {maxOutputLength: maximumLength, info: true}, (inflateError, result) => {
\t\t\t\tif (inflateError?.code === 'ERR_BUFFER_TOO_LARGE') {
\t\t\t\t\treject(new Error(\`ZIP entry decompressed data exceeds \${maximumLength} bytes\`));
\t\t\t\t} else if (inflateError) {
\t\t\t\t\treject(inflateError);
\t\t\t\t} else if (result.engine.bytesWritten !== data.byteLength) {
\t\t\t\t\t// Do not silently accept junk or a second stream after the first.
\t\t\t\t\t// This must remain non-recoverable even for generic ZIP policies.
\t\t\t\t\treject(Object.assign(new Error('Trailing junk after ZIP compressed stream'), {code: 'ERR_TRAILING_JUNK_AFTER_STREAM'}));
\t\t\t\t} else {
\t\t\t\t\tresolve(result.buffer);
\t\t\t\t}
\t\t\t});
\t\t});
\t}
`;
const patched = original.replace(marker, marker + fallback)
  .replace("input.pipeThrough(new DecompressionStream('deflate-raw'))", 'input.pipeThrough(decompressor)');
assert.notEqual(patched, original);
assert(patched.includes('maxOutputLength: maximumLength'));
fs.writeFileSync(file, patched);
const metadataFile = path.join(pkg, 'package.json');
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
assert.equal(metadata.version, '21.3.4'); assert.equal(metadata.engines.node, '>=20');
metadata.apiNovaNode20Compatibility = { revision: 1, scope: 'bounded deflate-raw fallback; original security limits retained' };
fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
const packed = JSON.parse(cp.execFileSync(process.execPath, [npmCli, 'pack', pkg, '--ignore-scripts', '--json', '--pack-destination', work], { encoding: 'utf8' }))[0];
const archive = 'file-type-21.3.4-apinova-node20.1.tgz';
fs.copyFileSync(path.join(work, packed.filename), path.join(__dirname, archive));
const provenance = { patch: 'apinova-file-type-node20.1', source: 'https://registry.npmjs.org/file-type/-/file-type-21.3.4.tgz',
  upstreamIntegrity: integrity, upstreamCoreSha256: digest(original), patchedCoreSha256: digest(patched),
  archive: 'vendor/file-type-node20/' + archive, archiveSha256: digest(fs.readFileSync(path.join(__dirname, archive))), archiveIntegrity: packed.integrity,
  version: metadata.version, nodeEngineUnchanged: metadata.engines.node,
  scope: 'Only core.js bounded Node20 fallback and package provenance metadata changed; native Web decompression remains preferred.' };
fs.writeFileSync(path.join(__dirname, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance));
