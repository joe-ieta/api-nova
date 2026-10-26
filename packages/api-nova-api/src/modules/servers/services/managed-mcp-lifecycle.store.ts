import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RuntimePipelineStateEntity } from '../../../database/entities/runtime-call-observability.entity';
import {
  MANAGED_MCP_LIFECYCLE_PREFIX,
  ManagedLifecycleRecordV1,
  parseManagedLifecycleRecord,
  trustedLifecycleText,
} from './managed-mcp-lifecycle.contract';

export type ManagedMcpLifecycleRead =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly updatedAt: string; readonly record: ManagedLifecycleRecordV1 }
  | { readonly status: 'invalid'; readonly updatedAt: string };

export type ManagedMcpLifecycleSwapResult =
  | { readonly status: 'applied'; readonly updatedAt: string }
  | { readonly status: 'conflict' };

export interface ManagedMcpLifecycleStore {
  read(serverId: string): Promise<ManagedMcpLifecycleRead>;
  compareAndSwap(serverId: string, expectedUpdatedAt: string | null, record: ManagedLifecycleRecordV1): Promise<ManagedMcpLifecycleSwapResult>;
}

export function managedMcpLifecycleRowId(serverId: string): string {
  if (!trustedLifecycleText(serverId, 160)) throw new Error('MANAGED_LIFECYCLE_REJECTED');
  return `${MANAGED_MCP_LIFECYCLE_PREFIX}${serverId}`;
}

let casSequence = 0;
function casToken(): string {
  return `${Date.now()}-${++casSequence}-${randomUUID()}`;
}

export class DataSourceManagedMcpLifecycleStore implements ManagedMcpLifecycleStore {
  constructor(private readonly dataSource: DataSource) {}

  private repository(): Repository<RuntimePipelineStateEntity> {
    return this.dataSource.getRepository(RuntimePipelineStateEntity);
  }

  async read(serverId: string): Promise<ManagedMcpLifecycleRead> {
    const row = await this.repository().findOne({ where: { id: managedMcpLifecycleRowId(serverId) } });
    if (!row) return { status: 'absent' };
    const record = parseManagedLifecycleRecord(row.value);
    if (!record || record.serverId !== serverId) return { status: 'invalid', updatedAt: row.updatedAt };
    return { status: 'valid', updatedAt: row.updatedAt, record };
  }

  async compareAndSwap(serverId: string, expectedUpdatedAt: string | null, record: ManagedLifecycleRecordV1): Promise<ManagedMcpLifecycleSwapResult> {
    const repository = this.repository();
    const id = managedMcpLifecycleRowId(serverId);
    const updatedAt = casToken();
    try {
      if (expectedUpdatedAt === null) {
        await repository.insert(repository.create({ id, value: record as any, updatedAt }));
        return { status: 'applied', updatedAt };
      }
      const result = await repository.update({ id, updatedAt: expectedUpdatedAt }, { value: record as any, updatedAt });
      return result.affected === 1 ? { status: 'applied', updatedAt } : { status: 'conflict' };
    } catch {
      return { status: 'conflict' };
    }
  }
}

export class InMemoryManagedMcpLifecycleStore implements ManagedMcpLifecycleStore {
  private readonly rows = new Map<string, { updatedAt: string; value: unknown }>();

  async read(serverId: string): Promise<ManagedMcpLifecycleRead> {
    const row = this.rows.get(managedMcpLifecycleRowId(serverId));
    if (!row) return { status: 'absent' };
    const record = parseManagedLifecycleRecord(row.value);
    if (!record || record.serverId !== serverId) return { status: 'invalid', updatedAt: row.updatedAt };
    return { status: 'valid', updatedAt: row.updatedAt, record };
  }

  async compareAndSwap(serverId: string, expectedUpdatedAt: string | null, record: ManagedLifecycleRecordV1): Promise<ManagedMcpLifecycleSwapResult> {
    const id = managedMcpLifecycleRowId(serverId);
    const row = this.rows.get(id);
    if (expectedUpdatedAt === null) {
      if (row) return { status: 'conflict' };
      const updatedAt = casToken();
      this.rows.set(id, { updatedAt, value: record });
      return { status: 'applied', updatedAt };
    }
    if (!row || row.updatedAt !== expectedUpdatedAt) return { status: 'conflict' };
    const updatedAt = casToken();
    this.rows.set(id, { updatedAt, value: record });
    return { status: 'applied', updatedAt };
  }

  putInvalidForTest(serverId: string, value: unknown, updatedAt = casToken()): void {
    this.rows.set(managedMcpLifecycleRowId(serverId), { updatedAt, value });
  }
}
