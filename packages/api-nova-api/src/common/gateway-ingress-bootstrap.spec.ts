import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { WebSocketGateway } from '@nestjs/websockets';
import { connect } from 'node:net';
import { Server } from 'node:http';
import { GatewayRouteSnapshotService } from '../modules/gateway-runtime/services/gateway-route-snapshot.service';
import { initializeGatewayHttpIngress } from './gateway-ingress-bootstrap';

@Controller()
class FixtureController {
  @Get('v1/gateway/:routePath(*)') gateway() { return 'ordinary-gateway'; }
  @Get('control') control() { return 'control'; }
}
@WebSocketGateway({ transports: ['websocket'] })
class FixtureSocketGateway {}
const fixtureRoutes = {
  ready: false,
  resolve: jest.fn(),
  onModuleInit() { this.ready = true; },
};
@Module({ controllers: [FixtureController], providers: [FixtureSocketGateway, { provide: GatewayRouteSnapshotService, useValue: fixtureRoutes }] })
class FixtureModule {}
function exchange(port: number, path: string, extra: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let output = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('fixture timeout')));
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${extra}\r\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.on('error', reject); socket.on('close', () => resolve(output));
  });
}
const expectation = 'Connection: close\r\nExpect: 100-continue\r\nContent-Length: 0\r\n';
describe('actual Nest and Socket.IO Gateway ingress bootstrap', () => {
  let app: INestApplication, port: number, server: Server;
  beforeEach(async () => {
    fixtureRoutes.ready = false;
    fixtureRoutes.resolve.mockReset().mockImplementation(() => {
      if (!fixtureRoutes.ready) throw new Error('routes-not-initialized');
      return { policies: { upstream: { compiledHeaderPolicy: { version: 1 } } } };
    });
    app = await NestFactory.create(FixtureModule, { logger: false, bodyParser: false });
    app.useWebSocketAdapter(new IoAdapter(app)); app.setGlobalPrefix('api');
    expect(fixtureRoutes.ready).toBe(false);
    await initializeGatewayHttpIngress(app);
    expect(fixtureRoutes.ready).toBe(true);
    server = app.getHttpServer(); expect(server.listening).toBe(false);
    expect(server.listenerCount('upgrade')).toBe(1);
    await app.listen(0, '127.0.0.1'); port = (server.address() as any).port;
  });
  afterEach(async () => { server?.closeAllConnections(); await app?.close(); });
  it.each(['100-continue', 'custom'])('rejects %s before any interim response after true app initialization', async value => {
    const result = await exchange(port, '/api/v1/gateway/orders', expectation.replace('100-continue', value));
    expect(result).toMatch(/^HTTP\/1\.1 417 /); expect(result).not.toContain('100 Continue');
    expect(result).not.toContain('ordinary-gateway');
    expect(fixtureRoutes.resolve).toHaveBeenCalledWith('localhost', 'GET', '/orders');
  });
  it('uses trusted compiled policy, ignoring spoofed policy headers and following active route changes', async () => {
    fixtureRoutes.resolve.mockReturnValue({ policies: { upstream: {} } });
    const legacy = await exchange(port, '/api/v1/gateway/orders', expectation + 'X-Apinova-Header-Policy: v1\r\n');
    expect(legacy).toContain('100 Continue'); expect(legacy).toContain('200 OK');
    fixtureRoutes.resolve.mockReturnValue({ policies: { upstream: { compiledHeaderPolicy: { version: 1 } } } });
    const active = await exchange(port, '/api/v1/gateway/orders', expectation + 'X-Apinova-Header-Policy: legacy\r\n');
    expect(active).toMatch(/^HTTP\/1\.1 417 /);
  });
  it.each([['/API/V1/GaTeWaY/a%2Fb?x=1', '/a/b'], ['/api/v1/gateway/a/../b', '/a/../b'], ['http://localhost/api/v1/gateway/a%2Fb?x=1', '/a/b']])('matches Express wildcard parsing for %s', async (path, expected) => {
    expect(await exchange(port, path, expectation)).toMatch(/^HTTP\/1\.1 417 /);
    expect(fixtureRoutes.resolve).toHaveBeenCalledWith('localhost', 'GET', expected);
  });
  it('fails closed for malformed wildcard encoding and route lookup failure', async () => {
    expect(await exchange(port, '/api/v1/gateway/%zz', expectation)).toMatch(/^HTTP\/1\.1 503 /);
    fixtureRoutes.resolve.mockImplementation(() => { throw new Error('private-detail'); });
    const output = await exchange(port, '/api/v1/gateway/orders', expectation);
    expect(output).toMatch(/^HTTP\/1\.1 503 /); expect(output).not.toContain('private-detail');
  });
  it('preserves control-plane Node continue behavior without resolving Gateway policy', async () => {
    const output = await exchange(port, '/api/control', expectation);
    expect(output).toContain('100 Continue'); expect(output).toContain('200 OK');
    expect(fixtureRoutes.resolve).not.toHaveBeenCalled();
  });
  it('rejects Gateway upgrade while an actual Socket.IO websocket handshake still succeeds', async () => {
    const upgrade = await exchange(port, '/api/v1/gateway/orders', 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n');
    expect(upgrade).toMatch(/^HTTP\/1\.1 400 /);
    const WebSocket = require('ws');
    const client = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const message = await new Promise<string>((resolve, reject) => { client.once('message', (value: Buffer) => resolve(value.toString())); client.once('error', reject); });
    expect(message).toMatch(/^0\{/); expect(JSON.parse(message.slice(1)).sid).toBeTruthy();
    await new Promise<void>(resolve => { client.once('close', resolve); client.close(); });
  });
});
