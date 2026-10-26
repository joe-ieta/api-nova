import { gatewayTrustedNetworkProvider } from './gateway-network-host-bootstrap.service';
import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request = require('supertest');
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { GatewayNetworkBootstrap, gatewayNetworkBootstrapProvider, gatewayBootstrapNetworkProvider, GATEWAY_HOST_CANDIDATE_ATTESTATION } from './gateway-network-bootstrap';
import { GatewayNetworkInstallationService } from './gateway-network-installation.service';
import { GATEWAY_UPSTREAM_CREDENTIAL_CONFIG as keys, GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, gatewayUpstreamCredentialRegistryProvider } from './gateway-upstream-credential.providers';
import { GatewayUpstreamCredentialAdminService } from './gateway-upstream-credential-admin.service';
import { AuditService } from '../../security/services/audit.service';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewayRuntimeController } from '../gateway-runtime.controller';
import { GatewayRuntimeModule } from '../gateway-runtime.module';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GatewayPolicyService } from './gateway-policy.service';

@Controller('health')
class Health { @Get() health() { return { ok: true }; } }

describe('NP-10 Gateway early host exclusion', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([undefined, null])('keeps absent host default-off (%s)', async token => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource, token);
    expect(state.hostMode).toBe(false);
    expect(() => state.assertTrafficAllowed()).not.toThrow();
  });
  it.each([{}, false, '', 0])('invalid explicit token is blocked without executing user getters: %p', async token => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource, token as any);
    expect(state.hostMode).toBe(true);
    expect(() => state.assertTrafficAllowed()).toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    expect(() => state.captureSnapshot()).toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    expect(JSON.stringify(state)).toBe('{}');
    state.onModuleDestroy(); state.onModuleDestroy();
  });
  it('production module registers the shared startup dependency', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GatewayRuntimeModule);
    expect(providers).toContain(gatewayNetworkBootstrapProvider);
    expect(providers).toContain(gatewayTrustedNetworkProvider);
    expect(gatewayTrustedNetworkProvider.inject).toContainEqual({ token: GatewayNetworkBootstrap, optional: true });
    expect(providers.filter((provider: any) => provider?.provide === gatewayTrustedNetworkProvider.provide)).toHaveLength(1);
    expect(providers).toContain(GatewayNetworkInstallationService);
  });
  it.each(Object.values(keys))('rejects host/legacy conflict before load or watch: %s', async key => {
    const watch = jest.spyOn(UpstreamCredentialRegistry.prototype, 'startWatchingFile');
    const load = jest.spyOn(UpstreamCredentialRegistry.prototype, 'reloadFile');
    const config = new ConfigService({ [key]: 'synthetic-private-config' });
    const module = await Test.createTestingModule({ providers: [
      { provide: ConfigService, useValue: config }, { provide: DataSource, useValue: {} },
      { provide: GATEWAY_HOST_CANDIDATE_ATTESTATION, useValue: {} },
      gatewayNetworkBootstrapProvider, gatewayUpstreamCredentialRegistryProvider,
    ] }).compile();
    try {
      expect(module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY)).toBeNull();
      expect(() => module.get(GatewayNetworkBootstrap).assertTrafficAllowed()).toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
      expect(watch).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });
  it('blocks all runtime/proxy paths before lookup, authorization, cache or resolver', async () => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource, {} as any);
    const calls = jest.fn(() => { throw new Error('must not reach dependencies'); });
    const dependency = new Proxy({}, { get: calls }) as any;
    const runtime = new GatewayRuntimeService(dependency, dependency, dependency, dependency, dependency, dependency, dependency, undefined, undefined, undefined, state);
    const proxy = new GatewayProxyEngineService(dependency, dependency, undefined, undefined, undefined, undefined, state);
    await expect(runtime.forwardRequest('/', {} as any, {} as any)).rejects.toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    await expect(runtime.forwardResolvedRoute({} as any, {} as any, {} as any)).rejects.toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    await expect(proxy.prepareRequest({} as any, {} as any)).rejects.toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    await expect(proxy.forward({} as any, {} as any, {} as any)).rejects.toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    const legacyCapture = jest.fn();
    expect(() => new GatewayPolicyService({ captureSnapshot: legacyCapture } as any, undefined, state).assertHeaderV1Ready({} as any)).toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    expect(legacyCapture).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled();
  });
  it('real Nest HTTP keeps health available with Gateway closed and old admin disabled', async () => {
    const module = await Test.createTestingModule({ controllers: [Health, GatewayRuntimeController], providers: [
      { provide: ConfigService, useValue: new ConfigService({ [keys.file]: 'synthetic-path', [keys.reloadMode]: 'watch' }) },
      { provide: DataSource, useValue: {} }, { provide: GATEWAY_HOST_CANDIDATE_ATTESTATION, useValue: {} },
      { provide: AuditService, useValue: { log: jest.fn() } },
      gatewayNetworkBootstrapProvider, gatewayUpstreamCredentialRegistryProvider, GatewayUpstreamCredentialAdminService,
      { provide: GatewayRuntimeService, inject: [GatewayNetworkBootstrap], useFactory: (state: GatewayNetworkBootstrap) =>
        new GatewayRuntimeService(undefined!, undefined!, undefined!, undefined!, undefined!, undefined!, undefined!, undefined, undefined, undefined, state) },
    ] }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
      const denied = await request(app.getHttpServer()).get('/v1/gateway/items').expect(503);
      expect(denied.body.message).toBe('GATEWAY_NETWORK_HOST_NOT_READY');
      expect(JSON.stringify(denied.body)).not.toContain('synthetic-path');
      const admin = module.get(GatewayUpstreamCredentialAdminService);
      expect(admin.status().state).toBe('disabled');
      await expect(admin.reload({ expectedGeneration: 0, reason: 'fixture' }, '00000000-0000-0000-0000-000000000001')).rejects.toMatchObject({
        response: { code: 'UPSTREAM_CREDENTIALS_NOT_CONFIGURED' },
      });
    } finally { await app.close(); }
  });
});
