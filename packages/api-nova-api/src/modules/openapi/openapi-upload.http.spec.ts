import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
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
