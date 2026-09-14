import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { randomUUID } from 'crypto';
import { sign } from 'jsonwebtoken';
import request = require('supertest');
import { JwtStrategy } from '../security/strategies/jwt.strategy';
import { UserService } from '../security/services/user.service';
import { AuthService } from '../security/services/auth.service';
import { GatewayUpstreamCredentialAdminController } from './gateway-upstream-credential-admin.controller';
import { GatewayUpstreamCredentialAdminService } from './services/gateway-upstream-credential-admin.service';

const secret = 'fixture-management-secret-'.repeat(3);
describe('credential management HTTP authentication and fresh permissions', () => {
  let app: any, user: any, permissions: Set<string>, admin: any, token: string;
  beforeEach(async () => {
    user = { id: randomUUID(), isActive: true, isLocked: false, hasRole: () => false };
    permissions = new Set(['config:read', 'config:update']);
    admin = { status: jest.fn(() => ({ configured: true, generation: 1 })), reload: jest.fn(async () => ({ generation: 2 })) };
    const module = await Test.createTestingModule({ imports: [PassportModule],
      controllers: [GatewayUpstreamCredentialAdminController], providers: [JwtStrategy,
        { provide: GatewayUpstreamCredentialAdminService, useValue: admin },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: UserService, useValue: { findUserById: async (id: string) => id === user.id ? user : null } },
        { provide: AuthService, useValue: { checkPermission: async (_id: string, permission: string) => permissions.has(permission) } },
      ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useLogger(false); await app.init();
    token = sign({ sub: user.id, permissions: ['config:read', 'config:update'] }, secret, { expiresIn: '5m' });
  });
  afterEach(async () => { await app?.close(); });
  it('requires a management JWT and rejects a token signed with an unrelated secret', async () => {
    await request(app.getHttpServer()).get('/api/security/upstream-credentials/status').expect(401);
    await request(app.getHttpServer()).post('/api/security/upstream-credentials/reload')
      .set('Authorization', 'Bearer ' + sign({ sub: user.id }, 'unrelated-runtime-secret')).send({}).expect(401);
    expect(admin.reload).not.toHaveBeenCalled();
  });
  it('requires distinct config permissions and rechecks current permissions for an existing JWT', async () => {
    await request(app.getHttpServer()).get('/api/security/upstream-credentials/status').set('Authorization', 'Bearer ' + token).expect('Cache-Control', 'no-store').expect(200);
    permissions.delete('config:update');
    await request(app.getHttpServer()).post('/api/security/upstream-credentials/reload')
      .set('Authorization', 'Bearer ' + token).send({ expectedGeneration: 1, reason: 'fixture' }).expect(403);
    permissions.clear();
    await request(app.getHttpServer()).get('/api/security/upstream-credentials/status').set('Authorization', 'Bearer ' + token).expect(403);
    expect(admin.reload).not.toHaveBeenCalled();
  });
  it('uses authenticated actor for reload and rejects a newly disabled user', async () => {
    const body = { expectedGeneration: 1, reason: 'fixture' };
    await request(app.getHttpServer()).post('/api/security/upstream-credentials/reload')
      .set('Authorization', 'Bearer ' + token).send(body).expect('Cache-Control', 'no-store').expect(200);
    expect(admin.reload).toHaveBeenCalledWith(body, user.id);
    user.isActive = false;
    await request(app.getHttpServer()).get('/api/security/upstream-credentials/status').set('Authorization', 'Bearer ' + token).expect(401);
  });
});
