'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {ref} = require('vue');

function manager() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/modules/endpoint-registry/EndpointRegistry.vue'), 'utf8');
  const start = source.indexOf('const selectedInstanceSourceAssetId =');
  const end = source.indexOf('const effectiveSelectedGovernanceGroupKey =', start);
  assert.ok(start > 0 && end > start);
  const warnings = [];
  const context = {ref, showInstanceManager: ref(false), ElMessage: {warning: message => warnings.push(message)}};
  vm.runInNewContext(ts.transpileModule(source.slice(start, end) + '\nglobalThis.manager = {open: openInstanceManager, sourceId: selectedInstanceSourceAssetId, name: selectedInstanceSourceName};',
    {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText, context);
  return {...context.manager, visible: context.showInstanceManager, warnings};
}

test('clicking endpoints from different sources sharing a URL selects each actual source', () => {
  const m = manager();
  const first = {sourceServiceAssetId: 'source-a', groupName: 'Imported A', name: 'A', baseUrl: 'http://localhost:9001'};
  const second = {...first, sourceServiceAssetId: 'source-b', groupName: 'Imported B', name: 'B'};
  m.open(first);
  assert.equal(m.sourceId.value, 'source-a');
  assert.equal(m.name.value, 'Imported A');
  assert.equal(m.visible.value, true);
  m.visible.value = false;
  m.open(second);
  assert.equal(m.sourceId.value, 'source-b');
  assert.equal(m.name.value, 'Imported B');
  assert.equal(m.visible.value, true);
  // List refreshes or edits cannot silently retarget an already-open dialog.
  second.sourceServiceAssetId = 'source-c';
  assert.equal(m.sourceId.value, 'source-b');
  assert.equal(m.warnings.length, 0);
});

test('missing source identity refuses to reopen a previously used instance dialog', () => {
  const m = manager();
  m.open({sourceServiceAssetId: 'source-a', name: 'Manual A'});
  assert.equal(m.name.value, 'Manual A');
  m.visible.value = false;
  for (const row of [undefined, {}, {sourceServiceAssetId: '', name: 'Unknown'}]) {
    m.open(row);
    assert.equal(m.visible.value, false);
  }
  assert.equal(m.warnings.length, 3);
});
