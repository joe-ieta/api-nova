import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpstreamCredentialRegistry, type CredentialHeaderHistoryStore } from 'api-nova-parser';
import { GatewayHeaderHistoryLedgerEntity as Ledger } from '../../../database/entities/gateway-header-history-ledger.entity';
import { GatewayHeaderHistoryLedgerService as Service } from '../../../database/gateway-header-history-ledger.service';

const namespace = 'gateway:acceptance', provenance = 'a'.repeat(64);
function deferred() { let resolve: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve: () => resolve() }; }
function candidate(name: string, revision = 'r1', watch = false): any { return {
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment: 'test' },
  reload: { mode: watch ? 'watch' : 'manual', debounceMs: 1000, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
  credentials: { key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'env:FIXTURE' } },
  sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' }, allowedHosts: ['fixture.invalid'], credential: 'key', endpoints: [] }],
}; }
function registry(store: CredentialHeaderHistoryStore, secret = async () => 'synthetic-only') {
  return new UpstreamCredentialRegistry({ environment: 'test', credentialHeaderHistory: { namespace, store },
    providerFactory: description => ({ type: description.type, resolve: secret }) });
}
class FailingHistoryMigration1790000010000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE failed_history_fixture (id integer)');
    await runner.query('UPDATE gateway_header_history_ledger SET "headerNames" = ?, revision = revision + 1', ['["x-corrupt-migration"]']);
    throw new Error('fixture migration failure');
  }
  async down(): Promise<void> { throw new Error('not reached'); }
}

describe('H07 durable history end-to-end concurrency and commit ordering', () => {
  let root: string, db: DataSource;
  const options = () => ({ type: 'sqljs' as const, location: join(root, 'history.sqlite'), autoSave: true, entities: [Ledger] });
  const ledger = () => new Service(db).asStore(namespace, provenance);
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'history-acceptance-')); db = await new DataSource({ ...options(), synchronize: true }).initialize(); });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); await rm(root, { recursive: true, force: true }); });
  it('serializes concurrent registries using the durable CAS union and restores all names after reopen', async () => {
    const left = registry(ledger()), right = registry(ledger());
    await Promise.all([left.reload(candidate('x-left')), right.reload(candidate('x-right'))]);
    expect(await ledger().load(namespace)).toEqual({ version: 2, names: ['x-left', 'x-right'] });
    await db.destroy(); db = await new DataSource(options()).initialize();
    const cold = registry(ledger()); await cold.reload(candidate('x-next'));
    expect(cold.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-left', 'x-right', 'x-next']));
  });
  it('stopping watch before durable commit leaves prior snapshot and ledger untouched', async () => {
    const entered = deferred(), release = deferred(); let blocked = false;
    const value = registry(ledger(), async () => { if (blocked) { entered.resolve(); await release.promise; } return 'synthetic-only'; });
    const file = join(root, 'watch.json'); await writeFile(file, JSON.stringify(candidate('x-old', 'r1', true))); await value.startWatchingFile(file, 'json');
    const previous = value.captureSnapshot(); const before = await ledger().load(namespace);
    blocked = true; await writeFile(file, JSON.stringify(candidate('x-pending', 'r2', true)));
    const attempt = value.reloadFile(file, 'json'); const rejection = expect(attempt).rejects.toMatchObject({ code: 'WATCH_STOPPED' });
    try { await entered.promise; value.stopWatching(); release.resolve(); await rejection;
      expect(value.captureSnapshot()).toBe(previous); expect(await ledger().load(namespace)).toEqual(before);
    } finally { release.resolve(); value.stopWatching(); await attempt.catch(() => {}); }
  });
  it('stopping watch after accepted durable CAS preserves that commit and then swaps without another await', async () => {
    const durable = deferred(), release = deferred(); let blocked = false; const real = ledger();
    const store: CredentialHeaderHistoryStore = { load: ns => real.load(ns), commit: async (...args) => {
      const result = await real.commit(...args); if (blocked) { durable.resolve(); await release.promise; } return result;
    } };
    const value = registry(store), file = join(root, 'watch.json'); await writeFile(file, JSON.stringify(candidate('x-old', 'r1', true))); await value.startWatchingFile(file, 'json');
    const previous = value.captureSnapshot(); blocked = true; await writeFile(file, JSON.stringify(candidate('x-accepted', 'r2', true)));
    const attempt = value.reloadFile(file, 'json');
    try { await durable.promise;
      expect(await real.load(namespace)).toEqual({ version: 2, names: ['x-accepted', 'x-old'] }); expect(value.captureSnapshot()).toBe(previous);
      value.stopWatching(); release.resolve(); await attempt;
      expect(value.captureSnapshot().candidate.metadata.revision).toBe('r2');
      await db.destroy(); db = await new DataSource(options()).initialize();
      expect(await ledger().load(namespace)).toEqual({ version: 2, names: ['x-accepted', 'x-old'] });
    } finally { release.resolve(); value.stopWatching(); await attempt.catch(() => {}); }
  });
  it('failed transactional migration neither contaminates durable history nor replaces the old snapshot', async () => {
    const value = registry(ledger()); const previous = await value.reload(candidate('x-old'));
    const before = await ledger().load(namespace); await db.destroy();
    db = await new DataSource({ ...options(), migrations: [FailingHistoryMigration1790000010000] }).initialize();
    await expect(db.runMigrations({ transaction: 'all' })).rejects.toThrow('fixture migration failure');
    expect(value.captureSnapshot()).toBe(previous); expect(await ledger().load(namespace)).toEqual(before);
    expect(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='failed_history_fixture'")).toEqual([]);
    await db.destroy(); db = await new DataSource(options()).initialize();
    expect(await ledger().load(namespace)).toEqual(before);
    const cold = registry(ledger()); await cold.reload(candidate('x-next')); expect(cold.captureSnapshot().historicalAuthenticationHeaderNames).toContain('x-old');
  });
});
