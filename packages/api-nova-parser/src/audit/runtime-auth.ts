import { timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, JSONWebKeySet } from 'jose';
import { auditDigest } from './runtime-call-audit';

export type RuntimeAuthMode = 'oauth' | 'api_key' | 'anonymous';
export interface RuntimePrincipal {
  callerId?: string;
  issuer?: string;
  subject?: string;
  clientId?: string;
  credentialId?: string;
  scopes: string[];
  expiresAt?: number;
  identitySource: 'authenticated' | 'anonymous';
}

export class RuntimeAuthError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly requiredScopes?: string[]) { super(code); }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>>();

function trustedUrl(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local &&
    process.env.API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK === 'true')) throw new Error('HTTPS required');
  if (url.username || url.password || url.hash) throw new Error('Invalid authority');
  return url;
}

export function runtimeResource(transport: 'gateway' | 'mcp'): string {
  const resource = (transport === 'mcp' ? process.env.API_NOVA_MCP_RESOURCE : process.env.API_NOVA_GATEWAY_RESOURCE)
    || process.env.API_NOVA_RUNTIME_RESOURCE;
  if (!resource) throw new RuntimeAuthError(503, 'runtime_auth_not_configured');
  try { trustedUrl(resource); return resource; }
  catch { throw new RuntimeAuthError(503, 'runtime_auth_not_configured'); }
}

export function runtimeAuthMode(): RuntimeAuthMode {
  const mode = process.env.API_NOVA_RUNTIME_AUTH_MODE || 'oauth';
  if (!['oauth', 'api_key', 'anonymous'].includes(mode)) throw new RuntimeAuthError(503, 'invalid_auth_mode');
  return mode as RuntimeAuthMode;
}

export function runtimeMetadata(transport: 'gateway' | 'mcp') {
  try {
    const resource = runtimeResource(transport);
    const issuer = process.env.API_NOVA_RUNTIME_ISSUER;
    if (!issuer) throw new Error('Missing issuer');
    trustedUrl(issuer);
    return { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'],
      scopes_supported: requiredRuntimeScopes() };
  } catch { throw new RuntimeAuthError(503, 'runtime_auth_not_configured'); }
}

export function runtimeChallenge(transport: 'gateway' | 'mcp', insufficientScope = false, scopes = requiredRuntimeScopes()): string {
  let metadata = '';
  try {
    const resource = new URL(runtimeResource(transport));
    metadata = `, resource_metadata="${resource.origin}/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}"`;
  } catch { /* no discovery advertised for unconfigured/private deployments */ }
  const safeScopes = scopes.filter(scope => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)).join(' ');
  const parameters = [insufficientScope ? 'error="insufficient_scope"' : '',
    metadata.replace(/^, /, ''), safeScopes ? `scope="${safeScopes}"` : ''].filter(Boolean);
  return `Bearer${parameters.length ? ' ' + parameters.join(', ') : ''}`;
}

export function requiredRuntimeScopes(): string[] {
  return (process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES || '').split(/\s+/).filter(Boolean);
}

export function requireRuntimeScopes(principal: RuntimePrincipal, required: string[]): void {
  if (required.some(scope => !principal.scopes.includes(scope))) throw new RuntimeAuthError(403, 'insufficient_scope');
}

export async function authenticateRuntimeRequest(
  headers: Record<string, string | string[] | undefined>, transport: 'gateway' | 'mcp',
  mode: RuntimeAuthMode = runtimeAuthMode(),
): Promise<RuntimePrincipal> {
  if (mode === 'anonymous') return { identitySource: 'anonymous', scopes: [] };
  const authorization = headers.authorization;
  if (Array.isArray(authorization)) throw new RuntimeAuthError(401, 'invalid_token');
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (mode === 'api_key') {
    const key = headers['x-api-key'];
    if (typeof key !== 'string' || !key || key.length > 8192) throw new RuntimeAuthError(401, 'invalid_api_key');
    let credentials: any[];
    try {
      credentials = JSON.parse(process.env.API_NOVA_RUNTIME_API_KEYS || '[]');
      if (!Array.isArray(credentials)) throw new Error();
    } catch { throw new RuntimeAuthError(503, 'runtime_auth_not_configured'); }
    const presentedHash = Buffer.from(auditDigest(key), 'hex');
    const credential = credentials.find(item => {
      if (!item || !/^[a-f0-9]{64}$/i.test(item.secretHash || '')) return false;
      return timingSafeEqual(presentedHash, Buffer.from(item.secretHash, 'hex'));
    });
    if (!credential || typeof credential.subject !== 'string' || !credential.subject || credential.subject.length > 512 ||
      typeof credential.id !== 'string' || !credential.id || !Number.isFinite(credential.expiresAt) ||
      credential.expiresAt <= Date.now() / 1000) throw new RuntimeAuthError(401, 'invalid_api_key');
    const resources = credential.resources;
    if (!Array.isArray(resources) || !resources.includes(runtimeResource(transport))) throw new RuntimeAuthError(403, 'resource_forbidden');
    const principal: RuntimePrincipal = { callerId: auditDigest(`api-key\0${credential.subject}`),
      issuer: 'api-key', subject: credential.subject, credentialId: credential.id,
      scopes: Array.isArray(credential.scopes) ? credential.scopes.filter((scope: unknown) => typeof scope === 'string') : [], expiresAt: credential.expiresAt,
      identitySource: 'authenticated' };
    requireRuntimeScopes(principal, requiredRuntimeScopes());
    return principal;
  }
  if (!token || token.length > 32768) throw new RuntimeAuthError(401, 'invalid_token');
  const issuer = process.env.API_NOVA_RUNTIME_ISSUER;
  const jwksUri = process.env.API_NOVA_RUNTIME_JWKS_URI;
  const localKeys = process.env.API_NOVA_RUNTIME_JWKS_JSON;
  const audience = runtimeResource(transport);
  let keySet: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
  try {
    if (!issuer) throw new Error();
    trustedUrl(issuer);
    if (!jwksUri && !localKeys) throw new Error();
    const key = `${issuer}\0${jwksUri || localKeys}`;
    keySet = keySets.get(key)!;
    if (!keySet) {
      keySet = jwksUri ? createRemoteJWKSet(trustedUrl(jwksUri), { timeoutDuration: 5000 })
        : createLocalJWKSet(JSON.parse(localKeys!) as JSONWebKeySet);
      if (keySets.size >= 8) keySets.clear();
      keySets.set(key, keySet);
    }
  } catch { throw new RuntimeAuthError(503, 'runtime_auth_not_configured'); }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet, { issuer, audience,
      algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 0 }));
  } catch { throw new RuntimeAuthError(401, 'invalid_token'); }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512) throw new RuntimeAuthError(401, 'invalid_token');
  const principal: RuntimePrincipal = { callerId: auditDigest(`${issuer}\0${payload.sub}`), issuer,
    subject: payload.sub, clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
    expiresAt: payload.exp, identitySource: 'authenticated' };
  requireRuntimeScopes(principal, requiredRuntimeScopes());
  return principal;
}
