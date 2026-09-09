import { EntityManager } from 'typeorm';
import { RuntimeCallerEntity, RuntimeCallerObservationEntity, RuntimeInvocationEntity }
  from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { observabilityEtag } from './call-observability-command.store';

export function callerProfileEtag(profile: RuntimeCallerEntity): string {
  if (!Number.isSafeInteger(profile.version) || profile.version < 1 || profile.version > 2147483647) {
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
  return observabilityEtag('caller-profile:' + profile.callerId, profile.version);
}

/** A global profile cannot be edited using authority over only one of its assets. */
export async function canManageCallerProfile(manager: EntityManager, callerId: string,
  authorization: ObservabilityAuthorization, now: string): Promise<boolean> {
  if (!authorization.requiredPermissions.includes('monitoring:manage') ||
    !authorization.requiredPermissions.includes('monitoring:read')) return false;
  const assets = authorization.runtimeAssetIds;
  if (assets !== null && !assets.length) return false;
  const observed = manager.getRepository(RuntimeCallerObservationEntity).createQueryBuilder('observation')
    .where('observation.callerId = :callerId', { callerId });
  if (!await observed.clone().select('observation.id').limit(1).getOne()) return false;
  const type = manager.connection.options.type;
  const text = (key: 'identitySource' | 'authState') => {
    if (type === 'postgres') return "inv.record ->> '" + key + "'";
    if (type === 'sqljs' || type === 'sqlite') return "json_extract(inv.record, '$." + key + "')";
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  };
  const retained = manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('inv')
    .where('inv.callerId = :callerId', { callerId })
    .andWhere('inv.expiresAt > :now', { now })
    .andWhere('inv.origin = :external', { external: 'external' })
    .andWhere('inv.spanKind IN (:...kinds)', { kinds: ['gateway_request', 'mcp_protocol', 'mcp_tool'] })
    .andWhere(text('identitySource') + ' = :trusted', { trusted: 'authenticated' })
    .andWhere(text('authState') + ' = :trusted');
  if (!await retained.clone().select('inv.invocationId').limit(1).getOne()) return false;
  if (assets === null) return true;
  // Retained calls and all registered associations must both be covered. Expiry
  // of a hidden call does not silently grant ownership over a shared profile.
  const outside = (alias: string) => '(' + alias + '.runtimeAssetId IS NULL OR ' + alias + '.runtimeAssetId NOT IN (:...assets))';
  if (await observed.clone().andWhere(outside('observation'), { assets: [...assets] })
    .select('observation.id').limit(1).getOne()) return false;
  return !await retained.clone().andWhere(outside('inv'), { assets: [...assets] })
    .select('inv.invocationId').limit(1).getOne();
}
