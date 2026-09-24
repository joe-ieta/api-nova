import * as http from 'node:http';
import * as https from 'node:https';
import { GatewayHeaderHistoryLedgerService } from '../../../database/gateway-header-history-ledger.service';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { createHostCredentialGenerationStore, createRegistryProviderEvidence, validateUpstreamCredentialBindings } from 'api-nova-parser';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { GatewayHeaderHistoryLedgerEntity } from '../../../database/entities/gateway-header-history-ledger.entity';
import { createGatewayHostCredentialGenerationCapability } from './gateway-host-credential-generation.capability';
import { attestGatewayHostCredentialCandidate, createGatewayHostCredentialRegistry, validateGatewayHostCandidateOwnership } from './gateway-host-credential-registry';
const entities = [SourceServiceAssetEntity, EndpointDefinitionEntity, GatewayHeaderHistoryLedgerEntity];
describe('private host Registry boot composition', () => {
  let database: DataSource;
  const closes: (() => void)[] = [];
  beforeEach(async () => {
    database = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    await database.getRepository(SourceServiceAssetEntity).save({ id: 'asset', sourceKey: 'asset' });
    await database.getRepository(EndpointDefinitionEntity).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/items' });
  });
  afterEach(async () => { closes.splice(0).reverse().forEach(close => close()); if (database.isInitialized) await database.destroy(); jest.restoreAllMocks(); });
  function fixture(secret = true) {
    const store = createHostCredentialGenerationStore();
    const generation = store.activate(store.stage({ providers: { memory: secret ? { TOKEN: 'host-only' } : { UNRELATED: 'not-the-required-key' } }, expiresAt: Date.now() + 60000 }), null);
    const evidence = createRegistryProviderEvidence(store), controller = createGatewayHostCredentialGenerationCapability(evidence);
    closes.push(() => { controller.close(); store.close(); });
    const document = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } }, credentials: { token: { type: 'bearer', secretRef: 'memory:TOKEN' } }, sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'example.com', port: 443, basePath: '/' }, allowedHosts: ['example.com'], credential: 'token', endpoints: [{ endpointDefinitionId: 'endpoint' }] }] };
    const input = { capability: controller.capability, text: JSON.stringify(document), format: 'json' as const, environment: 'test', expectedGeneration: store.describe(generation).generationId };
    return { store, generation, evidence, controller, document, input, attest: () => attestGatewayHostCredentialCandidate(input) };
  }
  it('real Nest cannot expose a SQL.js composition', async () => {
    const f = fixture();
    await expect(Test.createTestingModule({ providers: [{ provide: 'host', useFactory: () => createGatewayHostCredentialRegistry(f.attest(), database) }] }).compile()).rejects.toThrow('gateway_host_credential_registry_unavailable');
    expect(await database.getRepository(GatewayHeaderHistoryLedgerEntity).count()).toBe(0);
  });
  it('opaque attestation is one-use and cannot be copied', async () => {
    const f = fixture(), token = f.attest(); await expect(createGatewayHostCredentialRegistry({ ...token }, database)).rejects.toThrow();
    await expect(createGatewayHostCredentialRegistry(token, database)).rejects.toThrow();
    await expect(createGatewayHostCredentialRegistry(token, database)).rejects.toThrow();
  });
  it.each(['missing', 'bad-json', 'epoch', 'environment', 'ownership'])('SQL.js remains disabled for %s, without exposing a candidate', async kind => {
    const f = fixture(kind !== 'missing');
    if (kind === 'bad-json') f.input.text = '{';
    if (kind === 'epoch') f.input.expectedGeneration = 'wrong';
    if (kind === 'environment') f.input.environment = 'other';
    if (kind === 'ownership') await database.getRepository(EndpointDefinitionEntity).delete('endpoint');
    await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow('gateway_host_credential_registry_unavailable');
    expect(() => f.evidence.issue({} as any, 'asset')).toThrow();
  });
  it('valid generation and subsequent rotation cannot opt SQL.js into boot', async () => {
    const f = fixture();
    f.store.activate(f.store.stage({ providers: { memory: { TOKEN: 'new' } }, expiresAt: Date.now() + 60000 }), f.generation);
    await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow();
    expect(await database.getRepository(GatewayHeaderHistoryLedgerEntity).count()).toBe(0);
  });
  it('rejects active SQL.js transaction without ending it', async () => {
    const f = fixture(), runner = database.createQueryRunner(); await runner.startTransaction();
    try { await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow(); expect(runner.isTransactionActive).toBe(true); }
    finally { await runner.rollbackTransaction(); }
    expect(await database.getRepository(GatewayHeaderHistoryLedgerEntity).count()).toBe(0);
  });
  it('ownership reads exported state even when live rows change while clone initializes', async () => {
    const f = fixture(); await database.getRepository(EndpointDefinitionEntity).delete('endpoint');
    const initialize = DataSource.prototype.initialize;
    jest.spyOn(DataSource.prototype, 'initialize').mockImplementation(async function(this: DataSource) {
      if (this !== database) await database.getRepository(EndpointDefinitionEntity).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/items' });
      return initialize.call(this);
    });
    await expect(validateGatewayHostCandidateOwnership(database, validateUpstreamCredentialBindings(f.document))).rejects.toThrow();
    expect(await database.getRepository(EndpointDefinitionEntity).count()).toBe(1);
  });
  it('SQL.js cold reopen remains disabled; isolated ownership can still be verified', async () => {
    const f = fixture();
    await validateGatewayHostCandidateOwnership(database, validateUpstreamCredentialBindings(f.document));
    const bytes = (database.driver as any).export(); await database.destroy();
    database = await new DataSource({ type: 'sqljs', database: bytes, entities, synchronize: false }).initialize();
    await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow();
    expect(await database.getRepository(GatewayHeaderHistoryLedgerEntity).count()).toBe(0);
  });
  it('attestation rejects getters and additional providerFactory without executing either', () => {
    const f = fixture(), getter = jest.fn();
    expect(() => attestGatewayHostCredentialCandidate({ ...f.input, providerFactory: getter } as any)).toThrow();
    const bad = { ...f.input }; Object.defineProperty(bad, 'text', { get: getter });
    expect(() => attestGatewayHostCredentialCandidate(bad)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('does not publish if an external transaction rolls back the ledger insert during await', async () => {
    const f = fixture(), repo = database.getRepository(GatewayHeaderHistoryLedgerEntity), insert = repo.insert.bind(repo), runner = database.createQueryRunner();
    jest.spyOn(repo, 'insert').mockImplementation(async value => {
      await runner.startTransaction();
      const result = await insert(value);
      await runner.rollbackTransaction();
      return result;
    });
    // Real underlying hazard: a successful CAS result does not imply shared SQL.js durability.
    const result = await new GatewayHeaderHistoryLedgerService(database).append('test:hazard', 'a'.repeat(64), 0, ['authorization']);
    expect(result.revision).toBe(1); expect(await repo.count()).toBe(0);
    const insertCalls = (repo.insert as jest.Mock).mock.calls.length;
    await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow();
    expect((repo.insert as jest.Mock).mock.calls).toHaveLength(insertCalls);
    expect(await repo.count()).toBe(0);
  });

  it('SQL.js rejection issues no HTTP or HTTPS request', async () => {
    const plain = jest.spyOn(http, 'request'), secure = jest.spyOn(https, 'request'), f = fixture();
    await expect(createGatewayHostCredentialRegistry(f.attest(), database)).rejects.toThrow();
    expect(plain).not.toHaveBeenCalled(); expect(secure).not.toHaveBeenCalled();
  });

});
