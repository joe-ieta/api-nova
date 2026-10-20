import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express = require('express');
import { Test, TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { User, UserStatus } from '../../../database/entities/user.entity';
import { Role } from '../../../database/entities/role.entity';
import { Permission, PermissionAction, PermissionCategory } from '../../../database/entities/permission.entity';
import { AuditLog } from '../../../database/entities/audit-log.entity';
import { EndpointDefinitionEntity as Endpoint } from '../../../database/entities/endpoint-definition.entity';
import { RuntimeAssetEndpointBindingEntity as Membership, RuntimeAssetEndpointBindingStatus } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity as Runtime, RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayRouteBindingEntity as Route, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { EndpointPublishBindingEntity as Binding, PublicationBindingStatus } from '../../../database/entities/endpoint-publish-binding.entity';
import { PublicationProfileEntity as Profile, PublicationProfileStatus } from '../../../database/entities/publication-profile.entity';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import { PublicationHostAuthorityService } from './publication-host-authority.service';
import { PublicationAuthorityModule } from './publication-authority.module';
import { PublicationModule } from '../publication.module';
import { GatewayRuntimeModule } from '../../gateway-runtime/gateway-runtime.module';
import { PUBLICATION_HOST_AUTHORITY_PLAN, attestPublicationHostAuthorityPlan, type PublicationHostAuthorityOptions } from './publication-host-authority-plan';
import { normalizeUpstreamSecurity } from './upstream-security-reconciliation';
import { PublicationMemberTransactionWriter } from '../services/publication-member-transaction-writer';
import { GatewayUpstreamSecurityRuntimeGuard } from '../../gateway-runtime/services/gateway-upstream-security-runtime.guard';
import { GatewayProxyEngineService } from '../../gateway-runtime/services/gateway-proxy-engine.service';
import { GatewayRuntimeService } from '../../gateway-runtime/services/gateway-runtime.service';
import { createGatewayUpstreamCredentialResolver } from '../../gateway-runtime/services/gateway-upstream-credential-resolver';

const selector = { runtimeAssetId: 'runtime', runtimeMembershipId: 'member' };
const entities = [User, Role, Permission, AuditLog, Endpoint, Membership, Runtime, Route, Binding, Profile, Evidence];
const declaration = normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes: {
  Key: { type: 'apiKey', in: 'header', name: 'X-Key' },
} } }, {});
const close = (server?: http.Server) => !server ? Promise.resolve() : new Promise<void>(resolve => {
  server.closeAllConnections(); server.close(() => resolve());
});
@Module({})
class IsolatedHostModule {}

describe('NP-31 production composition: Nest issuer, SQL.js transactions and real Gateway HTTP', () => {
  let db: DataSource, module: TestingModule, service: PublicationHostAuthorityService;
  let upstream: http.Server, ingress: http.Server | undefined, target: string, secret: string, hits: number;
  let session: object, sessions: WeakMap<object, { actorId: string; authenticationEpoch: string }>;
  let options: PublicationHostAuthorityOptions, ownershipRevision: string, ownershipAllowed: boolean, audit: string[];
  let registry: UpstreamCredentialRegistry, candidate: any;
  let managers: EntityManager[], resolver: jest.Mock, cache: { resolve: jest.Mock; store: jest.Mock }, route: any;
  let gatewayFailure: string | undefined;

  beforeEach(async () => {
    hits = 0; secret = 'synthetic-secret'; ownershipRevision = 'owner-1'; ownershipAllowed = true; audit = []; managers = []; gatewayFailure = undefined;
    session = Object.freeze({}); sessions = new WeakMap([[session, { actorId: 'actor', authenticationEpoch: 'epoch-1' }]]);
    db = await new DataSource({ type: 'sqljs', synchronize: true, entities }).initialize();
    const permission = await db.getRepository(Permission).save({ id: 'permission', name: 'upstream:challenge',
      category: PermissionCategory.SECURITY, action: PermissionAction.EXECUTE });
    const manage = await db.getRepository(Permission).save({ id: 'manage', name: 'server:manage',
      category: PermissionCategory.SERVER_MANAGEMENT, action: PermissionAction.MANAGE });
    const role = await db.getRepository(Role).save({ id: 'role', name: 'explicit-test-operator', permissions: [permission, manage] });
    await db.getRepository(User).save({ id: 'actor', username: 'operator', email: 'operator@example.invalid',
      password: '$2b$synthetic-only', status: UserStatus.ACTIVE, emailVerified: true, roles: [role] });
    await db.getRepository(Endpoint).save({ id: 'endpoint', sourceServiceAssetId: 'source', path: '/target', method: 'GET',
      rawOperation: {}, metadata: { upstreamSecurityDeclaration: declaration } });
    await db.getRepository(Runtime).save({ id: 'runtime', name: 'isolated-gateway', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    await db.getRepository(Membership).save({ id: 'member', runtimeAssetId: 'runtime', endpointDefinitionId: 'endpoint',
      status: RuntimeAssetEndpointBindingStatus.ACTIVE, publicationRevision: 1 });
    await db.getRepository(Profile).save({ id: 'profile', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member',
      status: PublicationProfileStatus.REVIEWED });
    await db.getRepository(Binding).save({ id: 'publication', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member',
      publicationProfileId: 'profile', publishStatus: PublicationBindingStatus.ACTIVE, publishedToHttp: true, publicationRevision: 1 });
    await db.getRepository(Route).save({ id: 'route', endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'member',
      publishBindingId: 'publication', routePath: '/public', routeMethod: 'GET', upstreamPath: '/target', upstreamMethod: 'GET', status: GatewayRouteBindingStatus.ACTIVE });
    upstream = http.createServer((req, res) => { hits++; res.statusCode = req.headers['x-key'] === secret ? 200 : 401; res.end('ok'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port; target = `http://127.0.0.1:${port}/target`;
    candidate = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'source', match: { scheme: 'http', host: '127.0.0.1', port, basePath: '/' },
        allowedHosts: ['127.0.0.1'], credential: 'key', endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'key' }] }] };
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: d => ({ type: d.type, resolve: async () => secret }) });
    await registry.reload(candidate);
    options = {
      sessions: { resolve: async input => sessions.get(input as object) },
      ownership: {
        resolve: async (actor, ids, manager = db.manager) => {
          managers.push(manager);
          const endpoint = await manager.findOneBy(Endpoint, { id: ids.endpointDefinitionId, sourceServiceAssetId: ids.sourceServiceAssetId });
          return ownershipAllowed && actor === 'actor' && endpoint ? { revision: ownershipRevision } : undefined;
        },
        resolveMembership: async (actor, selected, manager) => {
          managers.push(manager);
          return ownershipAllowed && actor === 'actor' && await manager.findOneBy(Membership, { id: selected.runtimeMembershipId, runtimeAssetId: selected.runtimeAssetId })
            ? { revision: ownershipRevision } : undefined;
        },
      },
      bindings: { read: async (ids, manager = db.manager) => {
        managers.push(manager);
        const endpoint = await manager.findOneBy(Endpoint, { id: ids.endpointDefinitionId, sourceServiceAssetId: ids.sourceServiceAssetId });
        return endpoint ? { ...ids, bindingId: 'credential-binding', bindingRevision: 'r1', target, method: 'GET', declaration } : undefined;
      } },
      captureSnapshot: () => registry.captureSnapshot(), audit: { record: async event => { audit.push(event.event); } }, ttlMs: 60000,
    };
    module = await Test.createTestingModule({ imports: [PublicationAuthorityModule, {
      module: IsolatedHostModule, global: true, providers: [
        { provide: DataSource, useValue: db }, { provide: PUBLICATION_HOST_AUTHORITY_PLAN, useValue: attestPublicationHostAuthorityPlan(options) },
      ], exports: [DataSource, PUBLICATION_HOST_AUTHORITY_PLAN],
    }] }).compile();
    service = module.get(PublicationHostAuthorityService);
    route = {
      runtimeAsset: await db.getRepository(Runtime).findOneByOrFail({ id: 'runtime' }),
      membership: await db.getRepository(Membership).findOneByOrFail({ id: 'member' }),
      endpointDefinition: await db.getRepository(Endpoint).findOneByOrFail({ id: 'endpoint' }),
      routeBinding: await db.getRepository(Route).findOneByOrFail({ id: 'route' }),
      sourceServiceAsset: { id: 'source' }, sourceServiceInstance: { id: 'instance' },
      upstreamBaseUrl: `http://127.0.0.1:${port}`, params: {}, policies: {
        auth: { mode: 'anonymous' }, upstream: {}, traffic: { timeoutMs: 5000 }, cache: { enabled: true, maxBodyBytes: 1024 },
      },
    };
  });
  afterEach(async () => { jest.restoreAllMocks(); await close(ingress); ingress = undefined; await close(upstream); await module?.close(); await db?.destroy(); });

  async function gateway(capability?: Awaited<ReturnType<typeof service.challenge>>, change?: () => Promise<void>, bind = true) {
    const credentialResolver = createGatewayUpstreamCredentialResolver(() => registry.captureSnapshot());
    resolver = jest.fn(credentialResolver.resolve.bind(credentialResolver));
    const proxy = new GatewayProxyEngineService({ createTracker: () => ({ observeChunk() {}, finalize: () => ({}) }) } as any,
      { resolve: resolver }, undefined, new GatewayUpstreamSecurityRuntimeGuard(db.getRepository(Endpoint), service));
    const forward = proxy.forward.bind(proxy);
    if (change) jest.spyOn(proxy, 'forward').mockImplementation(async (...args) => { await change(); return forward(...args); });
    cache = { resolve: jest.fn(() => { throw Error('protected_request_must_not_read_cache'); }),
      store: jest.fn(() => { throw Error('protected_request_must_not_write_cache'); }) };
    const noEffects = new Proxy({}, { get: () => async () => undefined });
    const runtime = new GatewayRuntimeService({} as any,
      { authorize: async () => ({ mode: 'anonymous' }) } as any,
      { admit: async () => ({ release() {} }), beforeAttempt: async () => undefined,
        recordAttemptSuccess: async () => undefined, recordAttemptFailure: async () => undefined } as any,
      cache as any, proxy, noEffects as any, noEffects as any);
    const app = express();
    app.use((req, res) => { void (async () => {
      if (capability && bind) await service.bindRequest(req, session, selector, capability);
      await runtime.forwardResolvedRoute(route, req, res);
    })().catch(error => { gatewayFailure = error.message; if (!res.headersSent) res.status(error.getStatus?.() ?? 503).end('closed'); else res.destroy(); }); });
    ingress = http.createServer(app);
    await new Promise<void>(resolve => ingress!.listen(0, '127.0.0.1', resolve));
    return new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: (ingress!.address() as AddressInfo).port, path: '/public', headers: { 'x-key': secret, authorization: 'Bearer forged-session' } },
        res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }).on('error', reject);
    });
  }
  it('registers one shared authority module in both production consumers', () => {
    expect(Reflect.getMetadata('imports', PublicationModule)).toContain(PublicationAuthorityModule);
    expect(Reflect.getMetadata('imports', GatewayRuntimeModule)).toContain(PublicationAuthorityModule);
    expect(Reflect.getMetadata('providers', PublicationAuthorityModule)).toContain(PublicationHostAuthorityService);
  });
  it.each([undefined, {}])('stays closed without an attested plan (%s)', async plan => {
    const absent = new PublicationHostAuthorityService(db, plan as any);
    await expect(absent.challenge(session, selector)).rejects.toThrow('publication_authority_unavailable');
    expect(hits).toBe(0);
  });
  it('executes real four-leg challenge and forwards through actual Gateway without cache', async () => {
    const capability = await service.challenge(session, selector);
    expect(hits).toBe(4); expect(audit).toEqual(['issued', 'consumed', 'passed']);
    expect(await service.authorize(capability.proof, session, selector)).toBe(true);
    const status = await gateway(capability);
    expect({ status, gatewayFailure }).toEqual({ status: 200, gatewayFailure: undefined });
    expect(hits).toBe(5); expect(resolver).toHaveBeenCalledTimes(2);
    expect(cache.resolve).not.toHaveBeenCalled(); expect(cache.store).not.toHaveBeenCalled();
    expect(JSON.stringify(capability)).not.toContain(secret);
  });
  it('rejects consumer secrets and serialized capabilities before the runtime Resolver/cache', async () => {
    const capability = await service.challenge(session, selector);
    expect(await service.authorize(JSON.parse(JSON.stringify(capability.proof)), session, selector)).toBe(false);
    expect(await gateway(capability, undefined, false)).toBe(503);
    expect(hits).toBe(4); expect(resolver).not.toHaveBeenCalled(); expect(cache.resolve).not.toHaveBeenCalled();
  });
  it('binds authorization to the exact request and original authenticated session', async () => {
    const capability = await service.challenge(session, selector), request = {};
    await service.bindRequest(request, session, selector, capability);
    expect(await service.authorizeGateway(request, route, target)).toBe(true);
    expect(await service.authorizeGateway({ ...request }, route, target)).toBe(false);
    expect(await service.authorize(capability.proof, {}, selector)).toBe(false);
    await expect(service.bindRequest(request, session, selector, capability)).rejects.toThrow();
    expect(hits).toBe(4);
  });
  it.each(['permission', 'ownership', 'session', 'membership', 'conditions'])('rejects missing %s before challenge networking', async kind => {
    if (kind === 'permission') await db.getRepository(Permission).update('permission', { enabled: false });
    if (kind === 'conditions') await db.getRepository(Permission).update('permission', { conditions: { ipWhitelist: ['127.0.0.1'] } });
    if (kind === 'ownership') ownershipAllowed = false;
    if (kind === 'session') sessions.delete(session);
    if (kind === 'membership') await db.getRepository(Membership).update('member', { enabled: false });
    await expect(service.challenge(session, selector)).rejects.toThrow('publication_authority_unavailable'); expect(hits).toBe(0);
  });
  it.each(['epoch', 'ownership', 'secret', 'registry', 'revoked', 'expired', 'row', 'declaration'])('rejects changed %s without another upstream call', async kind => {
    const capability = await service.challenge(session, selector);
    if (kind === 'epoch') sessions.set(session, { actorId: 'actor', authenticationEpoch: 'epoch-2' });
    if (kind === 'ownership') ownershipRevision = 'owner-2';
    if (kind === 'secret') secret = 'rotated-at-same-revision';
    if (kind === 'registry') await registry.reload({ ...candidate, metadata: { revision: 'r2', environment: 'test' } });
    if (kind === 'revoked') await service.revoke(capability);
    if (kind === 'expired') await db.getRepository(Evidence).update(capability.evidenceId, { completedAt: new Date(0), expiresAt: new Date(1) });
    if (kind === 'row') await db.getRepository(Evidence).update(capability.evidenceId, { actorId: 'other' });
    if (kind === 'declaration') await db.getRepository(Endpoint).update('endpoint', { rawOperation: { security: [] } });
    expect(await service.authorize(capability.proof, session, selector)).toBe(false);
    expect(await gateway(capability)).toBe(503); expect(hits).toBe(4); expect(resolver).not.toHaveBeenCalled();
  });
  it.each(['revoke', 'secret', 'epoch'])('rechecks %s after preparation and before wire', async kind => {
    const capability = await service.challenge(session, selector);
    let changed = false;
    expect(await gateway(capability, async () => {
      changed = true;
      if (kind === 'revoke') await service.revoke(capability);
      if (kind === 'secret') secret = 'late-rotation';
      if (kind === 'epoch') sessions.set(session, { actorId: 'actor', authenticationEpoch: 'epoch-2' });
    })).toBe(503);
    expect(changed).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1); expect(hits).toBe(4);
    expect(cache.resolve).not.toHaveBeenCalled(); expect(cache.store).not.toHaveBeenCalled();
  });
  it('expires the live proof by time without rewriting its persisted evidence', async () => {
    const capability = await service.challenge(session, selector), later = Date.now() + 60001;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect(await service.authorize(capability.proof, session, selector)).toBe(false);
    expect(hits).toBe(4);
  });
  it('uses the real transaction manager and rolls back evidence changes in that transaction', async () => {
    const capability = await service.challenge(session, selector);
    const before = await db.getRepository(Membership).findOneByOrFail({ id: 'member' });
    let transactionManager: EntityManager | undefined;
    const writer = new PublicationMemberTransactionWriter(db, async context => {
      if (context.manager.queryRunner?.isTransactionActive) {
        transactionManager = context.manager;
        await context.manager.update(Evidence, capability.evidenceId, { revokedAt: new Date() });
      }
      return service.validateTransaction(session, selector, capability, context);
    });
    const ticket = await writer.prepare({ membershipId: 'member', evidenceId: capability.evidenceId });
    await expect(writer.commit(ticket)).rejects.toThrow();
    expect(transactionManager).toBeDefined(); expect(managers).toContain(transactionManager);
    expect(await db.getRepository(Membership).findOneByOrFail({ id: 'member' })).toEqual(before);
    expect((await db.getRepository(Evidence).findOneByOrFail({ id: capability.evidenceId })).revokedAt).toBeNull();
    expect(hits).toBe(4);
  });
  it('validates the exact evidence in a real transaction but does not open publication activation', async () => {
    const capability = await service.challenge(session, selector);
    await db.transaction('SERIALIZABLE', async manager => {
      const endpoint = await manager.findOneByOrFail(Endpoint, { id: 'endpoint' });
      const evidence = await manager.findOneByOrFail(Evidence, { id: capability.evidenceId });
      expect(await service.validateTransaction(session, selector, capability, { endpoint, evidence, membershipId: 'member', runtimeAssetId: 'runtime', manager })).toBe(capability.contextVersion);
      await expect(service.validateTransaction(session, selector, { ...capability, evidenceId: 'other' }, { endpoint, evidence, membershipId: 'member', runtimeAssetId: 'runtime', manager })).rejects.toThrow();
      expect(managers).toContain(manager);
    });
    expect(await service.preview(session, selector, capability.proof)).toMatchObject({ canPublish: false, proofCurrent: true, reasons: ['PUBLICATION_ACTIVATION_NOT_READY'] });
    const before = await db.getRepository(Membership).findOneByOrFail({ id: 'member' });
    expect((await service.executeBatch(session, [selector])).items[0]).toMatchObject({ status: 'failed', committed: false });
    expect(await db.getRepository(Membership).findOneByOrFail({ id: 'member' })).toEqual(before);
  });
  it('does not treat challenge permission as publication management permission', async () => {
    await db.getRepository(Permission).update('manage', { enabled: false });
    const capability = await service.challenge(session, selector);
    await db.transaction('SERIALIZABLE', async manager => {
      const endpoint = await manager.findOneByOrFail(Endpoint, { id: 'endpoint' });
      const evidence = await manager.findOneByOrFail(Evidence, { id: capability.evidenceId });
      await expect(service.validateTransaction(session, selector, capability, {
        endpoint, evidence, membershipId: 'member', runtimeAssetId: 'runtime', manager,
      })).rejects.toThrow('publication_authority_unavailable');
    });
    expect(hits).toBe(4);
  });
  it('rejects route candidate drift before Resolver and rejects capabilities after shutdown', async () => {
    const capability = await service.challenge(session, selector);
    await db.getRepository(Route).update('route', { upstreamPath: '/changed' });
    expect(await gateway(capability)).toBe(503); expect(resolver).not.toHaveBeenCalled(); expect(hits).toBe(4);
    service.onModuleDestroy();
    expect(await service.authorize(capability.proof, session, selector)).toBe(false);
  });
});
