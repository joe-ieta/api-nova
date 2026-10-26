import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { request as httpRequest, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppConfigService } from '../../config/app-config.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { OpenAPIController } from './openapi.controller';
import { OpenAPIService } from './services/openapi.service';

// Real HTTP, production controller and Nest multipart interceptor. Parsing services
// and identity are fixture boundaries; this is not a JWT or OpenAPI parser test.
describe('OpenAPI multipart admission with configured file limits', () => {
  let app: INestApplication;
  const config = { maxOpenAPIFileSize: '1KB', isProduction: true, debugMode: false };
  const service = {
    parseOpenAPI: jest.fn(async (_dto: { source: { content: string } }) => ({ endpoints: [] })),
    validateOpenAPI: jest.fn(async (_dto: { source: { content: string } }) => ({ valid: true })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OpenAPIController],
      providers: [
        { provide: AppConfigService, useValue: config },
        { provide: OpenAPIService, useValue: service },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate(context) {
        if (context.switchToHttp().getRequest().headers.authorization !== 'Bearer fixture') {
          throw new UnauthorizedException();
        }
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => app?.close());
  beforeEach(() => { config.maxOpenAPIFileSize = '1KB'; jest.clearAllMocks(); });

  for (const [route, method] of [['upload', 'parseOpenAPI'], ['validate-upload', 'validateOpenAPI']] as const) {
    it(`${route} accepts the existing inclusive boundary with unchanged content`, async () => {
      const content = '{}'.padEnd(1024, ' ');
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.from(content), { filename: 'spec.json', contentType: 'application/json' })
        .expect(200);
      expect(service[method]).toHaveBeenCalledTimes(1);
      expect(service[method].mock.calls[0][0].source.content).toBe(content);
    });
    it(`${route} rejects at the multipart layer before invoking its parser`, async () => {
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.alloc(1025, 32), { filename: 'spec.json', contentType: 'application/json' })
        .expect(413);
      expect(service[method]).not.toHaveBeenCalled();
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.from('{}'), { filename: 'spec.json', contentType: 'application/json' })
        .expect(200);
    });
    it(`${route} rejects unexpected and crafted text fields before business parsing`, async () => {
      for (const field of ['unused', 'a[4294967295]', 'a' + '[x]'.repeat(200)]) {
        await request(app.getHttpServer()).post(`/openapi/${route}`)
          .set('Authorization', 'Bearer fixture').field(field, 'value')
          .attach('file', Buffer.from('{}'), { filename: 'spec.json', contentType: 'application/json' })
          .expect(400);
      }
      expect(service[method]).not.toHaveBeenCalled();
    });
    it(`${route} rejects a second file and malformed multipart, then recovers`, async () => {
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.from('{}'), { filename: 'a.json', contentType: 'application/json' })
        .attach('file', Buffer.from('{}'), { filename: 'b.json', contentType: 'application/json' })
        .expect(400);
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture').set('Content-Type', 'multipart/form-data; boundary=fixture')
        .send('--fixture\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{}')
        .expect(400);
      expect(service[method]).not.toHaveBeenCalled();
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.from('{}'), { filename: 'good.json', contentType: 'application/json' })
        .expect(200);
    });
    it(`${route} survives a real client abort during upload and accepts a subsequent file`, async () => {
      const server = app.getHttpServer() as Server;
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('aborted upload did not close')), 3000);
        server.once('request', req => {
          req.once('aborted', () => { clearTimeout(timer); resolve(); });
          req.once('data', () => client.destroy());
        });
        const client = httpRequest({ host: '127.0.0.1', port, path: `/openapi/${route}`, method: 'POST', headers: {
          Authorization: 'Bearer fixture', 'Content-Type': 'multipart/form-data; boundary=fixture',
          'Content-Length': 2048,
        } });
        client.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
        client.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n' + ' '.repeat(512));
      });
      expect(service[method]).not.toHaveBeenCalled();
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.from('{}'), { filename: 'after-abort.json', contentType: 'application/json' })
        .expect(200);
    });
    it(`${route} uses the current configured limit on each request`, async () => {
      config.maxOpenAPIFileSize = '2KB';
      await request(app.getHttpServer()).post(`/openapi/${route}`)
        .set('Authorization', 'Bearer fixture')
        .attach('file', Buffer.alloc(1536, 32), { filename: 'spec.json', contentType: 'application/json' })
        .expect(200);
    });
  }
  it('keeps authentication before multipart parsing', async () => {
    await request(app.getHttpServer()).post('/openapi/upload')
      .attach('file', Buffer.alloc(1025), { filename: 'spec.json', contentType: 'application/json' })
      .expect(401);
    expect(service.parseOpenAPI).not.toHaveBeenCalled();
  });
  it('fails closed for an invalid configured size', async () => {
    config.maxOpenAPIFileSize = 'not-a-size';
    await request(app.getHttpServer()).post('/openapi/upload')
      .set('Authorization', 'Bearer fixture')
      .attach('file', Buffer.from('{}'), { filename: 'spec.json', contentType: 'application/json' })
      .expect(500);
    expect(service.parseOpenAPI).not.toHaveBeenCalled();
  });
});
