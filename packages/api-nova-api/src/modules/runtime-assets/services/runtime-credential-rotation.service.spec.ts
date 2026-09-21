import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { RuntimeCredentialRotationService } from './runtime-credential-rotation.service';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';
import { toRuntimeAccessCredential } from './runtime-access-credential';
import { verifyRuntimeAccessCredential } from 'api-nova-parser';

describe('persisted credential rotation transaction', () => {
  let db: DataSource;
  let service: RuntimeCredentialRotationService;
  const audit = { log: jest.fn(async (_input?: any, _manager?: any) => {}) };
  let old: GatewayConsumerCredentialEntity;
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', synchronize: true, entities: [GatewayConsumerCredentialEntity] }).initialize();
    audit.log.mockReset().mockResolvedValue(undefined);
    service = new RuntimeCredentialRotationService(db.getRepository(GatewayConsumerCredentialEntity), audit as any);
    old = await db.getRepository(GatewayConsumerCredentialEntity).save({ name: 'rotation', keyId: 'original',
      secretHash: createHash('sha256').update('secret').digest('hex'), runtimeAssetId: 'runtime',
      accessPolicy: { version: 1, subject: 'worker', protocols: ['gateway', 'mcp'], scopes: ['read'], toolScopes: ['read'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  });
  afterEach(async () => { await db.destroy(); });
  it('keeps stable subject and authority, overlaps only until cutoff and persists the family', async () => {
    const result = await service.rotate('runtime', old.id, 60, 'trusted-actor');
    const rows = await db.getRepository(GatewayConsumerCredentialEntity).find();
    const predecessor = rows.find(row => row.id === old.id)!;
    const successor = rows.find(row => row.id !== old.id)!;
    expect(successor.accessPolicy).toMatchObject({ subject: 'worker', scopes: ['read'], rotationFamilyId: old.id, actorId: 'trusted-actor' });
    expect(JSON.stringify(rows)).not.toContain(result.apiKey);
    expect(JSON.stringify(audit.log.mock.calls.map(call => call[0]))).not.toContain(result.apiKey);
    for (const protocol of ['gateway', 'mcp'] as const) {
      const context = { protocol, runtimeAssetId: 'runtime', now: Number(result.overlapEndsAt) - 1 };
      const first = verifyRuntimeAccessCredential('original.secret', toRuntimeAccessCredential(predecessor), context);
      const second = verifyRuntimeAccessCredential(result.apiKey, toRuntimeAccessCredential(successor), context);
      expect(second.callerId).toBe(first.callerId);
      expect(second.credentialId).not.toBe(first.credentialId);
      expect(() => verifyRuntimeAccessCredential('original.secret', toRuntimeAccessCredential(predecessor),
        { ...context, now: Number(result.overlapEndsAt) })).toThrow('invalid_api_key');
    }
    await expect(service.rotate('runtime', old.id, 60)).rejects.toMatchObject({ status: 409 });
    const next = await service.rotate('runtime', successor.id, 0);
    expect(next.credential.accessPolicy.rotationFamilyId).toBe(old.id);
  });
  it('rolls both keys back if transactional audit fails', async () => {
    audit.log.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.rotate('runtime', old.id, 1)).rejects.toThrow('audit unavailable');
    expect(await db.getRepository(GatewayConsumerCredentialEntity).count()).toBe(1);
    expect((await db.getRepository(GatewayConsumerCredentialEntity).findOneByOrFail({ id: old.id })).accessPolicy.rotationSuccessorId).toBeUndefined();
  });
  it.each([-1, 86401, 1.5, NaN, undefined])('rejects invalid overlap %s', async overlap => {
    await expect(service.rotate('runtime', old.id, overlap as number)).rejects.toMatchObject({ status: 400 });
    expect(await db.getRepository(GatewayConsumerCredentialEntity).count()).toBe(1);
  });
  it('rejects foreign runtime, expired and legacy credentials', async () => {
    await expect(service.rotate('other', old.id, 0)).rejects.toMatchObject({ status: 404 });
    old.accessPolicy.expiresAt = 1; await db.getRepository(GatewayConsumerCredentialEntity).save(old);
    await expect(service.rotate('runtime', old.id, 0)).rejects.toMatchObject({ status: 409 });
    old.accessPolicy = null; await db.getRepository(GatewayConsumerCredentialEntity).save(old);
    await expect(service.rotate('runtime', old.id, 0)).rejects.toMatchObject({ status: 409 });
  });
});
