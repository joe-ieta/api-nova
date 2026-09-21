import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';

describe('private database credential resolver capability', () => {
  let db: DataSource;
  let resolver: RuntimeCredentialResolverService;
  let saved: NodeJS.ProcessEnv;
  beforeEach(async () => {
    saved = { ...process.env }; delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    db = await new DataSource({ type: 'sqljs', synchronize: true, entities: [RuntimeAssetEntity, GatewayConsumerCredentialEntity] }).initialize();
    resolver = new RuntimeCredentialResolverService(db);
    await db.getRepository(RuntimeAssetEntity).save([{ id: 'runtime-one', name: 'one', type: 'mcp_server' as any }, { id: 'runtime-two', name: 'two', type: 'mcp_server' as any }]);
    await db.getRepository(GatewayConsumerCredentialEntity).save(['runtime-one', 'runtime-two'].map(runtimeAssetId => ({
      name: runtimeAssetId, keyId: runtimeAssetId, runtimeAssetId, secretHash: createHash('sha256').update('secret').digest('hex'),
      accessPolicy: { version: 1, subject: 'worker', protocols: ['mcp'], scopes: ['read'], toolScopes: [], expiresAt: 2000000000 } })));
  });
  afterEach(async () => { await resolver.onModuleDestroy(); await db.destroy(); process.env = saved; });
  const read = async (env: NodeJS.ProcessEnv, suffix = '') => {
    const response = await fetch(env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL + suffix, {
      headers: { authorization: 'Bearer ' + env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN } });
    const text = await response.text(); return { status: response.status, text };
  };
  it('binds capability to one runtime, prohibits query overrides, and revokes only its server', async () => {
    const one = await resolver.createSpawnEnv('server-one', 'runtime-one');
    const two = await resolver.createSpawnEnv('server-two', 'runtime-two');
    const result = await read(one);
    expect(result.status).toBe(200); expect(result.text).toContain('runtime-one'); expect(result.text).not.toContain('runtime-two');
    expect((await read(one, '?runtimeAssetId=runtime-two')).status).toBe(401);
    expect((await read({ ...one, API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN: 'f'.repeat(64) })).status).toBe(401);
    resolver.releaseServer('server-one');
    expect((await read(one)).status).toBe(401); expect((await read(two)).status).toBe(200);
  });
  it('reflects committed revocation immediately and blocks future startup when no usable key remains', async () => {
    const env = await resolver.createSpawnEnv('server', 'runtime-one');
    await db.getRepository(GatewayConsumerCredentialEntity).update({ runtimeAssetId: 'runtime-one' }, { status: 'revoked' as any });
    expect(JSON.parse((await read(env)).text).credentials[0].status).toBe('revoked');
    await expect(resolver.validateForRuntime('runtime-one')).rejects.toThrow('No usable');
    await expect(resolver.createSpawnEnv('other', 'runtime-one')).rejects.toThrow('No usable');
  });
  it('replaces only the same server capability and validates required scopes and runtime type', async () => {
    const previous = await resolver.createSpawnEnv('server', 'runtime-one');
    const next = await resolver.createSpawnEnv('server', 'runtime-one');
    expect((await read(previous)).status).toBe(401); expect((await read(next)).status).toBe(200);
    process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'admin';
    await expect(resolver.validateForRuntime('runtime-one')).rejects.toThrow('No usable');
    await expect(resolver.validateForRuntime('absent')).rejects.toThrow('Invalid credential runtime');
  });
});
