import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock('../config/environment', () => ({}));
import { buildDatabaseOptions } from './database-options';
import { GatewayHeaderHistoryLedgerService as Service } from './gateway-header-history-ledger.service';
import { GatewayHeaderHistoryLedgerEntity as Ledger } from './entities/gateway-header-history-ledger.entity';

describe('Gateway names-only ledger migration and CAS', () => {
  it('keeps the 4096-name capacity on repeated unions and rejects growth without writes', async () => {
    const db = await new DataSource({ type: 'sqljs', entities: [Ledger], synchronize: true }).initialize();
    try {
      const store = new Service(db).asStore('gateway:capacity', 'a'.repeat(64));
      const names = Array.from({ length: 4096 }, (_, index) => 'x-history-' + index);
      expect(await store.commit('gateway:capacity', 0, names)).toBe(true);
      expect(await store.commit('gateway:capacity', 1, names)).toBe(true);
      await expect(store.commit('gateway:capacity', 2, ['x-overflow'])).rejects.toThrow('header_history_invalid_names');
      expect((await store.load('gateway:capacity')).version).toBe(2);
    } finally { await db.destroy(); }
  });
  it('migrates old storage without backfill, survives reopen, enforces checks and preserves union through CAS', async () => {
    const original = { ...process.env };
    const root = mkdtempSync(join(tmpdir(), 'gateway-header-ledger-'));
    let db: DataSource;
    try {
      process.env.DB_TYPE = 'sqlite'; process.env.DB_SQLITE_PATH = join(root, 'ledger.sqlite');
      // Keep this fixture at the D4 ledger migration boundary; later C3 evidence
      // storage has its own migration acceptance and must not change this rollback target.
      const configured = buildDatabaseOptions();
      const options = { ...configured,
        migrations: (configured.migrations as string[]).filter(path => !path.includes('UpstreamProductionChallengeEvidence')),
        entities: (configured.entities as Function[]).filter(entity => entity.name !== 'UpstreamProductionChallengeEvidenceEntity'),
      };
      db = await new DataSource({ ...options, migrations: (options.migrations as string[]).filter(path => !path.includes('GatewayHeaderHistoryLedger')) } as any).initialize();
      expect(await db.runMigrations()).toHaveLength(5);
      await db.query(`INSERT INTO source_service_assets (id, sourceKey) VALUES ('old-source', 'old-source')`);
      await db.destroy(); db = await new DataSource(options).initialize();
      expect(await db.runMigrations()).toHaveLength(1);
      expect(await db.getRepository(Ledger).count()).toBe(0);
      const identity = 'gateway:trusted-fixture', digest = 'a'.repeat(64);
      let service = new Service(db), store = service.asStore(identity, digest);
      expect(await store.load(identity)).toEqual({ version: 0, names: [] });
      const created = await Promise.all([store.commit(identity, 0, ['X-Old-Key']), store.commit(identity, 0, ['X-Other-Key'])]);
      expect(created.filter(Boolean)).toHaveLength(1);
      const first = await store.load(identity);
      const changed = await Promise.all([store.commit(identity, 1, ['X-New-Key']), store.commit(identity, 1, ['X-Parallel-Key'])]);
      expect(changed.filter(Boolean)).toHaveLength(1);
      expect(await store.commit(identity, 2, [])).toBe(true);
      expect((await store.load(identity)).names).toEqual(expect.arrayContaining([...first.names]));
      const before = await store.load(identity);
      await expect(store.commit('untrusted', 3, ['x-evil'])).rejects.toThrow();
      await expect(service.load(identity, 'b'.repeat(64))).rejects.toThrow();
      await expect(store.commit(identity, 3, ['bad\r\nname'])).rejects.toThrow();
      for (const update of [{ sourceKind: 'unknown' }, { version: 2 }, { revision: 0 }]) {
        await expect(db.getRepository(Ledger).update({ namespace: identity }, update as any)).rejects.toThrow();
      }
      expect((await db.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
      await db.destroy(); db = await new DataSource(options).initialize();
      service = new Service(db); store = service.asStore(identity, digest);
      expect(await store.load(identity)).toEqual(before);
      expect(await db.query(`SELECT sourceKey FROM source_service_assets WHERE id='old-source'`)).toEqual([{ sourceKey: 'old-source' }]);
      await db.getRepository(Ledger).update({ namespace: identity }, { headerNames: '["X-NONCANONICAL"]' });
      await expect(store.load(identity)).rejects.toThrow('header_history_noncanonical_record');
      expect(db.getMetadata(Ledger).columns.map(column => column.propertyName)).toEqual(['namespace', 'sourceKind', 'provenanceDigest', 'version', 'revision', 'headerNames']);
      await db.undoLastMigration(); expect(await db.runMigrations()).toHaveLength(1);
      expect(await db.getRepository(Ledger).count()).toBe(0);
      expect((await db.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
    } finally { if (db?.isInitialized) await db.destroy(); process.env = original; rmSync(root, { recursive: true, force: true }); }
  });
});
