import { assertTemporaryAnonymousPolicy, readTemporaryAnonymousEnvironment, authenticateRuntimeRequest, auditDigest, beginRuntimeCall, captureAuditBody, getRuntimeCallContext, RuntimeAuthError,
  RuntimeCallContext, runtimeChallenge } from 'api-nova-parser';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsRequest, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

export async function authenticateMcpRequest(req: IncomingMessage, requestId: string): Promise<RuntimeCallContext & { expiresAt?: number; authorizationExpiresAt?: number }> {
  const principal = await authenticateRuntimeRequest(req.headers, 'mcp');
  if (principal.identitySource === 'anonymous') {
    const temporaryPolicy = readTemporaryAnonymousEnvironment();
    if (temporaryPolicy !== undefined) assertTemporaryAnonymousPolicy(temporaryPolicy);
  }
  const session = req.headers['mcp-session-id'] || new URL(req.url || '/', 'http://localhost').searchParams.get('sessionId');
  return { transport: 'mcp', requestId, callerId: principal.callerId, callerIssuer: principal.issuer,
    callerSubject: principal.subject, credentialId: principal.credentialId, clientId: principal.clientId,
    scopes: principal.scopes, toolScopes: principal.toolScopes, identitySource: principal.identitySource, expiresAt: principal.expiresAt, authorizationExpiresAt: principal.authorizationExpiresAt,
    correlationId: typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined,
    sessionIdHash: typeof session === 'string' ? auditDigest(session) : undefined,
    clientIp: req.socket.remoteAddress };
}

const filteredToolLists = new WeakSet<object>();

/** Preserve SDK-generated metadata and filter only this request's result. */
export function installMcpToolListScopeFilter(server: McpServer): void {
  const protocol = server.server;
  // Registration-only library adapters have no SDK request dispatcher.
  if (!protocol) return;
  if (filteredToolLists.has(protocol)) return;
  // SDK 1.29 has no public handler getter. Keep this compatibility bridge local;
  // never inspect or mutate McpServer's shared registered-tool enabled state.
  type ListHandler = (request: ListToolsRequest, extra: unknown) => ListToolsResult | Promise<ListToolsResult>;
  const handlers = (protocol as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  if (!(handlers instanceof Map)) throw new Error('Unsupported MCP tool-list dispatcher');
  const original = handlers.get('tools/list');
  if (!original) return; // No tools have initialized the SDK list handler yet.
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const context = getRuntimeCallContext();
    const networkRequest = context?.transport === 'mcp' &&
      (context.protocolTransport === 'streamable' || context.protocolTransport === 'sse');
    const result = await original(request, extra);
    if (!networkRequest) return result;
    const tools = result.tools.filter(tool => {
      try {
        checkMcpToolScopes({ method: 'tools/call', params: { name: tool.name } });
        return true;
      } catch (error) {
        if (error instanceof RuntimeAuthError && error.status === 403) return false;
        // Configuration errors must not silently expose an unfiltered list.
        throw new McpError(ErrorCode.InternalError, 'Invalid MCP tool scope configuration');
      }
    });
    return { ...result, tools };
  });
  filteredToolLists.add(protocol);
}

/** Recheck mutable tool rules at execution without authenticating local calls. */
export async function assertMcpToolExecutionScopes(toolName: string): Promise<void> {
  const context = getRuntimeCallContext();
  if (context?.transport !== 'mcp' ||
    (context.protocolTransport !== 'streamable' && context.protocolTransport !== 'sse')) return;
  await assertMcpToolScopes({ method: 'tools/call', params: { name: toolName } });
}

export async function assertMcpToolScopes(body: any): Promise<void> {
  try { checkMcpToolScopes(body); }
  catch (error) {
    const context = getRuntimeCallContext();
    if (context && body?.method === 'tools/call' && error instanceof RuntimeAuthError) {
      try {
        const call = beginRuntimeCall({ ...context, toolName: String(body.params?.name || ''),
          byteMeasurement: 'serialized_payload', measurementStage: 'logical_payload' }, 'tool');
        void call.finish({ request: captureAuditBody(body.params), response: captureAuditBody({ error: error.code }),
          statusCode: error.status, outcome: 'error', errorCategory: 'authorization',
          failureStage: 'admission', errorCode: error.code }).catch(() => undefined);
      } catch { /* Evidence failure must not replace the authorization rejection. */ }
    }
    throw error;
  }
}

function checkMcpToolScopes(body: any): void {
  if (body?.method !== 'tools/call') return;
  const context = getRuntimeCallContext();
  if (context?.identitySource === 'anonymous' && context.transport === 'mcp' &&
      (context.protocolTransport === 'streamable' || context.protocolTransport === 'sse')) {
    const policy = readTemporaryAnonymousEnvironment();
    if (policy !== undefined) assertTemporaryAnonymousPolicy(policy);
  }
  const allowedTools = getRuntimeCallContext()?.toolScopes;
  if (allowedTools !== undefined && !allowedTools.includes('*') && !allowedTools.includes(body.params?.name))
    throw new RuntimeAuthError(403, 'tool_forbidden');
  let rules: Record<string, string[]>;
  try { rules = JSON.parse(process.env.API_NOVA_MCP_TOOL_SCOPES || '{}'); }
  catch { throw new RuntimeAuthError(503, 'invalid_tool_scope_configuration'); }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new RuntimeAuthError(503, 'invalid_tool_scope_configuration');
  if (!Object.prototype.hasOwnProperty.call(rules, body.params?.name)) return;
  const required = rules[body.params?.name];
  if (required === undefined) return;
  if (!Array.isArray(required) || required.some(scope => typeof scope !== 'string'))
    throw new RuntimeAuthError(503, 'invalid_tool_scope_configuration');
  if (required.some(scope => !getRuntimeCallContext()?.scopes?.includes(scope)))
    throw new RuntimeAuthError(403, 'insufficient_scope', required);
}

export function sendMcpAuthError(res: ServerResponse, error: RuntimeAuthError): void {
  res.setHeader('Cache-Control', 'no-store');
  if (error.status === 401 || error.status === 403)
    res.setHeader('WWW-Authenticate', runtimeChallenge('mcp', error.status === 403, error.requiredScopes));
  res.writeHead(error.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: error.code }));
}
