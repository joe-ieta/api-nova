'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'docs/guides', file), 'utf8');
const rows = text => text.split(/\r?\n/).filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const old = rows(read('active-work-package-execution-status.md')).filter(row => /^(GOV|SEC|OBS|PROD|EXT|ENV|OPS|MAIL|MAINT|DEFER)-/.test(row[0]));
const packs = rows(read('unified-work-packages.md')).filter(row => /^NP-\d+$/.test(row[0]));
const status = rows(read('unified-development-status.md')).filter(row => /^NP-\d+$/.test(row[0]));
const children = rows(read('unified-work-packages.md')).filter(row => /^NP-\d+\.\d+$/.test(row[0]));
const childStatus = rows(read('unified-development-status.md')).filter(row => /^NP-\d+\.\d+$/.test(row[0]));
const list = value => value === '—' ? [] : value.split(',').map(item => item.trim());
assert.equal(old.length, 209, 'Frozen migration baseline changed');
assert.equal(new Set(old.map(row => row[0])).size, old.length, 'Duplicate legacy ID');
assert.equal(old.filter(row => row[1] === 'DONE').length, 150);
const byId = new Map(packs.map(row => [row[0], row]));
assert.equal(byId.size, packs.length, 'Duplicate package');
assert.equal(new Set(status.map(row => row[0])).size, status.length, 'Duplicate status');
assert.deepEqual([...byId.keys()].sort(), status.map(row => row[0]).sort(), 'Package/status mismatch');
const assigned = new Map();
for (const row of packs) {
  for (const id of list(row[4])) {
    assert(!assigned.has(id), `Duplicate assignment: ${id}`);
    assert(old.some(entry => entry[0] === id && entry[1] !== 'DONE'), `Unknown/completed legacy task: ${id}`);
    assigned.set(id, row[0]);
  }
}
for (const row of old) if (row[1] !== 'DONE') assert(assigned.has(row[0]), `Unmapped: ${row[0]}`);
const visited = new Set(), visiting = new Set();
function visit(id) {
  assert(byId.has(id), `Unknown dependency: ${id}`);
  assert(!visiting.has(id), `Dependency cycle: ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of list(byId.get(id)[3])) visit(dependency);
  visiting.delete(id); visited.add(id);
}
for (const id of byId.keys()) visit(id);
const allowed = new Set(['DONE', 'READY', 'IN_PROGRESS', 'WAIT_DEP', 'NEED_ENV', 'NEED_APPROVAL', 'DEFERRED', 'SCOPE_REVIEW']);
const stateById = new Map(status.map(row => [row[0], row[1]]));
for (const row of status) {
  assert(allowed.has(row[1]), `Unknown status: ${row[0]}`);
  if (['DONE', 'READY', 'IN_PROGRESS'].includes(row[1])) {
    for (const dependency of list(byId.get(row[0])[3])) {
      assert.equal(stateById.get(dependency), 'DONE', `${row[0]} has unfinished dependency ${dependency}`);
    }
  }
}
const childById = new Map(children.map(row => [row[0], row]));
assert.equal(childById.size, children.length, 'Duplicate child task');
assert.equal(new Set(childStatus.map(row => row[0])).size, childStatus.length, 'Duplicate child status');
assert.deepEqual([...childById.keys()].sort(), childStatus.map(row => row[0]).sort(), 'Child/status mismatch');
const allStates = new Map([...stateById, ...childStatus.map(row => [row[0], row[1]])]);
const allDeps = new Map([...packs.map(row => [row[0], list(row[3])]), ...children.map(row => [row[0], list(row[3])])]);
const childVisited = new Set(), childVisiting = new Set();
function visitChild(id) {
  assert(allDeps.has(id), `Unknown child dependency: ${id}`);
  assert(!childVisiting.has(id), `Child dependency cycle: ${id}`);
  if (childVisited.has(id)) return;
  childVisiting.add(id);
  for (const dependency of allDeps.get(id)) visitChild(dependency);
  childVisiting.delete(id); childVisited.add(id);
}
for (const row of children) {
  assert(byId.has(row[1]) && row[0].split('.')[0] === row[1], `Invalid child owner: ${row[0]}`);
  visitChild(row[0]);
  const state = allStates.get(row[0]);
  assert(allowed.has(state), `Unknown child status: ${row[0]}`);
  if (['DONE', 'READY', 'IN_PROGRESS'].includes(state)) {
    for (const dependency of list(row[3]))
      assert.equal(allStates.get(dependency), 'DONE', `${row[0]} has unfinished dependency ${dependency}`);
  }
  if (stateById.get(row[1]) === 'DONE')
    assert.equal(state, 'DONE', `${row[1]} contains unfinished child ${row[0]}`);
}
console.log(JSON.stringify({ legacy: old.length, inheritedDone: 150, migrated: assigned.size, packages: packs.length,
  childTasks: children.length, dependencyGraph: 'acyclic', status: 'PASS' }, null, 2));
