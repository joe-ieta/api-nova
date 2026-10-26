export const MANAGED_MCP_CONFIG_ENV = 'API_NOVA_MANAGED_MCP_CONFIG';
export const MANAGED_MCP_CONFIG_INVALID = 'MANAGED_MCP_CONFIG_INVALID';
export const MANAGED_MCP_CONFIG_MAX_BYTES = 65536;

export type ManagedMcpConfigKey = 'handoffSources' | 'lifecycleApproval';

const CONFIG_KEYS: readonly ManagedMcpConfigKey[] = ['handoffSources', 'lifecycleApproval'];

interface ConfigReader {
  get(key: string, ...rest: unknown[]): unknown;
}

function boundedCopy(value: unknown, depth = 0, budget = { nodes: 0, characters: 0 }): unknown {
  if (depth > 12 || ++budget.nodes > 4096) throw new Error(MANAGED_MCP_CONFIG_INVALID);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(MANAGED_MCP_CONFIG_INVALID);
    return value;
  }
  if (typeof value === 'string') {
    if ((budget.characters += value.length) > 65536) throw new Error(MANAGED_MCP_CONFIG_INVALID);
    return value;
  }
  if (!value || typeof value !== 'object') throw new Error(MANAGED_MCP_CONFIG_INVALID);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    throw new Error(MANAGED_MCP_CONFIG_INVALID);
  }
  const result: any = array ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(MANAGED_MCP_CONFIG_INVALID);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error(MANAGED_MCP_CONFIG_INVALID);
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error(MANAGED_MCP_CONFIG_INVALID);
    result[key] = boundedCopy(descriptor.value, depth + 1, budget);
  }
  return result;
}

export function parseManagedMcpConfigEnvelope(text: unknown): Record<ManagedMcpConfigKey, unknown> | undefined {
  if (text === undefined || text === null) return undefined;
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > MANAGED_MCP_CONFIG_MAX_BYTES) {
    throw new Error(MANAGED_MCP_CONFIG_INVALID);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(MANAGED_MCP_CONFIG_INVALID);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(MANAGED_MCP_CONFIG_INVALID);
  const keys = Object.keys(parsed);
  if (!keys.length || keys.some(key => !CONFIG_KEYS.includes(key as ManagedMcpConfigKey))) {
    throw new Error(MANAGED_MCP_CONFIG_INVALID);
  }
  return boundedCopy(parsed) as Record<ManagedMcpConfigKey, unknown>;
}

export function resolveManagedMcpConfigValue(
  config: ConfigReader,
  configKey: string,
  envKey: ManagedMcpConfigKey,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  const injected = config.get(configKey);
  if (injected !== undefined) return injected;
  const envelope = parseManagedMcpConfigEnvelope(env[MANAGED_MCP_CONFIG_ENV]);
  return envelope ? envelope[envKey] : undefined;
}
