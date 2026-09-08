const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SessionManager } = require('../dist/interactive-cli/managers/session-manager');
const { normalizeOperationFilter, assertStructuredHeaders } = require('../dist/utils/validation');
const { parseCustomHeaders } = require('../dist/cli/headers');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'api-nova-persistence-'));
  try {
    const manager = new SessionManager(directory);
    const input = { name: 'smoke', openApiUrl: 'https://example.invalid/openapi.json',
      transport: 'streamable', customHeaders: { static: { 'X-Smoke': 'yes' } } };
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      manager.saveSession({ ...input, name: input.name + index })));
    assert.equal((await manager.getAllSessions()).length, 8);
    const restored = new SessionManager(directory);
    assert.equal((await restored.getAllSessions()).length, 8);
    await restored.updateSession(results[0].id, { ...results[0], description: 'updated' });
    assert.equal((await restored.getSession(results[0].id)).description, 'updated');
    const filename = path.join(directory, 'sessions.json');
    const content = await fs.readFile(filename, 'utf8');
    await assert.rejects(() => restored.saveSession({ ...input, customHeaders: { 'X-Old': 'unsupported' } }));
    assert.equal(await fs.readFile(filename, 'utf8'), content);
    await fs.writeFile(filename, '[{"broken":');
    await assert.rejects(() => new SessionManager(directory).initialize());
    assert.equal(await fs.readFile(filename, 'utf8'), '[{"broken":');
    await fs.writeFile(filename, JSON.stringify(results));
    await assert.rejects(() => new SessionManager(directory).initialize(), /Unsupported session file format/);
    for (const key of ['methods', 'paths', 'operationIds', 'statusCodes', 'parameters']) {
      assert.throws(() => normalizeOperationFilter({ [key]: [] }), /structured/);
    }
    assert.deepEqual(normalizeOperationFilter({ methods: { include: ['get'] }, tags: { include: ['a'] } }),
      { methods: { include: ['GET'] }, tags: { include: ['a'] } });
    assert.throws(() => assertStructuredHeaders({ 'X-Old': 'no' }), /structured/);
    assert.throws(() => parseCustomHeaders({ 'custom-header': ['X-Old:no'] }), /KEY=VALUE/);
    assert.deepEqual(parseCustomHeaders({ 'custom-header': ['X-New=yes'] }).static, { 'X-New': 'yes' });
    console.log('PERSISTENCE_SMOKE_OK: current format, concurrent writes, reload, corrupt-file protection, strict filters');
  } finally {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('api-nova-persistence-')) {
      throw new Error('Unsafe smoke cleanup directory');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
