import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { RuntimePipelineStateEntity } from '../../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore, ObservabilityWriteTransaction } from '../../call-observability/call-observability.store';
import { managementHeartbeatConfiguration } from '../../call-observability/call-observability-heartbeat.worker';
import { GATEWAY_ROUTING_OBSERVER_ID, GATEWAY_ROUTING_OBSERVATION_PREFIX } from '../../call-observability/call-observability-gateway-routing.dto';
import { ObservabilityStorageError, publicSequence } from '../../call-observability/call-observability-storage';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';

export function gatewayRoutingObservationConfiguration(config: ConfigService) {
  return managementHeartbeatConfiguration({ get: key => config.get(String(key).replace('HEARTBEAT', 'GATEWAY_ROUTING_OBSERVER')) } as ConfigService);
}
@Injectable()
export class GatewayRoutingObservationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly instanceId = randomUUID();
  private active?: Promise<{ status: 'reported' | 'busy'; reportedAssets: number }>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private bootstrapped = false;
  private observed = false;
  private lastWarning = 0;
  constructor(private readonly registry: GatewayRouteSnapshotService, private readonly store: CallObservabilityStore,
    private readonly config: ConfigService) {}
  onApplicationBootstrap(): void {
    if (this.bootstrapped || this.stopping) return;
    this.bootstrapped = true;
    try { if (gatewayRoutingObservationConfiguration(this.config).enabled) this.schedule(0); }
    catch { this.warn(); }
  }
  runOnce() {
    if (this.stopping) return Promise.reject(new ObservabilityStorageError('GATEWAY_ROUTING_OBSERVER_STOPPED'));
    if (this.active) return Promise.reject(new ObservabilityStorageError('STORAGE_BUSY'));
    this.active = this.report().finally(() => { this.active = undefined; });
    return this.active;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
    if (!this.observed) return;
    await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const lease = await repository.findOneBy({ id: GATEWAY_ROUTING_OBSERVER_ID });
      if (!lease || lease.value.processInstanceId !== this.instanceId || lease.value.state === 'stopped') return;
      const assets = await tx.manager.getRepository(RuntimeAssetEntity).find({ where: { type: RuntimeAssetType.GATEWAY_SERVICE }, take: 201 });
      if (assets.length > 200) throw new ObservabilityStorageError('GATEWAY_ROUTE_OBSERVATION_TOO_LARGE');
      for (const asset of assets) {
        const row = await repository.findOneBy({ id: GATEWAY_ROUTING_OBSERVATION_PREFIX + asset.id });
        if (!row || row.value.processInstanceId !== this.instanceId) continue;
        await this.persistObservation(tx, asset.id, row.value.activeRouteCount, 'stopped', row.value.intervalMs);
      }
      await repository.save({ ...lease, updatedAt: tx.now, value: { ...lease.value, state: 'stopped', leaseUntil: tx.now } });
    }).catch(() => this.warn());
  }
  private async report() {
    const options = gatewayRoutingObservationConfiguration(this.config);
    if (!options.enabled) throw new ObservabilityStorageError('GATEWAY_ROUTING_OBSERVER_DISABLED');
    const result = await this.store.transaction(async tx => {
      // Capture synchronously only after acquiring the Store writer fence.
      const observedAt = tx.now;
      const observed = this.registry.observeRoutingAssets();
      const routeCounts = new Map(observed.map(item => [item.runtimeAssetId, item.activeRouteCount]));
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const previous = await repository.findOneBy({ id: GATEWAY_ROUTING_OBSERVER_ID });
      if (previous && (!Number.isFinite(Date.parse(previous.value?.leaseUntil)) ||
        typeof previous.value?.processInstanceId !== 'string')) throw new ObservabilityStorageError('INVALID_GATEWAY_OBSERVER_STATE');
      if (previous && previous.value.processInstanceId !== this.instanceId && Date.parse(previous.value.leaseUntil) > Date.parse(tx.now)) {
        return { status: 'busy' as const, reportedAssets: 0 };
      }
      const assets = await tx.manager.getRepository(RuntimeAssetEntity).find({
        where: { type: RuntimeAssetType.GATEWAY_SERVICE }, order: { id: 'ASC' }, take: 201 });
      if (assets.length > 200) throw new ObservabilityStorageError('GATEWAY_ROUTE_OBSERVATION_TOO_LARGE');
      // The database catalog is authoritative for asset type. Unmapped/stale registry IDs never create assets or events.
      for (const asset of assets) await this.persistObservation(tx, asset.id, routeCounts.get(asset.id) ?? 0, 'reporting', options.intervalMs, observedAt);
      await repository.save({ id: GATEWAY_ROUTING_OBSERVER_ID, updatedAt: tx.now, value: {
        processInstanceId: this.instanceId, state: 'reporting', evidenceScope: 'local_process_routing_registry',
        leaseUntil: new Date(Date.parse(tx.now) + options.staleAfterMs).toISOString(), reportedAssets: assets.length } });
      return { status: 'reported' as const, reportedAssets: assets.length };
    });
    if (result.status === 'reported') this.observed = true;
    return result;
  }
  private async persistObservation(tx: ObservabilityWriteTransaction, runtimeAssetId: string,
    activeRouteCount: number, state: 'reporting' | 'stopped', intervalMs: number, observedAt = tx.now) {
    const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
    const id = GATEWAY_ROUTING_OBSERVATION_PREFIX + runtimeAssetId;
    const previous = await repository.findOneBy({ id });
    const version = previous?.value?.stateVersion ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || version >= 2147483647 ||
      !Number.isSafeInteger(activeRouteCount) || activeRouteCount < 0 || activeRouteCount > 10000) {
      throw new ObservabilityStorageError('INVALID_GATEWAY_OBSERVER_STATE');
    }
    const value = { state, evidenceScope: 'local_process_routing_registry', runtimeAssetId,
      processInstanceId: this.instanceId, stateVersion: version + 1, activeRouteCount,
      intervalMs, staleAfterMs: intervalMs * 3,
      lastHeartbeatAt: state === 'reporting' ? observedAt : previous!.value.lastHeartbeatAt,
      stoppedAt: state === 'stopped' ? tx.now : null, snapshotSeq: '0' };
    await this.store.projectionEvent(tx, 'pipeline.state_changed', id, value.stateVersion,
      { state, evidenceScope: value.evidenceScope, serverHealth: 'unknown', businessServerLivenessEvaluated: false,
        coverage: 'single_lease_holder_process' }, { runtimeAssetId, serverType: 'gateway' });
    value.snapshotSeq = publicSequence(tx.currentSequence());
    await repository.save({ id, value, updatedAt: tx.now });
  }
  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay); this.timer.unref();
  }
  private async tick() {
    try { await this.runOnce(); } catch { this.warn(); }
    if (this.stopping) return;
    try { const options = gatewayRoutingObservationConfiguration(this.config); if (options.enabled) this.schedule(options.intervalMs); }
    catch { this.warn(); }
  }
  private warn() {
    if (Date.now() - this.lastWarning < 15000) return;
    this.lastWarning = Date.now();
    process.stderr.write('[GATEWAY_ROUTING_OBSERVATION_DEGRADED] Local registry observation unavailable; retained evidence may become stale.\n');
  }
}
