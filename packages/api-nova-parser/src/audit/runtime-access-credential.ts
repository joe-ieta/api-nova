import { createHash, timingSafeEqual } from 'node:crypto';
import { RuntimeAuthError, type RuntimePrincipal } from './runtime-auth';

export type RuntimeAccessProtocol = 'gateway' | 'mcp';
/** The stored digest covers only the secret in keyId.secret. Never export plaintext. */
export interface RuntimeAccessCredential {
  version: 1;
  id: string;
  keyId: string;
  secretHash: string;
  status: 'active' | 'inactive' | 'revoked';
  subject: string;
  protocols: RuntimeAccessProtocol[];
  runtimeAssetId: string;
  routeBindingId?: string;
  toolScopes: string[];
  scopes: string[];
  expiresAt: number;
  actorId?: string;
}
export interface RuntimeAccessCredentialEnvelope {
  version: 1;
  runtimeAssetId: string;
  credentials: RuntimeAccessCredential[];
}
const text = (value: unknown, max = 512): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 &&
  value.every(item => text(item)) && new Set(value).size === value.length;

export function validateRuntimeAccessCredential(value: unknown): asserts value is RuntimeAccessCredential {
  const item = value as RuntimeAccessCredential | null;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.version !== 1 ||
      !text(item.id) || !text(item.keyId, 120) || !/^[A-Za-z0-9_-]+$/.test(item.keyId) ||
      typeof item.secretHash !== 'string' || !/^[a-f0-9]{64}$/i.test(item.secretHash) ||
      !['active', 'inactive', 'revoked'].includes(item.status) || !text(item.subject) ||
      !strings(item.protocols) || !item.protocols.length || item.protocols.some(value => value !== 'gateway' && value !== 'mcp') ||
      !text(item.runtimeAssetId) || (item.routeBindingId !== undefined && !text(item.routeBindingId)) ||
      !strings(item.toolScopes) || !strings(item.scopes) || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= 0 ||
      (item.actorId !== undefined && !text(item.actorId))) {
    throw new RuntimeAuthError(503, 'runtime_auth_not_configured');
  }
}

export function parseRuntimeAccessCredentialEnvelope(input: string): RuntimeAccessCredentialEnvelope {
  let value: RuntimeAccessCredentialEnvelope;
  try { value = JSON.parse(input); } catch { throw new RuntimeAuthError(503, 'runtime_auth_not_configured'); }
  if (!value || value.version !== 1 || !text(value.runtimeAssetId) || !Array.isArray(value.credentials) || value.credentials.length > 1000)
    throw new RuntimeAuthError(503, 'runtime_auth_not_configured');
  const ids = new Set<string>(), keyIds = new Set<string>();
  for (const credential of value.credentials) {
    validateRuntimeAccessCredential(credential);
    if (credential.runtimeAssetId !== value.runtimeAssetId || ids.has(credential.id) || keyIds.has(credential.keyId))
      throw new RuntimeAuthError(503, 'runtime_auth_not_configured');
    ids.add(credential.id); keyIds.add(credential.keyId);
  }
  return value;
}

export function verifyRuntimeAccessCredential(
  presented: string, credential: RuntimeAccessCredential,
  context: { protocol: RuntimeAccessProtocol; runtimeAssetId: string; routeBindingId?: string; now?: number },
): RuntimePrincipal {
  validateRuntimeAccessCredential(credential);
  const separator = typeof presented === 'string' ? presented.indexOf('.') : -1;
  const now = context.now ?? Date.now() / 1000;
  if (separator <= 0 || separator === presented.length - 1 || presented.length > 8192 ||
      presented.slice(0, separator) !== credential.keyId || /\s/u.test(presented) ||
      credential.status !== 'active' || !Number.isFinite(now) || credential.expiresAt <= now ||
      !timingSafeEqual(createHash('sha256').update(presented.slice(separator + 1)).digest(), Buffer.from(credential.secretHash, 'hex')))
    throw new RuntimeAuthError(401, 'invalid_api_key');
  if (!credential.protocols.includes(context.protocol) || credential.runtimeAssetId !== context.runtimeAssetId ||
      (credential.routeBindingId !== undefined && credential.routeBindingId !== context.routeBindingId))
    throw new RuntimeAuthError(403, 'credential_scope_forbidden');
  return { callerId: createHash('sha256').update(`api-key\0${credential.subject}`).digest('hex'),
    issuer: 'api-key', subject: credential.subject, credentialId: credential.id,
    scopes: [...credential.scopes], toolScopes: [...credential.toolScopes], expiresAt: credential.expiresAt,
    identitySource: 'authenticated' };
}
