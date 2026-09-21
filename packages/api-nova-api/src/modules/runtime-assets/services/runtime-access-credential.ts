import { BadRequestException } from '@nestjs/common';
import { validateRuntimeAccessCredential, type RuntimeAccessCredential } from 'api-nova-parser';
import { GatewayConsumerCredentialEntity } from '../../../database/entities/gateway-consumer-credential.entity';
import { CreateGatewayConsumerCredentialDto } from '../dto/runtime-assets.dto';

/** Server-owned actor and version, stored on the existing consumer row. */
export function createRuntimeAccessPolicy(
  dto: CreateGatewayConsumerCredentialDto, keyId: string, protocol: 'gateway' | 'mcp', actorId?: string,
): Record<string, unknown> {
  const subject = dto.subject ?? keyId;
  const protocols = dto.protocols ?? [protocol];
  const toolScopes = dto.toolScopes ?? [];
  const scopes = dto.scopes ?? [];
  const expiresAt = dto.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * 86400;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 512 ||
      !Array.isArray(protocols) || !protocols.length || protocols.length > 2 ||
      protocols.some(value => !['gateway', 'mcp'].includes(value)) ||
      !protocols.includes(protocol) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000 ||
      [toolScopes, scopes].some(list => !Array.isArray(list) || list.length > 200 ||
        list.some(value => typeof value !== 'string' || !value.trim() || value.length > 512))) {
    throw new BadRequestException('Invalid runtime credential policy');
  }
  if (dto.routeBindingId && protocols.includes('mcp')) {
    throw new BadRequestException('Route-scoped credentials cannot authorize MCP tools');
  }
  const policy = { version: 1, subject, protocols: [...new Set(protocols)],
    toolScopes: [...new Set(toolScopes)], scopes: [...new Set(scopes)], expiresAt,
    ...(actorId ? { actorId } : {}) };
  try {
    validateRuntimeAccessCredential({ ...policy, id: 'validation', keyId, secretHash: '0'.repeat(64),
      status: 'active', runtimeAssetId: 'validation' });
  } catch { throw new BadRequestException('Invalid runtime credential policy'); }
  return policy;
}

export function toRuntimeAccessCredential(entity: GatewayConsumerCredentialEntity): RuntimeAccessCredential {
  // Never let policy JSON override the identity, hash, status or runtime ownership.
  const policy = entity.accessPolicy || {};
  return { version: policy.version, subject: policy.subject, protocols: policy.protocols,
    toolScopes: policy.toolScopes, scopes: policy.scopes, expiresAt: policy.expiresAt,
    ...(policy.actorId !== undefined ? { actorId: policy.actorId } : {}), id: entity.id, keyId: entity.keyId, secretHash: entity.secretHash,
    status: entity.status, runtimeAssetId: entity.runtimeAssetId,
    ...(entity.routeBindingId ? { routeBindingId: entity.routeBindingId } : {}) } as RuntimeAccessCredential;
}
