import { BadRequestException, ConflictException } from '@nestjs/common';
import { MCPServerEntity, ServerStatus, TransportType } from '../../../database/entities/mcp-server.entity';

export interface McpEndpointInput { transport?: TransportType; port?: number; endpointPath?: string; }
export const MCP_ENDPOINT_PATH_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
export function resolveMcpEndpoint(input: McpEndpointInput, server?: MCPServerEntity | null) {
  const transport = input.transport !== undefined ? input.transport : server?.transport ?? TransportType.STREAMABLE;
  const port = input.port !== undefined ? input.port : server?.port ?? null;
  const endpointPath = input.endpointPath !== undefined ? input.endpointPath :
    server?.config?.endpoint ?? (transport === TransportType.SSE ? '/sse' : '/mcp');
  if (![TransportType.STREAMABLE, TransportType.SSE].includes(transport) ||
    (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) ||
    input.port === null || typeof endpointPath !== 'string' || endpointPath.length > 256 ||
    !MCP_ENDPOINT_PATH_PATTERN.test(endpointPath) || endpointPath === '/health' || endpointPath.startsWith('/health/')) {
    throw new BadRequestException('INVALID_MCP_ENDPOINT_CONFIG');
  }
  return { transport, port, endpointPath };
}
export function assertMcpEndpointChange(server: MCPServerEntity | null, next: ReturnType<typeof resolveMcpEndpoint>) {
  if (!server || ![ServerStatus.RUNNING, ServerStatus.STARTING, ServerStatus.STOPPING].includes(server.status)) return;
  const previous = resolveMcpEndpoint({}, server);
  if (previous.port !== next.port || previous.transport !== next.transport || previous.endpointPath !== next.endpointPath) {
    throw new ConflictException('MCP_ENDPOINT_CHANGE_REQUIRES_STOP');
  }
}
export function previewMcpEndpoint(input: McpEndpointInput, server?: MCPServerEntity | null) {
  const resolved = resolveMcpEndpoint(input, server);
  assertMcpEndpointChange(server ?? null, resolved);
  const consumerUrl = resolved.port === null ? null : `http://127.0.0.1:${resolved.port}${resolved.endpointPath}`;
  return { ...resolved, portMode: input.port !== undefined ? 'explicit' : server ? 'existing' : 'automatic',
    consumerUrl, messagesUrl: consumerUrl && resolved.transport === TransportType.SSE ? `${consumerUrl}/messages` : null,
    addressScope: 'loopback', availability: 'not_checked' };
}
