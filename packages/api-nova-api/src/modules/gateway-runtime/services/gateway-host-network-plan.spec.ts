import { createNetworkPolicyCompiler } from 'api-nova-parser';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { attestGatewayHostNetworkPlan, inspectGatewayHostNetworkPlan } from './gateway-host-network-plan';
import { GatewayNetworkBootstrap } from './gateway-network-bootstrap';
import { GatewayNetworkInstallationService } from './gateway-network-installation.service';

const input = () => {
  const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
  const policy = compiler.compile({ version: 1, id: 'p', revision: '1', sourceServiceAssetId: 'asset',
    siteId: 'site', origin: 'https://example.com', mode: 'public', connection: 'direct' });
  return { compiler, servers: ['127.0.0.1:53'], policies: [{ routeBindingId: 'route', siteId: 'site', policy }] };
};
describe('NP-11 host-only post-route installation', () => {
  it('copies arrays but keeps real compiled policies, and rejects a cloned token', () => {
    const raw = input(), token = attestGatewayHostNetworkPlan(raw);
    const plan = inspectGatewayHostNetworkPlan(token);
    raw.servers[0] = 'other'; raw.policies[0].siteId = 'other';
    expect(plan.servers).toEqual(['127.0.0.1:53']);
    expect(plan.policies[0].siteId).toBe('site');
    expect(plan.policies[0].policy).toBe(raw.policies[0].policy);
    expect(Object.isFrozen(plan.policies)).toBe(true);
    expect(() => inspectGatewayHostNetworkPlan({ ...token })).toThrow('gateway_host_network_plan_invalid');
    expect(JSON.stringify(token)).not.toContain('127.0.0.1');
  });
  it.each([0, -1, 60001, 1.5])('rejects invalid proof lifetime %p', proofTtlMs => {
    expect(() => attestGatewayHostNetworkPlan({ ...input(), proofTtlMs })).toThrow();
  });
  it('rejects input and array getters without executing them', () => {
    const read = jest.fn(() => { throw new Error('must not execute'); });
    expect(() => attestGatewayHostNetworkPlan({ ...input(), get ca() { return read(); } })).toThrow();
    const raw = input();
    Object.defineProperty(raw.policies, '0', { get: read });
    expect(() => attestGatewayHostNetworkPlan(raw)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects sparse arrays, duplicate routes and proxies', () => {
    const raw = input();
    expect(() => attestGatewayHostNetworkPlan({ ...raw, servers: new Array(1) })).toThrow();
    expect(() => attestGatewayHostNetworkPlan({ ...raw, policies: [...raw.policies, ...raw.policies] })).toThrow();
    expect(() => attestGatewayHostNetworkPlan(new Proxy(raw, {}))).toThrow();
  });
  it.each([{}, false, 0])('explicit malformed plan %p cannot fall back to legacy', async plan => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource, undefined, plan as any);
    expect(state.hostMode).toBe(true);
    expect(state.networkProvider).toBeNull();
    expect(state.credentialResolver).toBeNull();
    const routeRead = jest.fn();
    state.installCommittedRoutes({ readActiveRouteCatalog: routeRead } as any);
    expect(routeRead).not.toHaveBeenCalled();
    expect(() => state.assertTrafficAllowed()).toThrow('GATEWAY_NETWORK_HOST_NOT_READY');
    state.onModuleDestroy();
  });
  it('a genuine network plan without credential attestation stays closed', async () => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource, undefined, attestGatewayHostNetworkPlan(input()));
    expect(() => state.assertTrafficAllowed()).toThrow();
    expect(state.networkProvider).toBeNull();
    state.onModuleDestroy();
  });
  it('post-module hook delegates once per call and default-off never reads route state', async () => {
    const state = await GatewayNetworkBootstrap.create(new ConfigService(), {} as DataSource);
    const read = jest.fn(() => { throw new Error('default-off'); });
    new GatewayNetworkInstallationService(state, { readActiveRouteCatalog: read } as any).onApplicationBootstrap();
    expect(read).not.toHaveBeenCalled();
    expect(() => state.assertTrafficAllowed()).not.toThrow();
    state.onModuleDestroy();
    expect(() => state.assertTrafficAllowed()).toThrow();
  });
});
