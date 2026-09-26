import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { createNetworkPolicyCompiler } from 'api-nova-parser';
import { createGatewayActiveRouteCapture } from './gateway-active-route-capture';
import {
  GATEWAY_NETWORK_HOST_FACADE,
  GatewayNetworkHostBootstrapService,
  assertGatewayNetworkHostSource,
  createGatewayNetworkHostSource,
  gatewayNetworkHostFacadeProvider,
  gatewayNetworkHostSourceProvider,
  gatewayTrustedNetworkProvider,
  resolveGatewayNetworkHostSource,
} from './gateway-network-host-bootstrap.service';
import {
  createGatewayHostRuntime,
} from './gateway-host-runtime.providers';
import { createGatewayTrustedNetworkFacade } from './gateway-trusted-network.provider';
import { GatewayRuntimeModule } from '../gateway-runtime.module';

const compiler = () => createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
const fakeHost = () => ({
  captureSnapshot: () => {
    throw new Error('unavailable');
  },
  issueProof: () => ({}),
  consumeProof: () => ({ expiresAt: Date.now() + 1000 }),
  readEpoch: () => 'epoch',
  readSignal: () => new AbortController().signal,
  close() {},
  onModuleDestroy() {},
});
const source = (host: any = fakeHost()) =>
  createGatewayNetworkHostSource({
    host,
    compiler: compiler(),
    servers: ['127.0.0.1:53'],
    policyFor: () => ({} as any),
  });

describe('Gateway host network bootstrap (SEC-F3-02C1d2b3d2b)', () => {
  test('registers default-off providers in the real Gateway module', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GatewayRuntimeModule);
    expect(providers).toContain(gatewayNetworkHostSourceProvider);
    expect(providers).toContain(gatewayNetworkHostFacadeProvider);
    expect(providers).toContain(gatewayTrustedNetworkProvider);
    expect(providers).toContain(GatewayNetworkHostBootstrapService);
    expect(gatewayNetworkHostSourceProvider.useValue).toBeNull();
    expect(resolveGatewayNetworkHostSource(null)).toBeNull();
    expect(resolveGatewayNetworkHostSource(undefined)).toBeNull();
    expect(gatewayNetworkHostFacadeProvider.useFactory(null)).toBeNull();
    expect(gatewayTrustedNetworkProvider.useFactory(null)).toBeNull();
  });

  test('brands the host source and rejects clones or invalid shapes', () => {
    expect(() => createGatewayNetworkHostSource({} as any))
      .toThrow('gateway_network_host_source_invalid');
    expect(() => createGatewayNetworkHostSource({
      host: fakeHost(), compiler: compiler(), servers: [], policyFor: () => ({} as any),
    })).toThrow('gateway_network_host_source_invalid');
    const valid = source();
    expect(assertGatewayNetworkHostSource(valid)).toBe(valid);
    expect(() => assertGatewayNetworkHostSource({ ...valid }))
      .toThrow('gateway_network_host_source_invalid');
    const facade: any = gatewayNetworkHostFacadeProvider.useFactory(valid);
    expect(facade).not.toBeNull();
    expect(gatewayTrustedNetworkProvider.useFactory(facade)).toBe(facade.provider);
  });

  test('does nothing without an explicit host source', async () => {
    const service = new GatewayNetworkHostBootstrapService(null, null, null, undefined, undefined);
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  test('rejects an explicit host source that conflicts with legacy credential configuration', async () => {
    const runtime = createGatewayHostRuntime({
      captureSnapshot: () => {
        throw new Error('unavailable');
      },
    });
    const service = new GatewayNetworkHostBootstrapService(
      source(),
      createGatewayTrustedNetworkFacade(),
      runtime,
      { readActiveRouteCatalog: () => { throw new Error('not ready'); } } as any,
      new ConfigService({ API_NOVA_UPSTREAM_CREDENTIAL_FILE: 'legacy.json' }),
    );
    await expect(service.onApplicationBootstrap())
      .rejects.toThrow('gateway_network_host_installation_conflict');
  });

  test('rejects an explicit host source without active host mode', async () => {
    const service = new GatewayNetworkHostBootstrapService(
      source(),
      createGatewayTrustedNetworkFacade(),
      null,
      undefined,
      new ConfigService({}),
    );
    await expect(service.onApplicationBootstrap())
      .rejects.toThrow('gateway_network_host_installation_conflict');
  });

  test('locks the host Gateway when assembly cannot complete', async () => {
    const catalog = Object.freeze({
      version: 1,
      routes: Object.freeze([Object.freeze({
        runtimeAssetId: 'asset-runtime',
        routeBindingId: 'route-1',
        revision: 'r1',
        fingerprint: 'a'.repeat(64),
      })]),
    });
    const entry = Object.freeze({
      identity: catalog.routes[0],
      route: {
        routeBinding: { id: 'route-1' },
        runtimeAsset: { id: 'asset-runtime' },
        membership: { id: 'membership' },
        endpointDefinition: { id: 'endpoint' },
        sourceServiceAsset: { id: 'asset' },
        upstreamBaseUrl: 'https://api.example/items',
      },
    });
    const capture = createGatewayActiveRouteCapture(catalog, [entry] as any, () => undefined);
    const snapshot = Object.freeze({
      generation: 1,
      candidate: Object.freeze({
        metadata: { revision: 'r1' },
        sites: Object.freeze([Object.freeze({
          id: 'site',
          sourceServiceAssetId: 'asset',
          endpoints: Object.freeze([{ endpointDefinitionId: 'endpoint' }]),
        })]),
      }),
    });
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => snapshot as any });
    const facade = createGatewayTrustedNetworkFacade();
    const service = new GatewayNetworkHostBootstrapService(
      source({ ...fakeHost(), captureSnapshot: () => snapshot }),
      facade,
      runtime,
      {
        readActiveRouteCatalog: () => catalog,
        captureActiveRouteCatalog: () => capture,
      } as any,
      new ConfigService({}),
    );
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(runtime.state().locked).toBe(true);
    expect(facade.provider.requires(entry.route as any)).toBe(false);
  });

  test('locks when the committed catalog or host snapshot never becomes ready', async () => {
    const runtime = createGatewayHostRuntime({
      captureSnapshot: () => {
        throw new Error('unavailable');
      },
    });
    const service = new GatewayNetworkHostBootstrapService(
      source(),
      createGatewayTrustedNetworkFacade(),
      runtime,
      { readActiveRouteCatalog: () => { throw new Error('not ready'); } } as any,
      new ConfigService({}),
    );
    service.assemblyWaitMs = 30;
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(runtime.state()).toMatchObject({
      locked: true,
      lockReason: 'gateway_network_host_installation_unavailable',
    });
  });

  test('defers without locking when no committed routes exist', async () => {
    const snapshot = {
      generation: 1,
      candidate: { metadata: { revision: 'r1' }, sites: [] },
    };
    const runtime = createGatewayHostRuntime({ captureSnapshot: () => snapshot as any });
    const facade = createGatewayTrustedNetworkFacade();
    const service = new GatewayNetworkHostBootstrapService(
      source({ ...fakeHost(), captureSnapshot: () => snapshot }),
      facade,
      runtime,
      { readActiveRouteCatalog: () => Object.freeze({ version: 1, routes: Object.freeze([]) }) } as any,
      new ConfigService({}),
    );
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(runtime.state().locked).toBe(false);
  });
});
