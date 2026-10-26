import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';
import { gatewayHeaderLegacyRuntimeGuardProvider } from './gateway-header-legacy-runtime.providers';
import { gatewayHostRuntimeProvider } from './gateway-host-runtime.providers';
import { GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY } from './gateway-upstream-credential.providers';
import { GatewayRuntimeModule } from '../gateway-runtime.module';

describe('required Nest Legacy runtime guard provider', () => {
  const dependencies = () => [GatewayRouteSnapshotService, GatewaySecurityService, GatewayTrafficControlService, GatewayCacheService, GatewayProxyEngineService, GatewayAccessLogService, GatewayRuntimeMetricsService].map(provide => ({ provide, useValue: {} }));
  it('production module registers the provider and Nest injects it', async () => {
    expect(Reflect.getMetadata('providers', GatewayRuntimeModule)).toContain(gatewayHeaderLegacyRuntimeGuardProvider);
    const module = await Test.createTestingModule({ providers: [GatewayRuntimeService, gatewayHeaderLegacyRuntimeGuardProvider,
      { provide: DataSource, useValue: {} }, { provide: GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, useValue: null }, gatewayHostRuntimeProvider, ...dependencies()] }).compile();
    try {
      expect(module.get(GatewayHeaderLegacyRuntimeGuard)).toBeInstanceOf(GatewayHeaderLegacyRuntimeGuard);
      expect((module.get(GatewayRuntimeService) as any).gatewayHeaderLegacyRuntimeGuard).toBe(module.get(GatewayHeaderLegacyRuntimeGuard));
    } finally { await module.close(); }
  });
  it('missing guard is a startup dependency failure, not an optional Nest bypass', async () => {
    await expect(Test.createTestingModule({ providers: [GatewayRuntimeService, ...dependencies()] }).compile()).rejects.toThrow('GatewayHeaderLegacyRuntimeGuard');
  });
});
