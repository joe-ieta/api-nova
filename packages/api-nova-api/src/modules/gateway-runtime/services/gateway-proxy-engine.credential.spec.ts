import { GatewayProxyEngineService } from './gateway-proxy-engine.service';

describe('GatewayProxyEngineService runtime credentials', () => {
  const service = new GatewayProxyEngineService({ createTracker: jest.fn() } as any);

  it('overrides consumer credentials with environment-backed upstream credentials', () => {
    const previous = process.env.UPSTREAM_ORDER_TOKEN;
    process.env.UPSTREAM_ORDER_TOKEN = 'Bearer upstream-secret';
    try {
      const headers = (service as any).buildForwardHeaders(
        { authorization: 'Bearer consumer-token', host: 'gateway.example' },
        new URL('https://orders.example/api'),
        { headers: { host: 'gateway.example' }, protocol: 'https', socket: { remoteAddress: '127.0.0.1' } },
        'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
      );
      expect(headers.authorization).toBe('Bearer upstream-secret');
      expect(headers.host).toBe('orders.example');
    } finally {
      if (previous === undefined) delete process.env.UPSTREAM_ORDER_TOKEN;
      else process.env.UPSTREAM_ORDER_TOKEN = previous;
    }
  });
});
