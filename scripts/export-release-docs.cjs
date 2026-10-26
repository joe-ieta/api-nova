'use strict';

// Assemble a concise offline documentation set. Historical/source references are
// pinned to this exact source commit rather than copied as a second manual set.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { root, links, localTarget, checkLinks } = require('./verify-docs.cjs');
const at = process.argv.indexOf('--output-dir');
if (at < 0 || !process.argv[at + 1]) throw new Error('Usage: node scripts/export-release-docs.cjs --output-dir <new-package-or-preview-directory>');
const output = path.resolve(process.argv[at + 1]);
if (output === root || output === path.parse(output).root) throw new Error('Output must be a separate new documentation/package directory');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/documentation-manifest.json'), 'utf8'));
const selected = manifest.documents.filter(entry => entry.kind !== 'template' && entry.kind !== 'package-history');
const mapping = new Map(selected.map(entry => [entry.path, entry.path === 'README.md' ? 'README_PROJECT.md' : entry.path]));
mapping.set('docs/documentation-manifest.json', 'docs/documentation-manifest.json');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (revision.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(revision.stdout)) throw new Error('Source revision unavailable');
const commit = revision.stdout.trim();
const pending = [];
for (const [source, destination] of mapping) {
  const target = path.join(output, destination);
  if (fs.existsSync(target)) throw new Error(`Documentation output exists: ${destination}`);
  let content = fs.readFileSync(path.join(root, source), 'utf8');
  if (source.endsWith('.md')) {
    for (const link of links(content).reverse()) {
      const resolved = localTarget(source, link.target);
      if (!resolved) continue;
      const relative = path.relative(root, resolved.absolute).replace(/\\/g, '/');
      const mapped = mapping.get(relative);
      const suffix = resolved.fragment ? '#' + resolved.fragment : '';
      const replacement = mapped
        ? path.relative(path.dirname(destination), mapped).replace(/\\/g, '/') + suffix
        : `https://github.com/joe-ieta/api-nova/${fs.existsSync(resolved.absolute) && fs.statSync(resolved.absolute).isDirectory() ? 'tree' : 'blob'}/${commit}/${relative}${suffix}`;
      // Replace only this link target, preserving labels and intentional text.
      const start = link.targetIndex;
      content = content.slice(0, start) + replacement + content.slice(start + link.raw.length);
    }
  }
  pending.push({ source, destination, content });
}
// All destinations are checked before any write. Existing runtime files remain untouched.
for (const entry of pending) {
  const target = path.join(output, entry.destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, entry.content);
}
const checked = checkLinks(pending.filter(entry => entry.destination.endsWith('.md')).map(entry => entry.destination), output);
if (checked.failures.length) throw new Error(JSON.stringify(checked.failures));
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (status.status !== 0) throw new Error('Cannot inspect source checkout state');
const record = { schemaVersion: 1, sourceCommit: commit, trackedWorkingTreeClean: !status.stdout.trim(),
  sourceWorkingTree: 'Use only a clean committed checkout for a release; previews may be dirty.',
  documents: pending.map(entry => ({ source: entry.source, path: entry.destination,
    sha256: crypto.createHash('sha256').update(entry.content).digest('hex') })),
  verification: { localLinks: checked.linkCount, anchors: checked.anchorCount, failures: [] },
  onlineReferences: 'Archive, templates and source-code links are pinned to sourceCommit; current manuals and OpenAPI snapshot are local.' };
fs.writeFileSync(path.join(output, 'DOCUMENTATION_MANIFEST.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ documents: pending.length, ...record.verification }));
