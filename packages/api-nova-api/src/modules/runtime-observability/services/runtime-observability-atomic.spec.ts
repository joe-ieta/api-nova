import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { PlatformTools } from 'typeorm/platform/PlatformTools';
import { createApplicationDataSource } from '../../../database/sqljs-persistence';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeMetricSeriesEntity, RuntimeMetricScope } from '../../../database/entities/runtime-metric-series.entity';
import { RuntimeObservabilityEventEntity, RuntimeObservabilityEventFamily, RuntimeObservabilityStatus } from '../../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityStateEntity, RuntimeObservabilityScopeType, RuntimeCurrentStatus } from '../../../database/entities/runtime-observability-state.entity';
import { RuntimeObservabilityService } from './runtime-observability.service';

const entities = [RuntimeMetricSeriesEntity, RuntimeObservabilityEventEntity, RuntimeObservabilityStateEntity];
const createService = (manager: EntityManager) => new RuntimeObservabilityService(
  manager.getRepository(RuntimeAssetEntity), manager.getRepository(RuntimeAssetEndpointBindingEntity),
  manager.getRepository(EndpointDefinitionEntity), manager.getRepository(RuntimeObservabilityEventEntity),
  manager.getRepository(RuntimeMetricSeriesEntity), manager.getRepository(RuntimeObservabilityStateEntity),
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};

describe('legacy runtime observability atomic projection', () => {
  let db: DataSource, location: string, service: RuntimeObservabilityService;
  const asset = randomUUID(), membership = randomUUID();
  const input = (extra: Record<string, unknown> = {}) => ({ runtimeAssetId: asset, runtimeMembershipId: membership,
    routePath: '/sample', routeMethod: 'GET', latencyMs: 10, statusCode: 200, success: true, ...extra });
  beforeEach(async () => {
    const root = resolve(process.cwd(), '../../.tmp/runtime-observability-atomic');
    await fs.mkdir(root, { recursive: true }); const directory = await fs.mkdtemp(join(root, 'run-')); location = join(directory, 'db.sqlite');
    db = await createApplicationDataSource({ type: 'sqljs', location, autoSave: true, entities, synchronize: true }).initialize();
    service = createService(db.manager);
    jest.spyOn(RuntimeObservabilityService.prototype as any, 'resolveRuntimeRefs').mockImplementation(async (runtimeAssetId: string, binding?: string) => ({ runtimeAssetId, runtimeAssetEndpointBindingId: binding }));
    jest.spyOn(RuntimeObservabilityService.prototype as any, 'toMinuteWindow').mockReturnValue({ startedAt: new Date('2026-10-08T12:00:00Z'), endedAt: new Date('2026-10-08T12:01:00Z') });
  });
  afterEach(async () => { jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); });
  const metric = (name: string) => db.getRepository(RuntimeMetricSeriesEntity).findOneByOrFail({ metricScope: RuntimeMetricScope.RUNTIME_ASSET, metricName: name });
  it('persists all five metrics and two states in one real autoSave with no persistence shortcut', async () => {
    const save = jest.spyOn(db.driver as any, 'autoSave'); await service.recordGatewayRequestResult(input());
    expect(save).toHaveBeenCalledTimes(1); expect((db.options as any).autoSave).toBe(true);
    expect(await db.getRepository(RuntimeMetricSeriesEntity).count()).toBe(5);
    expect(await db.getRepository(RuntimeObservabilityStateEntity).count()).toBe(2);
    const reader = await new DataSource({ type: 'sqljs', location, autoSave: false, entities }).initialize();
    try { expect(await reader.getRepository(RuntimeMetricSeriesEntity).count()).toBe(5); expect(await reader.getRepository(RuntimeObservabilityStateEntity).count()).toBe(2); }
    finally { await reader.destroy(); }
  });
  it('does not resolve the caller before the transaction snapshot reaches the file', async () => {
    const entered = deferred(), finish = deferred(); const write = PlatformTools.writeFile.bind(PlatformTools); let complete = false;
    jest.spyOn(PlatformTools, 'writeFile').mockImplementation(async (...args) => { entered.resolve(); await finish.promise; await write(...args); });
    const pending = service.recordGatewayRequestResult(input()).then(() => { complete = true; });
    try { await entered.promise; expect(complete).toBe(false); }
    finally { finish.resolve(); await pending; }
    expect(complete).toBe(true);
  });
  it.each(['upsertState', 'writeEvent'])('rolls back all metric/state/event writes after a late %s failure, without residual sibling writes', async stage => {
    const original = (RuntimeObservabilityService.prototype as any)[stage]; let calls = 0;
    const injected = jest.spyOn(RuntimeObservabilityService.prototype as any, stage).mockImplementation(async function(this: RuntimeObservabilityService, ...args: unknown[]) {
      if (++calls === (stage === 'upsertState' ? 2 : 1)) throw new Error('injected projection failure');
      return original.apply(this, args);
    });
    await expect(service.recordGatewayRequestResult(input({ success: false, statusCode: 500, errorMessage: 'upstream failure' }))).rejects.toThrow('injected projection failure');
    await new Promise(resolve => setImmediate(resolve));
    for (const entity of entities) expect(await db.getRepository(entity).count()).toBe(0);
    injected.mockRestore(); await service.recordGatewayRequestResult(input({ success: false, statusCode: 500, errorMessage: 'upstream failure' }));
    expect((await metric('gateway.requests.total')).value).toBe(1);
    expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(1);
  });
  it('keeps exact concurrent counts, arithmetic means and the final state', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => service.recordGatewayRequestResult(input({
      latencyMs: (index + 1) * 10, success: index % 2 === 0, statusCode: index % 2 === 0 ? 200 : 500,
    }))));
    expect((await metric('gateway.requests.total')).value).toBe(12);
    expect((await metric('gateway.requests.success')).value).toBe(6);
    expect((await metric('gateway.requests.error')).value).toBe(6);
    expect((await metric('gateway.latency.avg_ms')).value).toBeCloseTo(65);
    expect((await metric('gateway.latency.avg_ms')).sampleCount).toBe(12);
    const states = await db.getRepository(RuntimeObservabilityStateEntity).find();
    for (const state of states) {
      expect(state.counters).toMatchObject({ requestCount: 12, successCount: 6, errorCount: 6 });
      expect(state.gauges?.lastLatencyMs).toBe(120); expect(state.currentStatus).toBe(RuntimeCurrentStatus.DEGRADED);
    }
  });
  it('preserves legacy membership metric keys and state history across request/cache/control writes', async () => {
    const secondMembership = randomUUID(); await service.recordGatewayRequestResult(input());
    await service.recordGatewayRequestResult(input({ runtimeMembershipId: secondMembership, latencyMs: 30 }));
    await service.recordGatewayCacheResult({ ...input(), cacheStatus: 'hit' });
    await service.recordRuntimeControlEvent({ runtimeAssetId: asset, eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
      eventName: 'policy.changed', status: RuntimeObservabilityStatus.SUCCESS, currentStatus: RuntimeCurrentStatus.OFFLINE });
    const totals = await db.getRepository(RuntimeMetricSeriesEntity).findBy({ metricScope: RuntimeMetricScope.RUNTIME_ASSET, metricName: 'gateway.requests.total' });
    expect(totals).toHaveLength(2); expect(totals.map(row => row.runtimeAssetEndpointBindingId).sort()).toEqual([membership, secondMembership].sort());
    expect(totals.map(row => row.value)).toEqual([1, 1]);
    const state = await db.getRepository(RuntimeObservabilityStateEntity).findOneByOrFail({ scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET, runtimeAssetId: asset });
    expect(state.runtimeAssetEndpointBindingId).toBe(membership);
    expect(state.counters).toMatchObject({ requestCount: 2, 'gateway.cache.hit': 1, 'policy.changed': 1 });
    expect(state.currentStatus).toBe(RuntimeCurrentStatus.OFFLINE);
    expect(await db.getRepository(RuntimeObservabilityEventEntity).count()).toBe(2);
  });
  it('uses an existing transaction manager and keeps legitimate outer rollback atomic', async () => {
    await expect(db.transaction(async manager => {
      await createService(manager).recordGatewayRequestResult(input());
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    for (const entity of entities) expect(await db.getRepository(entity).count()).toBe(0);
  });
});
