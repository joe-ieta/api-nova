import { createHash, generateKeyPairSync } from 'node:crypto';
import { MCPServerEntity, McpInboundAuthMode } from '../../../database/entities/mcp-server.entity';
import {
  mcpInboundSpawnEnv,
  persistedMcpInboundMode,
  preflightMcpInboundCredentials,
} from './mcp-inbound-process-env';

const resource = 'https://runtime.example/mcp';
const publicJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
function server(mode?: McpInboundAuthMode): MCPServerEntity {
  return { inboundAuthMode: mode } as MCPServerEntity;
}
function apiKeyEnv(): NodeJS.ProcessEnv {
  return {
    API_NOVA_RUNTIME_AUTH_MODE: 'jwt',
    API_NOVA_MCP_RESOURCE: resource,
    API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{
      id: 'credential-1', subject: 'consumer',
      secretHash: createHash('sha256').update('secret').digest('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 120,
      resources: [resource], scopes: [],
    }]),
    API_NOVA_RUNTIME_ISSUER: 'https://issuer.example',
    API_NOVA_RUNTIME_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
  };
}

describe('persisted MCP inbound authentication process environment', () => {
  it('rejects legacy or unknown mode even when global AUTH_MODE and outbound authConfig are set', () => {
    const legacy = { ...server(), authConfig: { type: 'bearer', config: { bearerToken: 'outbound' } } };
    expect(() => persistedMcpInboundMode(legacy as MCPServerEntity, apiKeyEnv()))
      .toThrow('mode is required');
    expect(() => persistedMcpInboundMode({ ...legacy, inboundAuthMode: 'unknown' } as any, apiKeyEnv()))
      .toThrow('mode is required');
  });

  it('uses selected anonymous mode without inheriting JWT or API-key credentials', () => {
    const env = apiKeyEnv();
    expect(persistedMcpInboundMode(server(McpInboundAuthMode.ANONYMOUS), env)).toBe('anonymous');
    const child = mcpInboundSpawnEnv('anonymous', env);
    expect(child.API_NOVA_RUNTIME_AUTH_MODE).toBe('anonymous');
    expect(child.API_NOVA_RUNTIME_API_KEYS).toBeUndefined();
    expect(child.API_NOVA_RUNTIME_ISSUER).toBeUndefined();
    expect(child.API_NOVA_RUNTIME_JWKS_JSON).toBeUndefined();
  });

  it('maps private API-key to api_key and rejects missing, expired, or unrelated credentials', () => {
    const env = apiKeyEnv();
    expect(persistedMcpInboundMode(server(McpInboundAuthMode.PRIVATE_API_KEY), env)).toBe('api_key');
    const child = mcpInboundSpawnEnv('api_key', env);
    expect(child.API_NOVA_RUNTIME_AUTH_MODE).toBe('api_key');
    expect(child.API_NOVA_RUNTIME_API_KEYS).toBe(env.API_NOVA_RUNTIME_API_KEYS);
    expect(child.API_NOVA_RUNTIME_ISSUER).toBeUndefined();
    expect(() => preflightMcpInboundCredentials('api_key', { ...env, API_NOVA_RUNTIME_API_KEYS: '' }))
      .toThrow('API key');
    const unrelated = JSON.stringify([{ ...JSON.parse(env.API_NOVA_RUNTIME_API_KEYS!)[0], resources: ['https://other.example/mcp'] }]);
    expect(() => preflightMcpInboundCredentials('api_key', { ...env, API_NOVA_RUNTIME_API_KEYS: unrelated }))
      .toThrow('No usable');
    const expired = JSON.stringify([{ ...JSON.parse(env.API_NOVA_RUNTIME_API_KEYS!)[0], expiresAt: 0 }]);
    expect(() => preflightMcpInboundCredentials('api_key', { ...env, API_NOVA_RUNTIME_API_KEYS: expired }))
      .toThrow('No usable');
  });

  it('maps private JWT to jwt and rejects missing or malformed JWK/issuer/resource', () => {
    const env = apiKeyEnv();
    expect(persistedMcpInboundMode(server(McpInboundAuthMode.PRIVATE_JWT), env)).toBe('jwt');
    const child = mcpInboundSpawnEnv('jwt', env);
    expect(child.API_NOVA_RUNTIME_AUTH_MODE).toBe('jwt');
    expect(child.API_NOVA_RUNTIME_API_KEYS).toBeUndefined();
    expect(child.API_NOVA_RUNTIME_JWKS_JSON).toBe(env.API_NOVA_RUNTIME_JWKS_JSON);
    expect(() => preflightMcpInboundCredentials('jwt', { ...env, API_NOVA_RUNTIME_JWKS_JSON: '' }))
      .toThrow('JWK set');
    expect(() => preflightMcpInboundCredentials('jwt', { ...env, API_NOVA_RUNTIME_JWKS_JSON: '{\"keys\":[{\"kty\":\"RSA\"}]}' }))
      .toThrow('Invalid MCP JWT JWK set');
    expect(() => preflightMcpInboundCredentials('jwt', { ...env, API_NOVA_RUNTIME_ISSUER: 'http://other.example' }))
      .toThrow('HTTPS');
    expect(() => preflightMcpInboundCredentials('jwt', { ...env, API_NOVA_MCP_RESOURCE: '' }))
      .toThrow('resource');
  });
});

function unifiedEnv(runtimeAssetId = 'runtime-1'): NodeJS.ProcessEnv {
  return { API_NOVA_RUNTIME_ACCESS_CREDENTIALS: JSON.stringify({ version: 1, runtimeAssetId,
    credentials: [{ version: 1, id: 'key-1', keyId: 'key_1', secretHash: 'a'.repeat(64), status: 'active',
      subject: 'worker', protocols: ['mcp'], runtimeAssetId, toolScopes: ['*'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 120 }] }) };
}
describe('unified credentials bind managed process ownership', () => {
  it('requires the persisted runtime owner and rejects another runtime using the same inherited envelope', () => {
    const owned = { ...server(McpInboundAuthMode.PRIVATE_API_KEY), config: { runtimeAssetId: 'runtime-1' } } as unknown as MCPServerEntity;
    expect(persistedMcpInboundMode(owned, unifiedEnv())).toBe('api_key');
    expect(() => persistedMcpInboundMode({ ...owned, config: { runtimeAssetId: 'runtime-2' } } as any, unifiedEnv())).toThrow('unified MCP');
    expect(() => persistedMcpInboundMode(server(McpInboundAuthMode.PRIVATE_API_KEY), unifiedEnv())).toThrow('unified MCP');
  });
  it('checks ownership again at spawn while standalone explicit host config remains usable', () => {
    expect(mcpInboundSpawnEnv('api_key', unifiedEnv(), 'runtime-1').API_NOVA_RUNTIME_ACCESS_CREDENTIALS).toBeDefined();
    expect(() => mcpInboundSpawnEnv('api_key', unifiedEnv(), 'runtime-2')).toThrow('unified MCP');
    expect(() => mcpInboundSpawnEnv('api_key', unifiedEnv(), '')).toThrow('unified MCP');
    expect(mcpInboundSpawnEnv('api_key', unifiedEnv()).API_NOVA_RUNTIME_ACCESS_CREDENTIALS).toBeDefined();
  });
});

it('refuses a static envelope whose only key passed its rotation cutoff', () => {
  const env = unifiedEnv();
  const envelope = JSON.parse(env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS!);
  envelope.credentials[0].validUntil = Math.floor(Date.now() / 1000) - 1;
  env.API_NOVA_RUNTIME_ACCESS_CREDENTIALS = JSON.stringify(envelope);
  expect(() => mcpInboundSpawnEnv('api_key', env, 'runtime-1')).toThrow('unified MCP');
});
