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
export const DELIVERY_RETENTION_MS = 30 * 86400000;

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
      // Drain finite batches while making progress; yield between them for HTTP and
      // other workers. Empty/failed passes retain the existing one-second backoff.
      let nextDelayMs = 1000;
      try {
        const report = await this.runOnce();
        if (report.materializedEvents > 0) nextDelayMs = 0;
      } catch { /* A bounded lease preserves recovery for the next cycle. */ }
      finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, nextDelayMs);
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
      if (rows.length) await repository.update({ id: In(rows.map(row => row.id)) }, {
        dispatchState: 'leased', dispatchLeaseOwner: this.owner, dispatchLeaseUntil: leaseUntil,
      });
      return { ids: rows.map(row => row.id), recovered };
    });

    const report: OutboxMaterializationReport = { claimed: claimed.ids.length, materializedEvents: 0,
      deliveriesCreated: 0, recoveredLeases: claimed.recovered, watermark: '0' };
    // Keep each commit bounded even when a caller requests the maximum claim limit.
    // No network I/O occurs here; durable jobs and their watermark commit atomically.
    for (let offset = 0; offset < claimed.ids.length; offset += 32) {
      const batch = await this.store.transaction(async tx => {
        const result = await this.materializeBatch(tx, claimed.ids.slice(offset, offset + 32));
        return { materialized: result.eventIds.length, created: result.created,
          watermark: await this.advanceWatermarkInTransaction(tx, result.eventIds.at(-1)) };
      });
      report.materializedEvents += batch.materialized;
      report.deliveriesCreated += batch.created;
      report.watermark = batch.watermark;
    }
    if (!claimed.ids.length) report.watermark = await this.advanceWatermark();
    return report;
  }

  private async materializeBatch(tx: ObservabilityWriteTransaction,
    eventIds: string[]): Promise<{ created: number; eventIds: string[] }> {
    const eventRepository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
    const rows = new Map((await eventRepository.findBy({ id: In(eventIds) })).map(row => [row.id, row]));
    const events = eventIds.map(id => rows.get(id)).filter((event): event is RuntimeObservabilityEventEntity =>
      !!event && event.dispatchState === 'leased' && event.dispatchLeaseOwner === this.owner &&
      !!event.dispatchLeaseUntil && event.dispatchLeaseUntil.getTime() > Date.parse(tx.now) &&
      !!event.sequence && !!event.expiresAt && event.expiresAt.getTime() > Date.parse(tx.now));
    if (!events.length) return { created: 0, eventIds: [] };
    const sequences = events.map(event => sequenceKey(event.sequence!));
    const sortedSequences = [...sequences].sort();
    const deliveries = tx.manager.getRepository(RuntimeEventDeliveryEntity);
    let created = 0;
    const pending: RuntimeEventDeliveryEntity[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const existing = new Set((await deliveries.find({ where: { id: In(pending.map(row => row.id)) },
        select: { id: true } })).map(row => row.id));
      const fresh = pending.filter(row => !existing.has(row.id));
      if (fresh.length) await deliveries.insert(fresh);
      created += fresh.length;
      pending.length = 0;
    };
    // Keep only one subscription's effective revision per event. Keyset pages
    // bound both memory and SQL parameters even with a large revision history.
    const effective = new Map<string, RuntimeSubscriptionRevisionEntity>();
    const emitSubscription = async () => {
      for (const event of events) {
        const revision = effective.get(event.id);
        if (!revision || !this.matches(event, revision.config as SubscriptionConfig)) continue;
        pending.push(deliveries.create({
          id: contentHash(canonicalJson(['observability.delivery.v1', revision.subscriptionId, event.id])),
          subscriptionId: revision.subscriptionId, subscriptionRevision: revision.version,
          eventId: event.id, eventSequence: sequenceKey(event.sequence!), status: 'pending',
          version: 1, attemptCount: 0, replayGeneration: 0, nextAttemptAt: tx.now,
          leaseOwner: null, leaseUntil: null, lastError: {}, createdAt: tx.now, updatedAt: tx.now,
          expiresAt: new Date(Date.parse(tx.now) + DELIVERY_RETENTION_MS).toISOString(),
        }));
        if (pending.length === 32) await flush();
      }
      effective.clear();
    };
    let subscription: string | undefined;
    let cursor: { subscriptionId: string; version: number } | undefined;
    while (true) {
      const query = tx.manager.getRepository(RuntimeSubscriptionRevisionEntity).createQueryBuilder('revision')
        .where('revision.revoked = :revoked', { revoked: false })
        .andWhere('revision.effectiveFromSequence <= :maximum', { maximum: sortedSequences.at(-1) })
        .andWhere('(revision.effectiveUntilSequence IS NULL OR revision.effectiveUntilSequence > :minimum)',
          { minimum: sortedSequences[0] });
      if (cursor) query.andWhere('(revision.subscriptionId > :subscriptionId OR ' +
        '(revision.subscriptionId = :subscriptionId AND revision.version > :version))', cursor);
      const revisions = await query.orderBy('revision.subscriptionId', 'ASC')
        .addOrderBy('revision.version', 'ASC').take(128).getMany();
      for (const revision of revisions) {
        if (subscription !== undefined && subscription !== revision.subscriptionId) await emitSubscription();
        subscription = revision.subscriptionId;
        for (let index = 0; index < events.length; index++) {
          const sequence = sequences[index];
          if (revision.effectiveFromSequence <= sequence &&
            (!revision.effectiveUntilSequence || revision.effectiveUntilSequence > sequence)) {
            effective.set(events[index].id, revision);
          }
        }
      }
      if (revisions.length < 128) break;
      const last = revisions[revisions.length - 1];
      cursor = { subscriptionId: last.subscriptionId, version: last.version };
    }
    await emitSubscription();
    await flush();
    const materializedIds = events.map(event => event.id);
    await eventRepository.update({ id: In(materializedIds) }, {
      dispatchState: 'materialized', dispatchLeaseOwner: null as any, dispatchLeaseUntil: null as any,
    });
    return { created, eventIds: materializedIds };
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
