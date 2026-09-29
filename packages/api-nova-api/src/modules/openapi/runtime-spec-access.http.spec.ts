import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import request = require('supertest');
import { AppConfigService } from '../../config/app-config.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AuthService } from '../security/services/auth.service';
import { AuditService } from '../security/services/audit.service';
import { RuntimeSpecAccessService } from '../security/services/runtime-spec-access.service';
import { UserService } from '../security/services/user.service';
import { JwtStrategy } from '../security/strategies/jwt.strategy';
import { RuntimeSpecAccessGuard } from './guards/runtime-spec-access.guard';
import { RuntimeSpecAccessController } from './runtime-spec-access.controller';
import { OpenAPIService } from './services/openapi.service';

const secret = 'runtime-spec-http-fixture-management-secret-0123456789';
const ownAsset = '00000000-0000-0000-0000-0000000000a1';
const foreignAsset = '00000000-0000-0000-0000-0000000000b2';
const serverId = '00000000-0000-0000-0000-0000000000c3';
const adminUser = { id: 'user-1', email: 'admin@example.invalid', isActive: true, isLocked: false };

describe('runtime spec access over real HTTP', () => {
  let app: any;
  let specAccess: RuntimeSpecAccessService;
  let audit: { log: jest.Mock };
  const clock = { value: 1_000_000 };
  const user = { ...adminUser };

  beforeAll(async () => {
    audit = { log: jest.fn(async () => undefined) };
    specAccess = new RuntimeSpecAccessService(
      { get: (key: string) => (key === 'JWT_SECRET' ? secret : undefined) } as unknown as ConfigService,
      { now: () => clock.value },
    );
    const openApiService = {
      getOpenApiByRuntimeAssetId: jest.fn(async (runtimeAssetId: string) => ({
        openapi: '3.0.3',
        info: { title: `spec-${runtimeAssetId}`, version: '1' },
        paths: { '/ping': { get: { operationId: 'ping', responses: { 200: { description: 'OK' } } } } },
      })),
    };
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [RuntimeSpecAccessController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RuntimeSpecAccessGuard,
        { provide: RuntimeSpecAccessService, useValue: specAccess },
        { provide: OpenAPIService, useValue: openApiService },
        { provide: AuditService, useValue: audit },
        { provide: AppConfigService, useValue: { debugMode: false, isProduction: true } },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: UserService, useValue: { findUserById: async (id: string) => (id === user.id ? user : null) } },
        { provide: AuthService, useValue: { auditService: { logApiAccess: jest.fn(async () => undefined) } } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    audit.log.mockClear();
    clock.value = 1_000_000;
  });

  const url = (runtimeAssetId: string) => `/api/openapi/by-runtime-asset/${runtimeAssetId}`;

  it('denies anonymous and invalid credentials', async () => {
    await request(app.getHttpServer()).get(url(ownAsset)).expect(401);
    await request(app.getHttpServer()).get(url(ownAsset)).set('x-api-key', 'not-a-token').expect(401);
    const foreign = specAccess.mint({ runtimeAssetId: foreignAsset, serverId });
    await request(app.getHttpServer()).get(url(ownAsset)).set('x-api-key', foreign).expect(403);
    const expired = specAccess.mint({ runtimeAssetId: ownAsset, serverId, ttlSeconds: 1 });
    clock.value = 1_002_000;
    await request(app.getHttpServer()).get(url(ownAsset)).set('x-api-key', expired).expect(401);
  });

  it('allows the owning runtime asset credential and records sanitized audit metadata', async () => {
    const token = specAccess.mint({ runtimeAssetId: ownAsset, serverId });
    const response = await request(app.getHttpServer()).get(url(ownAsset)).set('x-api-key', token).expect(200);
    expect(response.body.info.title).toBe(`spec-${ownAsset}`);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({ resource: 'openapi.spec_access', resourceId: ownAsset });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('keeps the management JWT path working and rejecting invalid bearer tokens', async () => {
    const management = sign({ sub: user.id, email: user.email, roles: ['admin'], permissions: [] }, secret, { expiresIn: '5m' });
    const allowed = await request(app.getHttpServer()).get(url(foreignAsset)).set('authorization', `Bearer ${management}`).expect(200);
    expect(allowed.body.info.title).toBe(`spec-${foreignAsset}`);
    await request(app.getHttpServer()).get(url(ownAsset)).set('authorization', 'Bearer not.a.jwt').expect(401);
  });
});
