import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import { authenticateRuntimeRequest } from 'api-nova-parser';
import { RuntimeAssetsService } from './runtime-assets.service';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';
import { GatewaySecurityService } from '../../gateway-runtime/services/gateway-security.service';

describe('persisted runtime access credential management and two adapters', () => {
  let db: DataSource;
  let management: RuntimeAssetsService;
  let savedEnv: NodeJS.ProcessEnv;
  const audit = { log: jest.fn(async () => {}) };
  const runtimeId = '00000000-0000-0000-0000-000000000001';
  const mcpId = '00000000-0000-0000-0000-000000000002';
  const repo = () => db.getRepository(GatewayConsumerCredentialEntity);
  async function open(database?: Uint8Array) {
    db = await new DataSource({ type: 'sqljs', database, synchronize: !database,
      entities: [RuntimeAssetEntity, GatewayConsumerCredentialEntity] }).initialize();
    // Every exercised repository is real; unrelated runtime lifecycle services are not invoked.
    management = Object.create(RuntimeAssetsService.prototype);
    Object.assign(management, { runtimeAssetRepository: db.getRepository(RuntimeAssetEntity),
      gatewayConsumerCredentialRepository: repo(), auditService: audit });
  }
  beforeEach(async () => {
    savedEnv = { ...process.env };
    delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    await open();
    await db.getRepository(RuntimeAssetEntity).save([
      { id: runtimeId, name: 'gateway-fixture', type: RuntimeAssetType.GATEWAY_SERVICE },
      { id: mcpId, name: 'mcp-fixture', type: RuntimeAssetType.MCP_SERVER },
    ]);
  });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); process.env = savedEnv; });
  const create = (extra: any = {}, id = runtimeId) => management.createGatewayConsumerCredential(id,
    { name: 'worker', subject: 'stable-worker', protocols: ['gateway', 'mcp'], toolScopes: ['read_fixture'], ...extra }, { actorId: 'admin-fixture' });
  const route = (id = runtimeId) => ({ policies: { auth: { mode: 'api_key' } },
    runtimeAsset: { id }, routeBinding: { id: 'route-fixture', routeVisibility: 'external' } } as any);
  const request = (key: string) => ({ headers: { 'x-api-key': key }, socket: { remoteAddress: '127.0.0.1' } } as any);
  const security = () => new GatewaySecurityService(audit as any, repo());
  async function useMcp(key: string, id = runtimeId) {
    process.env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = JSON.stringify(await management.exportRuntimeAccessCredentials(id));
    return authenticateRuntimeRequest({ 'x-api-key': key }, 'mcp', 'api_key');
  }
  it('reopens stored data, preserves trusted actor, exports original key unchanged and shares principal across real Gateway HTTP and MCP auth', async () => {
    const result = await create({ actorId: 'untrusted-client' });
    const dump = (db.driver as any).export();
    await db.destroy(); await open(dump);
    const row = await repo().findOneByOrFail({ id: result.credential.id });
    expect(row.accessPolicy.actorId).toBe('admin-fixture');
    expect(row.secretHash).toBe(createHash('sha256').update(result.apiKey.split('.')[1]).digest('hex'));
    const gateway = security();
    const listener: Server = createServer(async (req, res) => {
      try { const context = await gateway.authorize(route(), req as any); res.end(JSON.stringify(context.principal)); }
      catch (error) { res.writeHead(error.getStatus?.() || 500).end(); }
    });
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(listener.address() as any).port}`, { headers: { 'x-api-key': result.apiKey } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(await useMcp(result.apiKey));
    } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
    const list = JSON.stringify(await management.listGatewayConsumerCredentials(runtimeId));
    expect(list).not.toContain(result.apiKey); expect(list).not.toContain(row.secretHash);
    expect(JSON.stringify(await management.exportRuntimeAccessCredentials(runtimeId))).not.toContain(result.apiKey);
  });
  it('enforces protocol and runtime restrictions after exporting persisted records', async () => {
    const gatewayOnly = await create({ protocols: ['gateway'] });
    await expect(useMcp(gatewayOnly.apiKey)).rejects.toMatchObject({ status: 403 });
    const mcpOnly = await create({ protocols: ['mcp'] }, mcpId);
    await expect(security().authorize(route(mcpId), request(mcpOnly.apiKey))).rejects.toMatchObject({ status: 403 });
    const shared = await create();
    await expect(security().authorize(route(mcpId), request(shared.apiKey))).rejects.toMatchObject({ status: 403 });
    await expect(useMcp(shared.apiKey, mcpId)).rejects.toMatchObject({ status: 401 });
    expect((await useMcp(mcpOnly.apiKey, mcpId)).subject).toBe('stable-worker');
  });
  it('rejects an expired persisted key in both adapters', async () => {
    const result = await create(); const row = await repo().findOneByOrFail({ id: result.credential.id });
    row.accessPolicy = { ...row.accessPolicy, expiresAt: 1 }; await repo().save(row);
    await expect(security().authorize(route(), request(result.apiKey))).rejects.toMatchObject({ status: 401 });
    await expect(useMcp(result.apiKey)).rejects.toMatchObject({ status: 401 });
  });
  it('keeps legacy NULL policy Gateway-only without automatically exporting it', async () => {
    await repo().save({ name: 'legacy', keyId: 'legacy', secretHash: createHash('sha256').update('secret').digest('hex'), runtimeAssetId: runtimeId });
    expect((await management.exportRuntimeAccessCredentials(runtimeId)).credentials).toEqual([]);
    expect((await security().authorize(route(), request('legacy.secret'))).mode).toBe('api_key');
    await expect(useMcp('legacy.secret')).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ subject: '' }, { protocols: ['unknown'] }, { toolScopes: [4] }, { scopes: ['bad\nvalue'] }, { expiresAt: 1 }, { keyId: 'key.bad' }])('rejects invalid policy before any row is written %j', async bad => {
    await expect(create(bad)).rejects.toMatchObject({ status: 400 });
    expect(await repo().count()).toBe(0);
  });
  it('gives new MCP credentials a bounded expiry and no tool grants by default', async () => {
    const result = await management.createGatewayConsumerCredential(mcpId, { name: 'default-mcp' }, { actorId: 'admin-fixture' });
    const principal = await useMcp(result.apiKey, mcpId);
    expect(principal.toolScopes).toEqual([]);
    expect(principal.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(principal.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 30 * 86400);
  });
});
