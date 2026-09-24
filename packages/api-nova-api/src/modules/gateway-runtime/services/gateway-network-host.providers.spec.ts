import { createGatewayNetworkHostProviders } from './gateway-network-host.providers';
import { assertGatewayTrustedNetworkProvider, createGatewayTrustedNetworkFacade } from './gateway-trusted-network.provider';

describe('host network provider composition boundaries', () => {
  it('does not create a provider without explicit host installation', () => {
    expect(createGatewayNetworkHostProviders()).toBeNull();
  });
  it('rejects structural registration bundles and does not treat config as authority', () => {
    for (const value of [null, {}, { bundle: { kind: 'gateway-network-registration-bundle', signal: new AbortController().signal } }, { enabled: true }]) {
      expect(() => createGatewayNetworkHostProviders(value as any)).toThrow();
    }
  });
  it('facade has the actual provider brand while copies do not', () => {
    const facade = createGatewayTrustedNetworkFacade();
    expect(() => assertGatewayTrustedNetworkProvider(facade.provider)).not.toThrow();
    expect(() => assertGatewayTrustedNetworkProvider({ ...facade.provider })).toThrow();
    facade.close(); facade.close();
  });
  it('empty or closed installation cannot prepare, send or resolve credentials', async () => {
    const facade = createGatewayTrustedNetworkFacade();
    const route: any = { routeBinding: { id: 'route' }, runtimeAsset: { id: 'asset' }, membership: { id: 'member' } };
    const callback = jest.fn();
    expect(facade.provider.requires(route)).toBe(false);
    await expect(facade.provider.prepare(route, 'https://example.com', callback, { deadline: Date.now() + 1000 })).rejects.toThrow();
    await expect(facade.provider.send({ strict: true }, {} as any)).rejects.toThrow();
    expect(() => facade.resolver.resolve(route, 'https://example.com')).toThrow();
    facade.close();
    expect(() => facade.install({} as any)).toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});
