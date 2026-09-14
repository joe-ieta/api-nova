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

  const forwardHeaders = (headers: Record<string, any>, credentialRef?: string) =>
    (service as any).buildForwardHeaders(headers, new URL('https://orders.example/api'), {
      headers, protocol: 'https', socket: { remoteAddress: '127.0.0.1' },
    }, credentialRef) as Record<string, string>;

  it.each([
    ['mixed case', ' X-Hop-A, x-HOP-b '],
    ['duplicates and empty tokens', 'x-hop-a,X-HOP-A,, x-hop-b,'],
    ['multiple connection values', ['keep-alive, X-Hop-A', 'x-hop-b, X-HOP-A']],
  ])('strips connection-nominated headers: %s', (_label, connection) => {
    const output = forwardHeaders({
      connection, 'X-Hop-A': 'hop-a', 'x-hop-b': 'hop-b', trailer: 'X-Checksum',
      'keep-alive': 'timeout=5', te: 'trailers', 'transfer-encoding': 'chunked',
      upgrade: 'websocket', 'x-business': 'preserved', accept: 'application/json',
      host: 'gateway.example',
    });
    for (const name of ['connection', 'x-hop-a', 'x-hop-b', 'trailer', 'keep-alive', 'te', 'transfer-encoding', 'upgrade']) {
      expect(Object.keys(output).map(key => key.toLowerCase())).not.toContain(name);
    }
    expect(output['x-business']).toBe('preserved');
    expect(output.accept).toBe('application/json');
    expect(output.host).toBe('orders.example');
    expect(output['x-forwarded-host']).toBe('gateway.example');
    expect(output['x-forwarded-for']).toBe('127.0.0.1');
    expect(output['x-forwarded-proto']).toBe('https');
  });

  it('strips consumer credentials and standard trailer without Connection', () => {
    const output = forwardHeaders({
      Authorization: 'Bearer consumer-token', 'Proxy-Authorization': 'Basic consumer-proxy',
      'X-API-Key': 'consumer-key', Cookie: 'session=consumer', Trailer: 'X-Checksum',
      'content-type': 'application/json', 'x-business': 'preserved',
    });
    for (const name of ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'trailer']) {
      expect(Object.keys(output).map(key => key.toLowerCase())).not.toContain(name);
    }
    expect(output['content-type']).toBe('application/json');
    expect(output['x-business']).toBe('preserved');
    expect(JSON.stringify(output)).not.toContain('consumer');
  });

  it('injects trusted environment headers after stripping Connection-controlled input', () => {
    const previous = process.env.GATEWAY_HEADER_TEST_SECRET;
    process.env.GATEWAY_HEADER_TEST_SECRET = 'trusted-upstream-value';
    try {
      const output = forwardHeaders({
        connection: ['Authorization, X-API-Key', 'x-trusted, COOKIE, x-TRUSTED'],
        authorization: 'consumer-token', 'x-api-key': 'consumer-key',
        'x-trusted': 'consumer-controlled', cookie: 'consumer-session', 'x-business': 'preserved',
      }, 'env-headers:Authorization=GATEWAY_HEADER_TEST_SECRET;X-API-Key=GATEWAY_HEADER_TEST_SECRET;X-Trusted=GATEWAY_HEADER_TEST_SECRET');
      expect(output.authorization).toBe('trusted-upstream-value');
      expect(output['x-api-key']).toBe('trusted-upstream-value');
      expect(output['x-trusted']).toBe('trusted-upstream-value');
      expect(output).not.toHaveProperty('cookie');
      expect(output).not.toHaveProperty('connection');
      expect(output['x-business']).toBe('preserved');
      expect(JSON.stringify(output)).not.toContain('consumer');
    } finally {
      if (previous === undefined) delete process.env.GATEWAY_HEADER_TEST_SECRET;
      else process.env.GATEWAY_HEADER_TEST_SECRET = previous;
    }
  });
});
