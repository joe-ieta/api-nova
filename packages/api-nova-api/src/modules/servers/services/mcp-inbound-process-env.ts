import { createPublicKey } from 'node:crypto';
import { parseRuntimeAccessCredentialEnvelope } from 'api-nova-parser';
import {
  configuredMcpInboundAuthMode,
  MCPServerEntity,
  McpInboundAuthMode,
} from '../../../database/entities/mcp-server.entity';

export type McpRuntimeAuthMode = 'jwt' | 'api_key' | 'anonymous';

const INBOUND_CREDENTIAL_KEYS = [
  'API_NOVA_RUNTIME_ISSUER',
  'API_NOVA_RUNTIME_JWKS_URI',
  'API_NOVA_RUNTIME_JWKS_JSON',
  'API_NOVA_RUNTIME_API_KEYS',
  'API_NOVA_RUNTIME_ACCESS_CREDENTIALS',
] as const;

function trustedUrl(value: string, env: NodeJS.ProcessEnv): void {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback &&
    env.API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK === 'true')) throw new Error('HTTPS required');
  if (url.username || url.password || url.hash) throw new Error('Invalid authority');
}

function runtimeResource(env: NodeJS.ProcessEnv): string {
  const value = env.API_NOVA_MCP_RESOURCE || env.API_NOVA_RUNTIME_RESOURCE;
  if (!value) throw new Error('MCP runtime resource is required');
  trustedUrl(value, env);
  return value;
}

export function preflightMcpInboundCredentials(
  mode: McpRuntimeAuthMode,
  env: NodeJS.ProcessEnv = process.env,
  expectedRuntimeAssetId?: string,
): void {
  if (!['jwt', 'api_key', 'anonymous'].includes(mode)) throw new Error('Invalid MCP inbound authentication mode');
  if (mode === 'anonymous') return;
  if (mode === 'api_key' && env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS !== undefined) {
    try {
      const envelope = parseRuntimeAccessCredentialEnvelope(env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS);
      if (expectedRuntimeAssetId !== undefined && (!expectedRuntimeAssetId || envelope.runtimeAssetId !== expectedRuntimeAssetId)) throw new Error();
      const required = (env.API_NOVA_RUNTIME_REQUIRED_SCOPES || '').split(/\s+/).filter(Boolean);
      if (!envelope.credentials.some(credential => credential.status === 'active' &&
          credential.expiresAt > Date.now() / 1000 && credential.protocols.includes('mcp') &&
          credential.runtimeAssetId === envelope.runtimeAssetId && !credential.routeBindingId &&
          required.every(scope => credential.scopes.includes(scope)))) throw new Error();
      return;
    } catch { throw new Error('Invalid unified MCP runtime credential configuration'); }
  }
  const resource = runtimeResource(env);
  if (mode === 'jwt') {
    const issuer = env.API_NOVA_RUNTIME_ISSUER;
    const jwksUri = env.API_NOVA_RUNTIME_JWKS_URI;
    const jwksJson = env.API_NOVA_RUNTIME_JWKS_JSON;
    if (!issuer || (!jwksUri && !jwksJson)) {
      throw new Error('MCP JWT issuer and JWK set are required');
    }
    trustedUrl(issuer, env);
    if (jwksUri) trustedUrl(jwksUri, env);
    else {
      let keys: unknown;
      try { keys = JSON.parse(jwksJson!).keys; }
      catch { throw new Error('Invalid MCP JWT JWK set'); }
      let usable = false;
      if (Array.isArray(keys)) for (const key of keys) {
        try {
          if (key && typeof key === 'object' &&
            (key.kty === 'RSA' ? (!key.alg || key.alg === 'RS256') :
              key.kty === 'EC' && key.crv === 'P-256' && (!key.alg || key.alg === 'ES256')) &&
            (!key.use || key.use === 'sig') &&
            (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify')))) {
            createPublicKey({ key, format: 'jwk' });
            usable = true;
            break;
          }
        } catch { /* Other keys may still be usable. */ }
      }
      if (!usable) throw new Error('Invalid MCP JWT JWK set');
    }
    return;
  }

  let credentials: unknown;
  try { credentials = JSON.parse(env.API_NOVA_RUNTIME_API_KEYS || ''); }
  catch { throw new Error('Invalid MCP runtime API key configuration'); }
  const requiredScopes = (env.API_NOVA_RUNTIME_REQUIRED_SCOPES || '').split(/\s+/).filter(Boolean);
  if (!Array.isArray(credentials) || !credentials.some((item: any) =>
    item && typeof item.id === 'string' && item.id &&
    typeof item.subject === 'string' && item.subject &&
    typeof item.secretHash === 'string' && /^[a-f0-9]{64}$/i.test(item.secretHash) &&
    Number.isFinite(item.expiresAt) && item.expiresAt > Date.now() / 1000 &&
    Array.isArray(item.resources) && item.resources.includes(resource) &&
    Array.isArray(item.scopes) && requiredScopes.every(scope => item.scopes.includes(scope)))) {
    throw new Error('No usable MCP runtime API key is configured');
  }
}

export function persistedMcpInboundMode(
  server: MCPServerEntity,
  env: NodeJS.ProcessEnv = process.env,
): McpRuntimeAuthMode {
  const configured = configuredMcpInboundAuthMode(server.inboundAuthMode);
  if (!configured) throw new Error('MCP inbound authentication mode is required before starting');
  const mode: McpRuntimeAuthMode = configured === McpInboundAuthMode.PRIVATE_JWT ? 'jwt'
    : configured === McpInboundAuthMode.PRIVATE_API_KEY ? 'api_key' : 'anonymous';
  preflightMcpInboundCredentials(mode, env,
    typeof server.config?.runtimeAssetId === 'string' ? server.config.runtimeAssetId : '');
  return mode;
}

/** Only used at spawn time; credential values never enter ProcessConfig or ProcessInfo. */
export function mcpInboundSpawnEnv(
  mode: McpRuntimeAuthMode,
  inherited: NodeJS.ProcessEnv = process.env,
  expectedRuntimeAssetId?: string,
): NodeJS.ProcessEnv {
  preflightMcpInboundCredentials(mode, inherited, expectedRuntimeAssetId);
  const env: NodeJS.ProcessEnv = { ...inherited, API_NOVA_RUNTIME_AUTH_MODE: mode };
  for (const key of INBOUND_CREDENTIAL_KEYS) delete env[key];
  if (mode === 'jwt') {
    env.API_NOVA_RUNTIME_ISSUER = inherited.API_NOVA_RUNTIME_ISSUER;
    if (inherited.API_NOVA_RUNTIME_JWKS_URI) {
      env.API_NOVA_RUNTIME_JWKS_URI = inherited.API_NOVA_RUNTIME_JWKS_URI;
    } else {
      env.API_NOVA_RUNTIME_JWKS_JSON = inherited.API_NOVA_RUNTIME_JWKS_JSON;
    }
  } else if (mode === 'api_key') {
    if (inherited.API_NOVA_RUNTIME_ACCESS_CREDENTIALS !== undefined) {
      env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = inherited.API_NOVA_RUNTIME_ACCESS_CREDENTIALS;
    } else env.API_NOVA_RUNTIME_API_KEYS = inherited.API_NOVA_RUNTIME_API_KEYS;
  }
  return env;
}
