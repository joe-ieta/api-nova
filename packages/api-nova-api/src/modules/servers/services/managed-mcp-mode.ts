import { MCPServerEntity, McpInboundAuthMode } from '../../../database/entities/mcp-server.entity';

export const TRUSTED_MCP_MODE = 'trusted_ipc_v1';
export const MANAGED_LIFECYCLE_REJECTED = 'MANAGED_MCP_LIFECYCLE_REJECTED';
export const MANAGED_START_CANCELLED = 'MANAGED_MCP_START_CANCELLED';

/** Absence is legacy. An explicit unknown value must never select legacy. */
export function usesTrustedMcp(server: MCPServerEntity): boolean {
  const mode = server.config?.managedMcpMode;
  if (mode === undefined) return false;
  if (mode !== TRUSTED_MCP_MODE) throw new Error(MANAGED_LIFECYCLE_REJECTED);
  return true;
}

export function assertTrustedMcp(server: MCPServerEntity, runtimeAssetId?: string): void {
  const config = server.config || {};
  if (!usesTrustedMcp(server) || server.inboundAuthMode !== McpInboundAuthMode.PRIVATE_API_KEY ||
    config.managedByRuntimeAsset !== true || typeof config.runtimeAssetId !== 'string' ||
    !config.runtimeAssetId || (runtimeAssetId !== undefined && config.runtimeAssetId !== runtimeAssetId) ||
    (server.authConfig && (server.authConfig.type !== 'none' || Object.keys(server.authConfig.config || {}).length > 0)) ||
    (config.customHeaders !== undefined && (!config.customHeaders || typeof config.customHeaders !== 'object' ||
      Array.isArray(config.customHeaders) || Object.keys(config.customHeaders).length > 0)) ||
    config.watch === true) {
    throw new Error(MANAGED_LIFECYCLE_REJECTED);
  }
}
