import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import {
  createConfiguredGatewayCredentialRegistry,
  GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY,
  gatewayUpstreamCredentialRegistryProvider,
  gatewayUpstreamCredentialResolverProvider,
} from './gateway-upstream-credential.providers';
import {
  GATEWAY_HOST_RUNTIME,
  assertGatewayHostRuntime,
  createGatewayHostRuntime,
  gatewayHostRuntimeProvider,
  resolveGatewayHostRuntime,
  type GatewayHostRuntime,
} from './gateway-host-runtime.providers';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';
import { gatewayHeaderLegacyRuntimeGuardProvider } from './gateway-header-legacy-runtime.providers';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayAccessLogService } from './gateway-access-log.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRuntimeModule } from '../gateway-runtime.module';

@Controller('health-fixture')
class NonGatewayHealth {
  @Get()
  health() {
    return { ok: true };
  }
}

const get = (port: number, path: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      })
      .on('error', reject);
  });

const snapshot = () =>
  ({
    generation: 1,
    candidate: {
      metadata: { revision: 'rev-1' },
      sites: [{ id: 'site', endpoints: [{ endpointDefinitionId: 'endpoint' }] }],
    },
    getHeaderPolicy: () => ({ identity: 'policy-1', version: 1, requestHeaders: ['x-business'] }),
    historicalAuthenticationHeaderNames: [],
  }) as any;
const v1Route = () =>
  ({
    id: 'route',
    endpointDefinitionId: 'endpoint',
    upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } },
  }) as any;
const snapshotService = (host?: GatewayHostRuntime) =>
  new GatewayRouteSnapshotService(
    {} as any,
    { find: jest.fn() } as any,
    { find: jest.fn() } as any,
    {} as any,
    {} as any,
    { find: jest.fn().mockRejectedValue(new Error('db down')) } as any,
    {} as any,
    {} as any,
    {} as any,
    host,
  );

describe('Gateway host runtime early exclusion, trusted snapshot and close lock', () => {
  test('registers the null default and only null/undefined resolve to off', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GatewayRuntimeModule);
    expect(providers).toContain(gatewayHostRuntimeProvider);
    expect(gatewayHostRuntimeProvider.useValue).toBeNull();
    expect(resolveGatewayHostRuntime(null)).toBeNull();
    expect(resolveGatewayHostRuntime(undefined)).toBeNull();
    expect(() => resolveGatewayHostRuntime({ captureSnapshot: () => snapshot() }))
      .toThrow('gateway_host_runtime_invalid');
  });

  test('locks synchronously and fails closed for snapshot and requests', () => {
    const value = snapshot();
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => value });
    expect(runtime.state()).toEqual({ mode: 'host', locked: false });
    expect(runtime.captureSnapshot()).toBe(value);
    runtime.assertOpen();
    runtime.lock('gateway_host_snapshot_unavailable');
    expect(runtime.state()).toMatchObject({
      mode: 'host',
      locked: true,
      lockReason: 'gateway_host_snapshot_unavailable',
    });
    expect(() => runtime.assertOpen()).toThrow('gateway_host_runtime_locked');
    expect(() => runtime.captureSnapshot()).toThrow('gateway_host_runtime_locked');
    runtime.lock('second-reason');
    expect(runtime.state().lockReason).toBe('gateway_host_snapshot_unavailable');
    expect(assertGatewayHostRuntime(runtime)).toBe(runtime);
    expect(() => assertGatewayHostRuntime({ ...runtime })).toThrow('gateway_host_runtime_invalid');
  });

  test('host mode excludes legacy config and watch before any read', async () => {
    const runtime = createGatewayHostRuntime({
      captureSnapshot: () => {
        throw new Error('not-installed');
      },
    });
    const reads: string[] = [];
    const config = {
      get: (key: string) => {
        reads.push(key);
        return 'should-not-be-read';
      },
    } as any;
    const watch = jest.spyOn(UpstreamCredentialRegistry.prototype, 'startWatchingFile');
    const reload = jest.spyOn(UpstreamCredentialRegistry.prototype, 'reloadFile');
    try {
      await expect(createConfiguredGatewayCredentialRegistry(config, undefined, runtime)).resolves.toBeNull();
      expect(reads).toEqual([]);
      expect(watch).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      watch.mockRestore();
      reload.mockRestore();
    }
  });

  test('PolicyService prefers the controlled host snapshot and obeys the lock', () => {
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => snapshot() });
    const legacy = {
      captureSnapshot: () => {
        throw new Error('legacy-path-used');
      },
    } as any;
    const service = new GatewayPolicyService(legacy, runtime);
    expect(service.assertHeaderV1Ready(v1Route())).toBe(
      JSON.stringify([1, 'rev-1', 'policy-1']),
    );
    runtime.lock();
    expect(() => service.compileForRoute(v1Route())).toThrow('GATEWAY_HEADER_POLICY_NOT_READY');
  });

  test('guard provider uses the controlled snapshot while the legacy registry stays null', async () => {
    const value = snapshot();
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => value });
    const module = await Test.createTestingModule({
      providers: [
        { provide: DataSource, useValue: {} },
        { provide: GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, useValue: null },
        { provide: GATEWAY_HOST_RUNTIME, useValue: runtime },
        gatewayHeaderLegacyRuntimeGuardProvider,
      ],
    }).compile();
    try {
      const guard = module.get(GatewayHeaderLegacyRuntimeGuard) as any;
      expect(guard.registryConfigured()).toBe(true);
      expect(guard.captureRegistry()).toBe(value);
      runtime.lock();
      expect(() => guard.captureRegistry()).toThrow('gateway_host_runtime_locked');
    } finally {
      await module.close();
    }
  });

  test('host mode locks instead of aborting Nest when route initialization fails', async () => {
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => snapshot() });
    await expect(snapshotService(runtime).onModuleInit()).resolves.toBeUndefined();
    expect(runtime.state().locked).toBe(true);
    await expect(snapshotService().onModuleInit()).rejects.toThrow('db down');
  });

  test('locked host mode returns 503 for Gateway HTTP while non-Gateway health stays 200', async () => {
    const runtime = createGatewayHostRuntime({
      captureSnapshot: () => {
        throw new Error('unavailable');
      },
      locked: true,
    });
    const module = await Test.createTestingModule({
      controllers: [NonGatewayHealth],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({}) },
        { provide: DataSource, useValue: {} },
        { provide: GATEWAY_HOST_RUNTIME, useValue: runtime },
        gatewayUpstreamCredentialRegistryProvider,
        gatewayUpstreamCredentialResolverProvider,
        gatewayHeaderLegacyRuntimeGuardProvider,
        GatewayPolicyService,
        GatewayRuntimeService,
        ...[
          GatewayRouteSnapshotService,
          GatewaySecurityService,
          GatewayTrafficControlService,
          GatewayCacheService,
          GatewayProxyEngineService,
          GatewayAccessLogService,
          GatewayRuntimeMetricsService,
        ].map(provide => ({ provide, useValue: {} })),
      ],
    }).compile();
    const app = module.createNestApplication();
    app.use('/gateway-fixture', (req, res) => {
      void module
        .get(GatewayRuntimeService)
        .forwardRequest('/items', req, res)
        .catch((error: any) => res.status(error.getStatus?.() ?? 500).end());
    });
    await app.listen(0, '127.0.0.1');
    try {
      const port = (app.getHttpServer().address() as any).port;
      expect(await get(port, '/health-fixture')).toBe(200);
      expect(await get(port, '/gateway-fixture')).toBe(503);
    } finally {
      await app.close();
    }
  });
});
