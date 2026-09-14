import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { In } from 'typeorm';
import {
  RuntimeEventDeliveryEntity, RuntimePipelineStateEntity, RuntimeSubscriptionRevisionEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { canonicalJson, contentHash, publicSequence, sequenceKey } from './call-observability-storage';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';

export const OUTBOX_WORKER_STATE_ID = 'call-observability:outbox-materializer';
const EVENT_LEASE_MS = 15000;
const DELIVERY_RETENTION_DAYS = 14;

export interface OutboxMaterializationReport {
  claimed: number;
  materializedEvents: number;
  deliveriesCreated: number;
  recoveredLeases: number;
  watermark: string;
}

type SubscriptionConfig = {
  state?: string;
  filter?: Record<string, unknown>;
  scope?: { mode?: string; runtimeAssetIds?: unknown };
};

/** Converts committed events into durable delivery jobs. Network delivery belongs to TP-12. */
@Injectable()
export class CallObservabilityOutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly owner = randomUUID();
  private active?: Promise<OutboxMaterializationReport>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;

  constructor(private readonly store: CallObservabilityStore, private readonly config: ConfigService) {}

  onApplicationBootstrap(): void {
    if (this.config.get('API_NOVA_OBSERVABILITY_OUTBOX_ENABLED') !== 'true') return;
    const tick = async () => {
      try { await this.runOnce(); } catch { /* A bounded lease preserves recovery for the next cycle. */ }
      finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, 1000);
          this.timer.unref();
        }
      }
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  runOnce(limit = 32): Promise<OutboxMaterializationReport> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      return Promise.reject(new Error('INVALID_OUTBOX_LIMIT'));
    }
    if (this.stopping) return Promise.reject(new Error('OUTBOX_STOPPED'));
    if (this.active) return this.active;
    this.active = this.run(limit).finally(() => { this.active = undefined; });
    return this.active;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active?.catch(() => undefined);
  }

  private async run(limit: number): Promise<OutboxMaterializationReport> {
    const claimed = await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
      const query = repository.createQueryBuilder('event')
        .where("(event.dispatchState = 'pending' OR (event.dispatchState = 'leased' AND event.dispatchLeaseUntil <= :now))",
          { now: new Date(tx.now) })
        .andWhere('event.schemaVersion = :schema AND event.sequence IS NOT NULL', { schema: '1.0' })
        .andWhere('event.expiresAt > :now', { now: new Date(tx.now) })
        .orderBy('event.sequence', 'ASC').take(limit);
      if (tx.manager.connection.options.type === 'postgres') query.setLock('pessimistic_write').setOnLocked('skip_locked');
      const rows = await query.getMany();
      const leaseUntil = new Date(Date.parse(tx.now) + EVENT_LEASE_MS);
      const recovered = rows.filter(row => row.dispatchState === 'leased').length;
      for (const row of rows) {
        row.dispatchState = 'leased';
        row.dispatchLeaseOwner = this.owner;
        row.dispatchLeaseUntil = leaseUntil;
      }
      await repository.save(rows);
      return { ids: rows.map(row => row.id), recovered };
    });

    const report: OutboxMaterializationReport = { claimed: claimed.ids.length, materializedEvents: 0,
      deliveriesCreated: 0, recoveredLeases: claimed.recovered, watermark: await this.watermark() };
    for (const id of claimed.ids) {
      const result = await this.materialize(id);
      if (result) {
        report.materializedEvents++;
        report.deliveriesCreated += result.created;
        report.watermark = result.watermark;
      }
    }
    report.watermark = await this.advanceWatermark();
    return report;
  }

  private async materialize(eventId: string): Promise<{ created: number; watermark: string } | null> {
    return this.store.transaction(async tx => {
      const eventRepository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
      const event = await eventRepository.findOneBy({ id: eventId });
      if (!event || event.dispatchState !== 'leased' || event.dispatchLeaseOwner !== this.owner ||
        !event.dispatchLeaseUntil || event.dispatchLeaseUntil.getTime() <= Date.parse(tx.now) ||
        !event.sequence || !event.expiresAt || event.expiresAt.getTime() <= Date.parse(tx.now)) return null;
      const sequence = sequenceKey(event.sequence);
      const revisions = await tx.manager.getRepository(RuntimeSubscriptionRevisionEntity)
        .createQueryBuilder('revision')
        .where('revision.revoked = :revoked', { revoked: false })
        .andWhere('revision.effectiveFromSequence <= :sequence', { sequence })
        .andWhere('(revision.effectiveUntilSequence IS NULL OR revision.effectiveUntilSequence > :sequence)', { sequence })
        .orderBy('revision.subscriptionId', 'ASC').addOrderBy('revision.version', 'ASC').getMany();
      const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
      let created = 0;
      const effective = new Map<string, RuntimeSubscriptionRevisionEntity>();
      for (const revision of revisions) effective.set(revision.subscriptionId, revision);
      for (const revision of effective.values()) {
        const config = revision.config as SubscriptionConfig;
        if (!this.matches(event, config)) continue;
        const id = contentHash(canonicalJson(['observability.delivery.v1', revision.subscriptionId, event.id]));
        const previous = await deliveries.findOneBy({ id });
        if (previous) continue;
        await deliveries.insert(deliveries.create({ id, subscriptionId: revision.subscriptionId,
          subscriptionRevision: revision.version, eventId: event.id, eventSequence: sequence,
          status: 'pending', version: 1, attemptCount: 0, replayGeneration: 0,
          nextAttemptAt: tx.now, leaseOwner: null, leaseUntil: null, lastError: {},
          createdAt: tx.now, updatedAt: tx.now,
          expiresAt: new Date(Math.min(event.expiresAt.getTime(),
            Date.parse(tx.now) + DELIVERY_RETENTION_DAYS * 86400000)).toISOString() }));
        created++;
      }
      event.dispatchState = 'materialized';
      event.dispatchLeaseOwner = null as any;
      event.dispatchLeaseUntil = null as any;
      await eventRepository.save(event);
      const watermark = await this.advanceWatermarkInTransaction(tx, event.id);
      return { created, watermark };
    });
  }

  private matches(event: RuntimeObservabilityEventEntity, config: SubscriptionConfig): boolean {
    if (!config || config.state !== 'enabled' || !config.scope || !config.filter) return false;
    const scope = config.scope;
    if (scope.mode !== 'all') {
      if (scope.mode !== 'assets' || !Array.isArray(scope.runtimeAssetIds) ||
        !event.runtimeAssetId || !scope.runtimeAssetIds.includes(event.runtimeAssetId)) return false;
    }
    const filter = config.filter;
    const values: Record<string, unknown> = { eventTypes: event.eventName, severities: event.severity,
      spanKinds: event.details?.spanKind, outcomes: event.details?.outcome,
      runtimeAssetIds: event.runtimeAssetId, serverTypes: event.dimensions?.serverType,
      callerIds: event.dimensions?.callerId, endpointDefinitionIds: event.dimensions?.endpointDefinitionId,
      toolNames: event.details?.toolName };
    return Object.entries(filter).every(([key, expected]) => Array.isArray(expected) && expected.length > 0 &&
      typeof values[key] === 'string' && expected.includes(values[key]));
  }

  private async watermark(): Promise<string> {
    return this.store.readSnapshot(async tx => {
      const state = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: OUTBOX_WORKER_STATE_ID });
      return publicSequence(state?.value?.watermark || '0');
    });
  }

  /** Highest global sequence below the first unresolved dispatch-eligible event. */
  private async advanceWatermark(): Promise<string> {
    return this.store.transaction(async tx => this.advanceWatermarkInTransaction(tx));
  }

  private async advanceWatermarkInTransaction(
    tx: ObservabilityWriteTransaction,
    materializedEventId?: string,
  ): Promise<string> {
    const states = tx.manager.getRepository(RuntimePipelineStateEntity);
    const previous = await states.findOneBy({ id: OUTBOX_WORKER_STATE_ID });
    const previousWatermark = publicSequence(previous?.value?.watermark || '0');
    const unresolved = await tx.manager.getRepository(RuntimeObservabilityEventEntity)
      .createQueryBuilder('event')
      .where('event.schemaVersion = :schema AND event.sequence IS NOT NULL', { schema: '1.0' })
      .andWhere('event.sequence > :watermark', { watermark: sequenceKey(previousWatermark) })
      .andWhere("(event.dispatchState = 'pending' OR event.dispatchState = 'leased')")
      .andWhere('event.expiresAt > :now', { now: new Date(tx.now) })
      .orderBy('event.sequence', 'ASC').take(1).getOne();
    const candidate = unresolved ? BigInt(publicSequence(unresolved.sequence!)) - BigInt(1) :
      BigInt(publicSequence(tx.currentSequence()));
    const watermark = candidate > BigInt(previousWatermark) ? candidate.toString() : previousWatermark;
    await states.save(states.create({ id: OUTBOX_WORKER_STATE_ID, updatedAt: tx.now,
      value: {
        watermark,
        lastReconciledAt: tx.now,
        lastMaterializedAt: materializedEventId ? tx.now : (previous?.value?.lastMaterializedAt ?? null),
        lastEventId: materializedEventId ? materializedEventId : (previous?.value?.lastEventId ?? null),
      } }));
    return watermark;
  }
}
