import { authenticateRuntimeRequest, auditDigest, beginRuntimeCall, captureAuditBody, getRuntimeCallContext, RuntimeAuthError,
  RuntimeCallContext, runtimeChallenge } from 'api-nova-parser';
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function authenticateMcpRequest(req: IncomingMessage, requestId: string): Promise<RuntimeCallContext & { expiresAt?: number }> {
  const principal = await authenticateRuntimeRequest(req.headers, 'mcp');
  const session = req.headers['mcp-session-id'] || new URL(req.url || '/', 'http://localhost').searchParams.get('sessionId');
  return { transport: 'mcp', requestId, callerId: principal.callerId, callerIssuer: principal.issuer,
    callerSubject: principal.subject, credentialId: principal.credentialId, clientId: principal.clientId,
    scopes: principal.scopes, identitySource: principal.identitySource, expiresAt: principal.expiresAt,
    correlationId: typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined,
    sessionIdHash: typeof session === 'string' ? auditDigest(session) : undefined,
    clientIp: req.socket.remoteAddress };
}

export async function assertMcpToolScopes(body: any): Promise<void> {
  try { checkMcpToolScopes(body); }
  catch (error) {
    const context = getRuntimeCallContext();
    if (context && body?.method === 'tools/call' && error instanceof RuntimeAuthError) {
      const call = beginRuntimeCall({ ...context, toolName: String(body.params?.name || '') }, 'tool');
      await call.finish({ request: captureAuditBody(body.params), response: captureAuditBody({ error: error.code }),
        statusCode: error.status, outcome: 'error', errorCode: error.code });
    }
    throw error;
  }
}

function checkMcpToolScopes(body: any): void {
  if (body?.method !== 'tools/call') return;
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
