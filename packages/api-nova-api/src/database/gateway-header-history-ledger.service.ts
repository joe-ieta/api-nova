import type { CredentialHeaderHistoryStore } from 'api-nova-parser';
import { DataSource } from 'typeorm';
import { GatewayHeaderHistoryLedgerEntity as Ledger } from './entities/gateway-header-history-ledger.entity';

export interface GatewayHeaderHistoryRecord { version: 1; revision: number; headerNames: string[] }
/** Callers provide trusted configuration identity, never request headers or secret material. */
export class GatewayHeaderHistoryLedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /** Provenance is pinned by trusted composition; the Parser can supply only namespace and names. */
  asStore(namespace: string, provenanceDigest: string): CredentialHeaderHistoryStore {
    this.identity(namespace, provenanceDigest);
    const check = (requested: string) => { if (requested !== namespace) throw new Error('header_history_namespace_mismatch'); };
    return Object.freeze({
      load: async (requested: string) => { check(requested); const row = await this.load(namespace, provenanceDigest);
        return { version: row?.revision ?? 0, names: row?.headerNames ?? [] }; },
      commit: async (requested: string, expectedVersion: number, names: readonly string[]) => {
        check(requested);
        try { await this.append(namespace, provenanceDigest, expectedVersion, names); return true; }
        catch (error) { if (error instanceof Error && error.message === 'header_history_cas_conflict') return false; throw error; }
      },
    });
  }

  private identity(namespace: string, provenanceDigest: string): void {
    if (typeof namespace !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/.test(namespace)
      || typeof provenanceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(provenanceDigest)) throw new Error('header_history_invalid_identity');
  }
  private names(names: unknown): string[] {
    if (!Array.isArray(names) || names.length > 4096 || names.some(name => typeof name !== 'string'
      || name.length > 256 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))) throw new Error('header_history_invalid_names');
    return [...new Set((names as string[]).map(name => name.toLowerCase()))].sort();
  }
  async load(namespace: string, provenanceDigest: string): Promise<GatewayHeaderHistoryRecord | null> {
    this.identity(namespace, provenanceDigest);
    const row = await this.dataSource.getRepository(Ledger).findOneBy({ namespace });
    if (!row) return null;
    if (row.sourceKind !== 'registry' || row.provenanceDigest !== provenanceDigest || row.version !== 1
      || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('header_history_invalid_record');
    const decoded: unknown = JSON.parse(row.headerNames);
    const headerNames = this.names(decoded);
    if (JSON.stringify(headerNames) !== row.headerNames) throw new Error('header_history_noncanonical_record');
    return { version: 1, revision: row.revision, headerNames };
  }
  async append(namespace: string, provenanceDigest: string, expectedRevision: number, names: readonly string[]): Promise<GatewayHeaderHistoryRecord> {
    this.identity(namespace, provenanceDigest);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2147483647) throw new Error('header_history_invalid_revision');
    const incoming = this.names(names);
    const previous = await this.load(namespace, provenanceDigest);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('header_history_cas_conflict');
    const headerNames = this.names([...new Set([...(previous?.headerNames ?? []), ...incoming])]);
    const revision = expectedRevision + 1;
    const repo = this.dataSource.getRepository(Ledger);
    if (!previous) {
      try { await repo.insert({ namespace, provenanceDigest, sourceKind: 'registry', version: 1, revision, headerNames: JSON.stringify(headerNames) }); }
      catch (error) {
        if (error?.driverError?.code === '23505' || /UNIQUE constraint failed/.test(error?.driverError?.message ?? '')) throw new Error('header_history_cas_conflict');
        throw new Error('header_history_create_failed');
      }
    } else {
      const result = await repo.update({ namespace, provenanceDigest, sourceKind: 'registry', version: 1, revision: expectedRevision,
        headerNames: JSON.stringify(previous.headerNames) }, { revision, headerNames: JSON.stringify(headerNames) });
      if (result.affected !== 1) throw new Error('header_history_cas_conflict');
    }
    return { version: 1, revision, headerNames };
  }
}
