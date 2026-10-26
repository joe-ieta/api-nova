'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Keep offsets stable: release export edits the original source at link positions.
const stripCode = text => text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm,
  block => block.replace(/[^\r\n]/g, ' '));
function links(text) {
  const clean = stripCode(text);
  return [...clean.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g)]
    .map(match => ({ raw: match[1], target: match[1].replace(/^<|>$/g, ''), index: match.index,
      targetIndex: match.index + match[0].indexOf('](') + 2 }));
}
function anchors(text) {
  const clean = stripCode(text);
  const ids = new Set([...clean.matchAll(/<(?:a|[a-z]\w*)\s+[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)].map(match => match[1]));
  const counts = new Map();
  for (const match of clean.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const title = match[1].replace(/<[^>]+>/g, '').toLowerCase();
    const slug = title.replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    ids.add(slug + (count ? `-${count}` : ''));
  }
  return ids;
}
function localTarget(file, target, base = root) {
  if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const [location, fragment] = target.split('#', 2);
  const relative = decodeURIComponent(location.split('?')[0]);
  const absolute = relative ? path.resolve(path.dirname(path.join(base, file)), relative) : path.join(base, file);
  return { absolute, fragment: fragment ? decodeURIComponent(fragment) : '' };
}
function checkLinks(files, base = root) {
  const failures = [];
  let linkCount = 0;
  let anchorCount = 0;
  const cachedAnchors = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(base, file), 'utf8');
    for (const link of links(text)) {
      const resolved = localTarget(file, link.target, base);
      if (!resolved) continue;
      linkCount++;
      if (!fs.existsSync(resolved.absolute)) { failures.push({ file, target: link.target, reason: 'missing file' }); continue; }
      if (resolved.fragment && path.extname(resolved.absolute).toLowerCase() === '.md') {
        anchorCount++;
        if (!cachedAnchors.has(resolved.absolute)) cachedAnchors.set(resolved.absolute, anchors(fs.readFileSync(resolved.absolute, 'utf8')));
        if (!cachedAnchors.get(resolved.absolute).has(resolved.fragment)) failures.push({ file, target: link.target, reason: 'missing anchor' });
      }
    }
  }
  return { linkCount, anchorCount, failures };
}
function filesInRepository() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Cannot enumerate repository documentation');
  return [...new Set(result.stdout.trim().split(/\r?\n/))].filter(file =>
    (file.startsWith('docs/') || /^README(?:_EN)?\.md$/.test(file) || file === 'RELEASE_STANDARD.md'
      || file.startsWith('packages/') || file === 'vendor/README.md')
    && !/(?:^|\/)(?:node_modules|dist|\.tmp)\//.test(file)
    && fs.existsSync(path.join(root, file))).sort();
}
const tableRows = text => text.split(/\r?\n/).filter(line => line.startsWith('|')).map(line => line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
function taskContracts() {
  const ledger = tableRows(fs.readFileSync(path.join(root, 'docs/guides/active-work-package-execution-status.md'), 'utf8'));
  const states = new Set(['DONE', 'IN_PROGRESS', 'WAIT_DEP', 'DEFERRED', 'READY', 'NEED_ENV', 'SCOPE_REVIEW']);
  const tasks = new Map(ledger.filter(row => row.length === 3 && states.has(row[1]) && /^[A-Z][\w-]+$/.test(row[0])).map(row => [row[0], row[1]]));
  const contracts = tableRows(fs.readFileSync(path.join(root, 'docs/guides/active-work-package-breakdown.md'), 'utf8')).filter(row => row.length === 6 && tasks.has(row[0]));
  if (!tasks.size || contracts.length !== tasks.size) throw new Error('Task/contract identity mismatch');
  const dependencies = new Map(contracts.map(row => [row[0], row[5] === '—' ? [] : row[5].split(';')]));
  const visited = new Set();
  function visit(id, stack) {
    if (stack.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const next = new Set([...stack, id]);
    for (const dependency of dependencies.get(id)) {
      if (!dependencies.has(dependency)) throw new Error(`Missing dependency: ${dependency}`);
      if (tasks.get(id) === 'DONE' && tasks.get(dependency) !== 'DONE') throw new Error(`DONE depends on unfinished task: ${id}`);
      visit(dependency, next);
    }
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id, new Set());
  return { tasks: tasks.size, statuses: Object.fromEntries([...states].map(state => [state, [...tasks.values()].filter(value => value === state).length]).filter(([, count]) => count)), dependencies: [...dependencies.values()].reduce((sum, deps) => sum + deps.length, 0) };
}
function main() {
  const files = filesInRepository();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/documentation-manifest.json'), 'utf8'));
  const failures = [];
  const included = new Set(manifest.documents.map(entry => entry.path));
  for (const file of files.filter(file => !file.startsWith('docs/archive/'))) if (!included.has(file)) failures.push({ file, reason: 'not classified in manifest' });
  const versions = tableRows(fs.readFileSync(path.join(root, 'docs/VERSIONS.md'), 'utf8'));
  for (const entry of manifest.documents) {
    const file = path.join(root, entry.path);
    if (!fs.existsSync(file)) { failures.push({ file: entry.path, reason: 'manifest target missing' }); continue; }
    if (entry.kind !== 'active') continue;
    const text = fs.readFileSync(file, 'utf8');
    const version = text.match(/^doc-version:\s*(\S+)/m)?.[1];
    const status = text.match(/^doc-status:\s*(\S+)/m)?.[1];
    const updated = text.match(/^doc-updated:\s*(\S+)/m)?.[1];
    const row = versions.find(row => row[0].includes(`](${entry.catalogLink})`));
    if (!version || status !== 'active' || version !== entry.version || updated !== entry.updated
      || !row || row[1] !== entry.version || row[2] !== 'active' || row[3] !== entry.updated) failures.push({ file: entry.path, reason: 'metadata/catalog mismatch' });
  }
  const references = checkLinks(files);
  failures.push(...references.failures);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'docs/api/openapi.json'), 'utf8'));
  const operationIds = new Set();
  for (const item of Object.values(snapshot.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      if (!operation.operationId || operationIds.has(operation.operationId)) failures.push({ reason: 'duplicate/missing OpenAPI operationId', operation: operation.operationId });
      operationIds.add(operation.operationId);
      for (const security of operation.security || []) for (const name of Object.keys(security)) {
        if (!snapshot.components?.securitySchemes?.[name]) failures.push({ reason: 'unknown OpenAPI security scheme', name });
      }
    }
  }
  function inspectRefs(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref?.startsWith('#/')) {
      const resolved = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], snapshot);
      if (resolved === undefined) failures.push({ reason: 'unresolved OpenAPI reference', reference: value.$ref });
    }
    Object.values(value).forEach(inspectRefs);
  }
  inspectRefs(snapshot);
  const summary = { documents: files.length, currentManifestEntries: manifest.documents.length,
    localLinks: references.linkCount, anchors: references.anchorCount, apiOperations: operationIds.size, ...taskContracts(), failures };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
}
module.exports = { root, stripCode, links, anchors, localTarget, checkLinks, filesInRepository };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
