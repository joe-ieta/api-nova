import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { CallObservabilityDeliveryWorker } from './call-observability-delivery.worker';

describe('webhook HTTP deadline remains bounded by the claim budget', () => {
  let server: Server;
  const worker = new CallObservabilityDeliveryWorker({} as any, new ConfigService(), {} as any);
  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('aborts a continuously dripping response at the absolute deadline', async () => {
    let chunks = 0;
    server = createServer((_request, response) => {
      response.writeHead(202);
      response.write('first');
      const timer = setInterval(() => { chunks++; response.write('still responding'); }, 15);
      response.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const destination = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
    await expect((worker as any).post(destination, { address: '127.0.0.1', family: 4 }, '{}', {}, 150))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(chunks).toBeGreaterThan(1);
  }, 5000);

  it('settles an interrupted response instead of leaving an active wave waiting forever', async () => {
    server = createServer((_request, response) => {
      response.writeHead(202, { 'content-length': '100' });
      response.write('partial');
      setImmediate(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const destination = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
    await expect((worker as any).post(destination, { address: '127.0.0.1', family: 4 }, '{}', {}, 1000))
      .rejects.toBeInstanceOf(Error);
  }, 5000);
});
