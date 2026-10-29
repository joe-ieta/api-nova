'use strict';
// Fail before building a UI from a stale same-version registry installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

function verifyI18nBackport(root = path.resolve(__dirname, '../..')) {
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'vendor/i18n-node20/provenance.json'), 'utf8'));
  const resolved = createRequire(path.join(root, 'packages/api-nova-ui/package.json'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const directories = new Map();
  for (const archive of provenance.archives) {
    assert.equal(hash(path.join(root, archive.archive)), archive.sha256, 'Unreviewed I18n archive: ' + archive.package);
    const file = resolved.resolve(archive.package + '/package.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(metadata.version, archive.version);
    assert.equal(metadata.engines.node, provenance.nodeEngineUnchanged);
    assert.equal(metadata.apiNovaSecurityBackport?.revision, 1, 'Unpatched I18n installation: ' + archive.package);
    directories.set(archive.package, path.dirname(file));
  }
  for (const entry of provenance.files) {
    const archive = provenance.archives.find(value => path.basename(value.archive).startsWith(entry.package + '-apinova-'));
    assert(archive && entry.file.startsWith('dist/') && !entry.file.includes('..'), 'Invalid I18n provenance entry');
    assert.equal(hash(path.join(directories.get(archive.package), entry.file)), entry.patchedSha256, 'Unpatched I18n entry: ' + entry.file);
  }
  return { patch: provenance.localPatch, archives: provenance.archives.length, files: provenance.files.length };
}

if (require.main === module) console.log(JSON.stringify(verifyI18nBackport()));
module.exports = { verifyI18nBackport };
