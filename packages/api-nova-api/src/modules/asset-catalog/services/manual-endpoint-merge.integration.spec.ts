import { DataSource } from 'typeorm';
import { AssetCatalogService } from './asset-catalog.service';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { PublicationProfileHistoryEntity } from '../../../database/entities/publication-profile-history.entity';
import { PublicationAuditEventEntity } from '../../../database/entities/publication-audit-event.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingInstanceEntity } from '../../../database/entities/runtime-upstream-binding-instance.entity';

describe('reviewed manual endpoint merge with real SQLite', () => {
  let db: DataSource;
  let service: AssetCatalogService;
  let endpoint: EndpointDefinitionEntity;
  const instances = {
    list: async () => ({ total: 1, data: [] }),
    ensureImportedInstance: async () => null,
  };

  beforeEach(async () => {
    db = new DataSource({
      type: 'sqljs', synchronize: true, autoSave: false,
      entities: [SourceServiceAssetEntity, EndpointDefinitionEntity, RuntimeAssetEntity,
        RuntimeAssetEndpointBindingEntity, EndpointPublishBindingEntity, GatewayRouteBindingEntity,
        PublicationProfileEntity, PublicationProfileHistoryEntity, PublicationAuditEventEntity,
        RuntimeUpstreamBindingEntity, RuntimeUpstreamBindingInstanceEntity],
    });
    await db.initialize();
    service = new AssetCatalogService(
      db.getRepository(SourceServiceAssetEntity), db.getRepository(EndpointDefinitionEntity),
      db.getRepository(RuntimeAssetEndpointBindingEntity), db.getRepository(EndpointPublishBindingEntity),
      db.getRepository(GatewayRouteBindingEntity), db.getRepository(PublicationProfileEntity),
      db.getRepository(PublicationProfileHistoryEntity), db.getRepository(PublicationAuditEventEntity),
      {} as any, {} as any, instances as any,
    );
    const source = await db.getRepository(SourceServiceAssetEntity).save({
      sourceKey: service.normalizeSourceKey({
        scheme: 'https', host: 'upstream.test', port: 443, normalizedBasePath: '/api',
      }),
    });
    endpoint = await db.getRepository(EndpointDefinitionEntity).save({
      sourceServiceAssetId: source.id, method: 'GET', path: '/orders',
      metadata: { source: 'manual-registration', testStatus: 'passed' },
      rawOperation: { parameters: [{ name: 'q', in: 'query' }], requestBody: {} },
    });
  });

  afterEach(async () => { if (db?.isInitialized) await db.destroy(); });

  it('removes upstream candidates and current bindings while retaining historical audit evidence', async () => {
    const runtime = await db.getRepository(RuntimeAssetEntity).save({
      name: 'orders-runtime', type: 'gateway_service', status: 'offline',
    } as any);
    const membership = await db.getRepository(RuntimeAssetEndpointBindingEntity).save({
      runtimeAssetId: runtime.id, endpointDefinitionId: endpoint.id, status: 'offline',
    } as any);
    const upstream = await db.getRepository(RuntimeUpstreamBindingEntity).save({
      runtimeAssetEndpointBindingId: membership.id, sourceServiceAssetId: endpoint.sourceServiceAssetId,
      environment: 'test', selectionMode: 'fixed_primary',
    } as any);
    await db.getRepository(RuntimeUpstreamBindingInstanceEntity).save({
      runtimeUpstreamBindingId: upstream.id, sourceServiceInstanceId: 'historical-instance',
    });
    await db.getRepository(EndpointPublishBindingEntity).save({
      endpointDefinitionId: endpoint.id, runtimeAssetEndpointBindingId: membership.id,
      publishStatus: 'offline',
    } as any);
    await db.getRepository(PublicationAuditEventEntity).save({
      endpointDefinitionId: endpoint.id, runtimeAssetEndpointBindingId: membership.id,
      action: 'membership.offlined', status: 'success', summary: 'Retain this evidence',
    } as any);
    await service.deleteManualEndpointAssetRecord(endpoint.id);
    expect(await db.getRepository(EndpointDefinitionEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeAssetEndpointBindingEntity).count()).toBe(0);
    expect(await db.getRepository(EndpointPublishBindingEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeUpstreamBindingEntity).count()).toBe(0);
    expect(await db.getRepository(RuntimeUpstreamBindingInstanceEntity).count()).toBe(0);
    expect(await db.getRepository(PublicationAuditEventEntity).count()).toBe(1);
    expect((await db.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: runtime.id }))
      .metadata.verificationRequired).toBe(true);
  });

  it('rolls back earlier route changes when a later route conflicts', async () => {
    const routes = db.getRepository(GatewayRouteBindingEntity);
    for (const matchHost of ['first.example', 'second.example']) {
      await routes.save({ endpointDefinitionId: endpoint.id, matchHost, routePath: '/orders',
        upstreamPath: '/orders', routeMethod: 'GET', upstreamMethod: 'GET' });
    }
    await routes.save({ endpointDefinitionId: 'other-endpoint', matchHost: 'second.example',
      routePath: '/new-orders', upstreamPath: '/new-orders', routeMethod: 'GET', upstreamMethod: 'GET' });
    await expect(service.updateManualEndpointAssetRecord(endpoint.id, {
      name: 'Orders', baseUrl: 'https://upstream.test/api', method: 'GET', path: '/new-orders',
    })).rejects.toThrow('conflicts with an existing gateway route');
    const retained = await routes.find({ where: { endpointDefinitionId: endpoint.id } });
    expect(retained).toHaveLength(2);
    expect(retained.every(route => route.routePath === '/orders' && route.upstreamPath === '/orders')).toBe(true);
    expect((await db.getRepository(EndpointDefinitionEntity).findOneByOrFail({ id: endpoint.id })).path)
      .toBe('/orders');
  });

  it('actually persists explicit request-template clearing in the database', async () => {
    await service.updateManualEndpointAssetRecord(endpoint.id, {
      name: 'Orders', baseUrl: 'https://upstream.test/api', method: 'GET', path: '/orders',
      parameters: [], requestBody: null,
    });
    const stored = await db.getRepository(EndpointDefinitionEntity).findOneByOrFail({ id: endpoint.id });
    expect(stored.rawOperation).toEqual({ parameters: [] });
    expect(stored.publishEnabled).toBe(false);
    expect(stored.metadata.testStatus).toBe('untested');
  });

  it('rejects duplicate manual registration without overwriting the endpoint template', async () => {
    await expect(service.registerManualEndpointAsset({
      name: 'Duplicate', baseUrl: 'https://upstream.test/api', method: 'GET', path: '/orders',
    })).rejects.toThrow('already registered');
    expect((await db.getRepository(EndpointDefinitionEntity).findOneByOrFail({ id: endpoint.id })).rawOperation)
      .toEqual(endpoint.rawOperation);
  });
});
