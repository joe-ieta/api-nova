import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import { normalizeGatewayHeaderMigration } from './gateway-header-migration';

export type GatewayLegacyPolicySource =
  | { source: 'inline' }
  | { source: 'registry'; providerId: string; siteId: string; providerFingerprint: string };
export interface GatewayLegacyExceptionContext {
  /** Trusted host context; never populated from consumer request headers. */
  actorId: string;
  source: GatewayLegacyPolicySource;
  registryConfigured: boolean;
}
const reject = (): never => { throw new Error('GATEWAY_LEGACY_EXCEPTION_REJECTED'); };
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) reject();
}
function source(raw: GatewayLegacyPolicySource, enabled: boolean): GatewayLegacyPolicySource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return reject();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some(value => !('value' in value))) return reject();
  const keys = raw.source === 'inline' ? ['source'] : ['source', 'providerId', 'siteId', 'providerFingerprint'];
  if (Reflect.ownKeys(raw).length !== keys.length || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) return reject();
  if (raw.source === 'inline') { if (enabled) return reject(); return { source: 'inline' }; }
  if (raw.source !== 'registry' || !enabled) return reject();
  text(raw.providerId); text(raw.siteId);
  if (!/^[a-f0-9]{64}$/.test(raw.providerFingerprint)) return reject();
  return { source: 'registry', providerId: raw.providerId, siteId: raw.siteId, providerFingerprint: raw.providerFingerprint };
}
function canonical(value: unknown): string {
  const normalize = (input: any): any => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])])) : input;
  return JSON.stringify(normalize(value));
}
function fingerprint(route: GatewayRouteBindingEntity, provenance: GatewayLegacyPolicySource, grant: unknown): string {
  const { headerPolicyMigration: _migration, headerPolicyLegacyException: _exception, ...config } = route.upstreamConfig || {};
  return createHash('sha256').update(canonical({ routeId: route.id, endpointDefinitionId: route.endpointDefinitionId,
    membershipId: route.runtimeAssetEndpointBindingId, matchHost: route.matchHost ?? null, routePath: route.routePath,
    routeMethod: route.routeMethod, upstreamPath: route.upstreamPath, upstreamMethod: route.upstreamMethod,
    authPolicyRef: route.authPolicyRef ?? null, config, provenance, grant })).digest('hex');
}

/** Draft persistence only. No controller/provider registration and no snapshot/activation writes. */
export class GatewayHeaderLegacyExceptionService {
  constructor(private readonly dataSource: DataSource, private readonly now: () => number = Date.now) {}

  async register(routeId: string, grant: unknown, context: GatewayLegacyExceptionContext): Promise<string> {
    text(routeId); text(context.actorId);
    const provenance = source(context.source, context.registryConfigured);
    const normalized = normalizeGatewayHeaderMigration(grant, routeId, this.now());
    if (normalized.mode !== 'legacy') return reject();
    const repository = this.dataSource.getRepository(GatewayRouteBindingEntity);
    const route = await repository.findOneBy({ id: routeId });
    if (!route || route.upstreamConfig?.headerPolicy !== undefined || route.upstreamConfig?.headerPolicyMigration !== undefined || route.upstreamConfig?.headerPolicyLegacyException !== undefined) return reject();
    const id = randomUUID();
    const next = { ...route.upstreamConfig, headerPolicyMigration: normalized,
      headerPolicyLegacyException: { version: 1, id, status: 'registered', actorId: context.actorId,
        routeId, endpointDefinitionId: route.endpointDefinitionId, source: provenance, grant: normalized,
        policyFingerprint: fingerprint(route, provenance, normalized) } };
    await this.compareAndSet(route, next);
    return id;
  }

  async validate(routeId: string, exceptionId: string, context: GatewayLegacyExceptionContext): Promise<void> {
    text(routeId); text(exceptionId); text(context.actorId);
    const provenance = source(context.source, context.registryConfigured);
    const route = await this.dataSource.getRepository(GatewayRouteBindingEntity).findOneBy({ id: routeId });
    const record: any = route?.upstreamConfig?.headerPolicyLegacyException;
    if (!route || !record || record.version !== 1 || record.status !== 'registered' || record.id !== exceptionId || record.routeId !== routeId || record.endpointDefinitionId !== route.endpointDefinitionId || route.upstreamConfig?.headerPolicy !== undefined) return reject();
    const keys = ['version', 'id', 'status', 'actorId', 'routeId', 'endpointDefinitionId', 'source', 'grant', 'policyFingerprint'];
    if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))) return reject();
    const grant = normalizeGatewayHeaderMigration(record.grant, routeId, this.now());
    if (grant.mode !== 'legacy' || canonical(grant) !== canonical(route.upstreamConfig?.headerPolicyMigration) || canonical(record.source) !== canonical(provenance) || record.policyFingerprint !== fingerprint(route, provenance, grant)) return reject();
  }

  async revoke(routeId: string, exceptionId: string, actorId: string): Promise<void> {
    text(routeId); text(exceptionId); text(actorId);
    const route = await this.dataSource.getRepository(GatewayRouteBindingEntity).findOneBy({ id: routeId });
    const record: any = route?.upstreamConfig?.headerPolicyLegacyException;
    if (!route || !record || record.id !== exceptionId || record.routeId !== routeId) return reject();
    if (record.status === 'revoked') return;
    if (record.status !== 'registered') return reject();
    await this.compareAndSet(route, { ...route.upstreamConfig, headerPolicyLegacyException: {
      ...record, status: 'revoked', revokedAt: new Date(this.now()).toISOString(), revokedBy: actorId,
    } });
  }

  private async compareAndSet(route: GatewayRouteBindingEntity, next: Record<string, unknown>): Promise<void> {
    // JSON-column equality uses the driver's serialization on SQLite and a JSONB
    // cast on PostgreSQL. Only this column changes; stale writers cannot undo revoke.
    const query = this.dataSource.getRepository(GatewayRouteBindingEntity).createQueryBuilder()
      .update().set({ upstreamConfig: next }).where('id = :id', { id: route.id });
    if (route.upstreamConfig == null) query.andWhere('upstreamConfig IS NULL');
    else if (this.dataSource.options.type === 'postgres') query.andWhere('"upstreamConfig"::jsonb = CAST(:previous AS jsonb)', { previous: JSON.stringify(route.upstreamConfig) });
    else query.andWhere('upstreamConfig = :previous', { previous: JSON.stringify(route.upstreamConfig) });
    const result = await query.execute();
    if (result.affected !== 1) return reject();
  }
}
