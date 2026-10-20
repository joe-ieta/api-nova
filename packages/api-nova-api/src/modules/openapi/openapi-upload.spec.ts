import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as http from 'node:http';
import { AppConfigService } from '../../config/app-config.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { OpenAPIController } from './openapi.controller';
import { OpenAPIService } from './services/openapi.service';

describe('OpenAPI multipart dependency and parsing limits', () => {
  let app: INestApplication;
  let limit: string;
  let limitReads: number;
  const service = {
    parseOpenAPI: jest.fn(async () => ({ endpoints: [] })),
    validateOpenAPI: jest.fn(async () => ({ valid: true })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OpenAPIController],
      providers: [
        { provide: OpenAPIService, useValue: service },
        { provide: AppConfigService, useValue: {
          get maxOpenAPIFileSize() { limitReads++; return limit; },
          isProduction: true, debugMode: false,
        } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      // Synthetic authorization only; JWT cryptography has its own guard tests.
      canActivate(context) {
        if (context.switchToHttp().getRequest().headers.authorization !== 'Bearer synthetic')
          throw new UnauthorizedException();
        return true;
      },
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => { limit = '64B'; limitReads = 0; jest.clearAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it('retains JWT metadata and rejects before multipart/configuration processing', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OpenAPIController)).toContain(JwtAuthGuard);
    await request(app.getHttpServer()).post('/openapi/upload')
      .attach('file', Buffer.alloc(128), { filename: 'api.json', contentType: 'application/json' })
      .expect(401);
    expect(limitReads).toBe(0);
    expect(service.parseOpenAPI).not.toHaveBeenCalled();
  });
  for (const endpoint of ['upload', 'validate-upload']) {
    it(`${endpoint}: accepts one bounded JSON file`, async () => {
      await request(app.getHttpServer()).post(`/openapi/${endpoint}`).auth('synthetic', { type: 'bearer' })
        .attach('file', Buffer.from('{}'), { filename: 'api.json', contentType: 'application/json' })
        .expect(200);
      expect(service[endpoint === 'upload' ? 'parseOpenAPI' : 'validateOpenAPI']).toHaveBeenCalledTimes(1);
    });
    it(`${endpoint}: rejects excessive bytes before the business parser`, async () => {
      await request(app.getHttpServer()).post(`/openapi/${endpoint}`).auth('synthetic', { type: 'bearer' })
        .attach('file', Buffer.alloc(65), { filename: 'api.json', contentType: 'application/json' })
        .expect(413);
      expect(service.parseOpenAPI).not.toHaveBeenCalled();
      expect(service.validateOpenAPI).not.toHaveBeenCalled();
    });
  }
  it('rejects extra files and unexpected fields before parsing', async () => {
    await request(app.getHttpServer()).post('/openapi/upload').auth('synthetic', { type: 'bearer' })
      .attach('file', Buffer.from('{}'), 'a.json').attach('file', Buffer.from('{}'), 'b.json').expect(400);
    await request(app.getHttpServer()).post('/openapi/upload').auth('synthetic', { type: 'bearer' })
      .field('data[999999999]', 'x').expect(400);
    expect(service.parseOpenAPI).not.toHaveBeenCalled();
  });
  for (const invalid of ['0B', 'not-a-size', '999999999999999999GB']) {
    it(`fails closed for invalid configured limit ${invalid}`, async () => {
      limit = invalid;
      await request(app.getHttpServer()).post('/openapi/upload').auth('synthetic', { type: 'bearer' })
        .attach('file', Buffer.from('{}'), 'api.json').expect(500);
      expect(service.parseOpenAPI).not.toHaveBeenCalled();
    });
  }
  it('handles an aborted multipart request without parsing and serves the next request', async () => {
    const server = app.getHttpServer(), boundary = 'np02-boundary';
    let onRequest: (req: http.IncomingMessage) => void;
    const aborted = new Promise<void>(resolve => {
      onRequest = req => req.once('aborted', resolve);
      server.once('request', onRequest);
    });
    const client = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: '/openapi/upload', method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    client.on('error', () => undefined);
    try {
      client.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="api.json"\r\nContent-Type: application/json\r\n\r\n{`);
      await new Promise<void>(resolve => server.once('request', () => resolve()));
      client.destroy();
      await aborted;
      expect(service.parseOpenAPI).not.toHaveBeenCalled();
      await request(server).post('/openapi/upload').auth('synthetic', { type: 'bearer' })
        .attach('file', Buffer.from('{}'), { filename: 'api.json', contentType: 'application/json' }).expect(200);
    } finally { client.destroy(); server.removeListener('request', onRequest); }
  });
});
