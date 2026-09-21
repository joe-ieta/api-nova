import { createServer, Server } from 'node:http';
import { connect } from 'node:net';
import { AddressInfo } from 'node:net';
import { installGatewayHttpIngressBoundary } from './gateway-http-ingress-boundary';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('TCP fixture timeout')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
  });
}
function wire(path: string, extra: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`;
}

describe('Gateway raw HTTP expectation and upgrade boundary', () => {
  const servers: Server[] = [];
  function server(): { server: Server; upstream: jest.Mock } {
    const upstream = jest.fn((_req, res) => { res.end('ordinary-response'); });
    const result = createServer(upstream);
    servers.push(result);
    return { server: result, upstream };
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((value) => new Promise<void>((resolve) => {
      value.closeAllConnections();
      value.close(() => resolve());
    })));
  });

  it.each(['100-continue', 'custom-expectation'])('rejects %s before any interim 100 or application request', async (expectation) => {
    const fixture = server();
    const prior = jest.fn((_req, res) => { res.writeContinue(); res.end('unsafe'); });
    fixture.server.on('checkContinue', prior);
    fixture.server.on('checkExpectation', prior);
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const response = await exchange(await listen(fixture.server), wire('/api/v1/gateway/resource', `Expect: ${expectation}\r\nContent-Length: 0\r\n`));
    expect(response).toMatch(/^HTTP\/1\.1 417 /);
    expect(response).not.toContain('100 Continue');
    expect(response).toContain('gateway_expectation_not_supported');
    expect(prior).not.toHaveBeenCalled();
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('matches the case-insensitive Express gateway prefix before sending 100', async () => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const response = await exchange(await listen(fixture.server), wire('/API/V1/GaTeWaY/resource', 'Expect: 100-continue\r\nContent-Length: 0\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 417 /);
    expect(response).not.toContain('100 Continue');
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('does not require the client to send a promised body before rejecting', async () => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const response = await exchange(await listen(fixture.server), wire('/api/v1/gateway/resource', 'Expect: 100-continue\r\nContent-Length: 100\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 417 /);
    expect(response).not.toContain('100 Continue');
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/other', '/api/v1/gateway-evil/resource'])('preserves Node continue behavior outside the gateway (%s)', async (path) => {
    const fixture = server();
    const policy = jest.fn(() => true);
    installGatewayHttpIngressBoundary(fixture.server, policy);
    const response = await exchange(await listen(fixture.server), wire(path, 'Expect: 100-continue\r\nContent-Length: 0\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 100 Continue/);
    expect(response).toContain('200 OK');
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    expect(policy).not.toHaveBeenCalled();
  });

  it('preserves legacy continue behavior and ordinary v1 requests', async () => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, (request) => request.url!.includes('/v1-route'));
    const port = await listen(fixture.server);
    expect(await exchange(port, wire('/api/v1/gateway/legacy', 'Expect: 100-continue\r\nContent-Length: 0\r\n'))).toContain('100 Continue');
    expect(await exchange(port, wire('/api/v1/gateway/v1-route', ''))).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
  });

  it('preserves existing non-gateway expectation handlers without also emitting request', async () => {
    const fixture = server();
    const prior = jest.fn((_req, res) => { res.statusCode = 202; res.end('handled'); });
    fixture.server.on('checkExpectation', prior);
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const response = await exchange(await listen(fixture.server), wire('/api/v1/other', 'Expect: custom\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 202 /);
    expect(prior).toHaveBeenCalledTimes(1);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('preserves once handlers then returns to Node default continue behavior', async () => {
    const fixture = server();
    const prior = jest.fn((_req, res) => { res.statusCode = 202; res.end('once'); });
    fixture.server.once('checkContinue', prior);
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const port = await listen(fixture.server);
    const request = wire('/api/v1/other', 'Expect: 100-continue\r\nContent-Length: 0\r\n');
    expect(await exchange(port, request)).toMatch(/^HTTP\/1\.1 202 /);
    expect(await exchange(port, request)).toContain('100 Continue');
    expect(prior).toHaveBeenCalledTimes(1);
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
  });

  it('rejects v1 upgrades before existing websocket handler, while preserving other upgrades', async () => {
    const fixture = server();
    const prior = jest.fn((_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n', () => socket.destroy()));
    fixture.server.on('upgrade', prior);
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    const port = await listen(fixture.server);
    const upgrade = (path: string) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;
    expect(await exchange(port, upgrade('/api/v1/gateway/resource'))).toMatch(/^HTTP\/1\.1 400 /);
    expect(prior).not.toHaveBeenCalled();
    expect(await exchange(port, upgrade('/socket.io/'))).toMatch(/^HTTP\/1\.1 101 /);
    expect(prior).toHaveBeenCalledTimes(1);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('fails closed on policy lookup failure without invoking application', async () => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, () => { throw Error('synthetic secret'); });
    const response = await exchange(await listen(fixture.server), wire('/api/v1/gateway/resource', 'Expect: 100-continue\r\nContent-Length: 0\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 503 /);
    expect(response).not.toContain('synthetic secret');
    expect(response).not.toContain('100 Continue');
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved false promise', () => Promise.resolve(false)],
    ['rejected promise', () => Promise.reject(new Error('synthetic-secret'))],
    ['nonboolean value', () => 'false'],
  ])('fails closed for a miswired %s predicate', async (_name, policy) => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, policy as any);
    const response = await exchange(await listen(fixture.server), wire('/api/v1/gateway/resource', 'Expect: 100-continue\r\nContent-Length: 0\r\n'));
    expect(response).toMatch(/^HTTP\/1\.1 503 /);
    expect(response).not.toContain('100 Continue');
    expect(response).not.toContain('synthetic-secret');
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('rejects late competing listeners and repeated/after-listen installation', async () => {
    const fixture = server();
    installGatewayHttpIngressBoundary(fixture.server, () => true);
    for (const event of ['checkContinue', 'checkExpectation', 'upgrade']) {
      expect(() => fixture.server.on(event, () => undefined)).toThrow('gateway_ingress_boundary_late_listener');
      expect(fixture.server.listenerCount(event)).toBe(1);
    }
    expect(() => installGatewayHttpIngressBoundary(fixture.server, () => true)).toThrow('installation_order');
    const live = server();
    await listen(live.server);
    expect(() => installGatewayHttpIngressBoundary(live.server, () => true)).toThrow('installation_order');
  });
});
