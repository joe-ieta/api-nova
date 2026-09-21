import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { GatewayConsumerCredentialEntity, GatewayConsumerCredentialStatus } from '../../../database/entities/gateway-consumer-credential.entity';
import { RuntimeCredentialRotationService } from '../../runtime-assets/services/runtime-credential-rotation.service';
import { GatewaySecurityService } from './gateway-security.service';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// The read is paused only after a real SQL query. Rotation/revocation commits to
// that same database before the real authorize flow writes its usage timestamp.
describe('Gateway credential usage preserves concurrent security changes', () => {
  let db: DataSource, repo: Repository<GatewayConsumerCredentialEntity>;
  let credential: GatewayConsumerCredentialEntity, service: GatewaySecurityService;
  let oldScopes: string | undefined;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const route: any = { policies: { auth: { mode: 'api_key' } }, runtimeAsset: { id: 'runtime' },
    routeBinding: { id: 'route', routeVisibility: 'external' } };
  const request = (key = 'original.secret'): any => ({ headers: { 'x-api-key': key }, socket: { remoteAddress: '127.0.0.1' } });

  beforeEach(async () => {
    oldScopes = process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    db = await new DataSource({ type: 'sqljs', synchronize: true, entities: [GatewayConsumerCredentialEntity] }).initialize();
    repo = db.getRepository(GatewayConsumerCredentialEntity);
    credential = await repo.save(repo.create({ name: 'usage-race', keyId: 'original', runtimeAssetId: 'runtime',
      status: GatewayConsumerCredentialStatus.ACTIVE, secretHash: createHash('sha256').update('secret').digest('hex'),
      accessPolicy: { version: 1, subject: 'caller', protocols: ['gateway', 'mcp'], scopes: [], toolScopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
    service = new GatewaySecurityService(audit as any, repo);
  });
  afterEach(async () => {
    jest.restoreAllMocks(); await db.destroy();
    if (oldScopes === undefined) delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    else process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = oldScopes;
  });

  it.each(['revoke', 'rotate'] as const)('does not overwrite a committed %s when a stale request records usage', async operation => {
    const readFinished = gate(), resumeRead = gate();
    const actualFindOne = repo.findOne.bind(repo);
    jest.spyOn(repo, 'findOne').mockImplementationOnce(async options => {
      const stale = await actualFindOne(options);
      readFinished.release();
      await resumeRead.promise;
      return stale;
    });
    const pending = service.authorize(route, request());
    await readFinished.promise;
    let committed: GatewayConsumerCredentialEntity;
    let successorKey: string | undefined;
    try {
      if (operation === 'revoke') {
        await repo.update(credential.id, { status: GatewayConsumerCredentialStatus.REVOKED });
      } else {
        const rotated = await new RuntimeCredentialRotationService(repo, audit as any)
          .rotate('runtime', credential.id, 0, 'trusted-admin');
        successorKey = rotated.apiKey;
      }
      committed = await repo.findOneByOrFail({ id: credential.id });
    } finally { resumeRead.release(); }
    // This already admitted request may finish; new requests must observe the commit.
    await expect(pending).resolves.toMatchObject({ consumerId: credential.id });
    const afterUsage = await repo.findOneByOrFail({ id: credential.id });
    expect(afterUsage.lastUsedAt).toBeInstanceOf(Date);
    expect(afterUsage.status).toBe(committed!.status);
    expect(afterUsage.accessPolicy).toEqual(committed!.accessPolicy);
    if (operation === 'rotate') {
      expect(afterUsage.accessPolicy.rotationSuccessorId).toBeDefined();
      expect(afterUsage.accessPolicy.validUntil).toEqual(expect.any(Number));
      await expect(service.authorize(route, request(successorKey))).resolves.toMatchObject({ mode: 'api_key' });
    }
    await expect(service.authorize(route, request())).rejects.toMatchObject({ status: 401 });
  });
});
