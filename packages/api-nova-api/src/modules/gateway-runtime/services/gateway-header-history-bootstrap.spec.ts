import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Controller, Get } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import express = require('express');
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { SourceServiceAssetEntity as Asset } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { GatewayHeaderHistoryLedgerEntity as Ledger } from '../../../database/entities/gateway-header-history-ledger.entity';
import { GatewayHeaderHistoryLedgerService as LedgerService } from '../../../database/gateway-header-history-ledger.service';
import { GatewayProxyEngineService } from './gateway-proxy-engine.service';
import { GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER } from './gateway-upstream-credential-resolver';
import { createConfiguredGatewayCredentialRegistry, GATEWAY_UPSTREAM_CREDENTIAL_CONFIG as keys,
  GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY, gatewayUpstreamCredentialRegistryProvider,
  gatewayUpstreamCredentialResolverProvider, GATEWAY_HEADER_HISTORY_NAMESPACE as namespace,
  GATEWAY_HEADER_HISTORY_PROVENANCE as provenance } from './gateway-upstream-credential.providers';

@Controller('health-fixture') class OtherApi { @Get() health() { return { ok: true }; } }
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const get = (port: number, path = '/items', headers = {}) => new Promise<number>((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }).on('error', reject);
});
describe('Gateway persistent history bootstrap and real HTTP', () => {
  let root: string, file: string, db: DataSource, upstream: http.Server, upstreamPort: number, seen: any[], prior: string;
  const secret = 'API_NOVA_HISTORY_BOOTSTRAP_FIXTURE';
  const options = () => ({ type: 'sqljs' as const, location: join(root, 'ledger.sqlite'), autoSave: true, entities: [Asset, Endpoint, Ledger] });
  const config = () => new ConfigService({ [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test' });
  const candidate = (revision: string, name?: string): any => ({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: name ? { env: { type: 'env' } } : {}, credentials: name ? { key: { type: 'apiKey', placement: { in: 'header', name }, secretRef: 'env:' + secret } } : {},
    sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'http', host: '127.0.0.1', port: upstreamPort, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: name ? 'key' : 'none', headerPolicy: { version: 1 }, endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
  const boot = () => Test.createTestingModule({ controllers: [OtherApi], providers: [
    { provide: ConfigService, useValue: config() }, { provide: DataSource, useValue: db }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider,
  ] }).compile();
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'history-bootstrap-')); file = join(root, 'bindings.json');
    db = await new DataSource({ ...options(), synchronize: true }).initialize();
    await db.getRepository(Asset).save({ id: 'asset', sourceKey: 'fixture' });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'asset', method: 'GET', path: '/items' });
    seen = []; upstream = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); }); upstreamPort = await listen(upstream);
    prior = process.env[secret]; process.env[secret] = 'synthetic-only';
  });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); await close(upstream); await fs.rm(root, { recursive: true, force: true }); if (prior === undefined) delete process.env[secret]; else process.env[secret] = prior; });
  it('persists rotation and clearing across DB reopen and changed file path; old names strip on actual wire', async () => {
    await fs.writeFile(file, JSON.stringify(candidate('old', 'x-retired-key')));
    let module = await boot(); let registry = module.get<UpstreamCredentialRegistry>(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY);
    await registry.reload(candidate('rotated', 'x-current-key'));
    const empty = candidate('cleared'); await registry.reload(empty);
    const before = await new LedgerService(db).load(namespace, provenance); expect(before.headerNames).toEqual(['x-current-key', 'x-retired-key']);
    await module.close(); await db.destroy(); db = await new DataSource(options()).initialize();
    file = join(root, 'renamed.json'); await fs.writeFile(file, JSON.stringify(empty)); module = await boot();
    try {
      registry = module.get(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY);
      expect(registry.captureSnapshot().historicalAuthenticationHeaderNames).toEqual(expect.arrayContaining(['x-retired-key', 'x-current-key']));
      const invalid = candidate('old-allowlisted'); invalid.sites[0].headerPolicy = { version: 1, requestHeaders: ['x-retired-key'] };
      await expect(registry.reload(invalid)).rejects.toThrow(); expect(registry.captureSnapshot().candidate.metadata.revision).toBe('cleared');
      expect((await new LedgerService(db).load(namespace, provenance)).revision).toBe(before.revision + 1);
      const proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any, module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER));
      const app = express(); app.use((req, res) => { const route: any = { upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort, params: {}, runtimeAsset: { id: 'runtime' }, membership: { id: 'member' }, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'asset' }, routeBinding: { id: 'route', endpointDefinitionId: 'endpoint', upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } }, upstreamPath: '/items', upstreamMethod: 'GET' }, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: {} } }; void proxy.forward(route, req, res).catch(error => res.status(error.getStatus?.() ?? 500).end()); });
      const gateway = http.createServer(app); const port = await listen(gateway);
      try { expect(await get(port, '/items', { 'x-retired-key': 'forged', 'x-current-key': 'forged' })).toBe(200); expect(seen).toHaveLength(1); expect(seen[0]['x-retired-key']).toBeUndefined(); expect(seen[0]['x-current-key']).toBeUndefined(); } finally { await close(gateway); }
      const persisted = await new LedgerService(db).load(namespace, provenance);
      expect(await createConfiguredGatewayCredentialRegistry(new ConfigService({}), db)).toBeNull();
      expect(await new LedgerService(db).load(namespace, provenance)).toEqual(persisted);
    } finally { await module.close(); }
  });
  it.each(['missing', 'corrupt', 'provenance'] as const)('keeps unrelated Nest HTTP API available with %s ledger, while configured Registry never falls back', async failure => {
    await fs.writeFile(file, JSON.stringify(candidate('cold', 'x-key')));
    if (failure === 'missing') await db.query('DROP TABLE gateway_header_history_ledger');
    else {
      await new LedgerService(db).append(namespace, provenance, 0, ['x-retired-key']);
      await db.getRepository(Ledger).update({ namespace }, failure === 'corrupt'
        ? { headerNames: 'invalid-json' } : { provenanceDigest: 'b'.repeat(64) });
    }
    const module = await boot(); const app = module.createNestApplication();
    const proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any, module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER));
    app.use('/gateway-fixture', (req, res) => {
      const route: any = { upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort, params: {}, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'asset' }, routeBinding: { id: 'route', endpointDefinitionId: 'endpoint', upstreamConfig: { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } }, upstreamPath: '/items', upstreamMethod: 'GET' }, policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 2000 }, upstream: {} } };
      void proxy.forward(route, req, res).catch(error => res.status(error.getStatus?.() ?? 500).end());
    });
    await app.listen(0, '127.0.0.1');
    try {
      const registry = module.get<UpstreamCredentialRegistry>(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY);
      expect(registry.getStatus()).toMatchObject({ state: 'empty', lastReloadError: 'HISTORY_UNAVAILABLE' });
      expect(() => registry.captureSnapshot()).toThrow(); expect(module.get(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER)).not.toBeNull();
      expect(await get(app.getHttpServer().address().port, '/health-fixture')).toBe(200);
      expect(await get(app.getHttpServer().address().port, '/gateway-fixture')).toBe(503); expect(seen).toHaveLength(0);
    } finally { await app.close(); }
  });
  it('does not commit failed secret/ownership candidates and keeps last-good when storage fails', async () => {
    await fs.writeFile(file, JSON.stringify(candidate('good', 'x-good'))); const registry = await createConfiguredGatewayCredentialRegistry(config(), db);
    const before = await new LedgerService(db).load(namespace, provenance);
    delete process.env[secret]; await expect(registry.reload(candidate('bad-secret', 'x-uncommitted'))).rejects.toThrow(); process.env[secret] = 'synthetic-only';
    const bad = candidate('bad-owner', 'x-unowned'); bad.sites[0].sourceServiceAssetId = 'missing'; await expect(registry.reload(bad)).rejects.toThrow();
    expect(await new LedgerService(db).load(namespace, provenance)).toEqual(before);
    const conflict = jest.spyOn(LedgerService.prototype, 'append').mockRejectedValue(new Error('header_history_cas_conflict'));
    try { await expect(registry.reload(candidate('conflict', 'x-uncommitted'))).rejects.toThrow(); expect(conflict).toHaveBeenCalledTimes(3); }
    finally { conflict.mockRestore(); }
    expect(await new LedgerService(db).load(namespace, provenance)).toEqual(before);
    expect(registry.captureSnapshot().candidate.metadata.revision).toBe('good');
    await db.query('DROP TABLE gateway_header_history_ledger'); await expect(registry.reload(candidate('outage', 'x-outage'))).rejects.toThrow();
    expect(registry.captureSnapshot().candidate.metadata.revision).toBe('good');
  });
});
