import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { transformToMCPTools, compileTrustedOperationBindings, readStableUpstreamCredentialText,
  parseUpstreamCredentialBindings, UpstreamCredentialRegistry, resolveUpstreamCredential,
  runtimeAuthMode, runtimeResource, requiredRuntimeScopes, type OpenAPISpec } from 'api-nova-parser';
import { startStreamableMcpServer } from '../transportUtils/stream';
import { startSseMcpServer } from '../transportUtils/sse';
import { registerManagedMcpTools } from '../tools/initTools';
import { ManagedMcpHandoffV1, ManagedRuntimeRevisions } from './handoff';

function fingerprint(value: any): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function checkConsumerAuthentication(): void {
  if (runtimeAuthMode() !== 'api_key') throw new Error();
  const resource = runtimeResource('mcp'), required = requiredRuntimeScopes();
  const keys = JSON.parse(process.env.API_NOVA_RUNTIME_API_KEYS || 'null');
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000) throw new Error();
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key || typeof key !== 'object' || typeof key.secretHash !== 'string' || !/^[a-f0-9]{64}$/i.test(key.secretHash) ||
      typeof key.id !== 'string' || !key.id || typeof key.subject !== 'string' || !key.subject || key.subject.length > 512 ||
      !Number.isFinite(key.expiresAt) || key.expiresAt <= Date.now() / 1000 || !Array.isArray(key.resources) || !key.resources.includes(resource) ||
      !Array.isArray(key.scopes) || key.scopes.some((scope: unknown) => typeof scope !== 'string') || required.some(scope => !key.scopes.includes(scope)) || seen.has(key.secretHash.toLowerCase())) throw new Error();
    seen.add(key.secretHash.toLowerCase());
  }
  const rules = JSON.parse(process.env.API_NOVA_MCP_TOOL_SCOPES || '{}');
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.values(rules).some(scopes => !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string'))) throw new Error();
}

/** No CLI, default document, external reference fetch, automatic redirect or
 * registry watcher. All credentials are resolved before binding the listener.
 * Runtime calls still use the standard Parser single-hop Resolver path. */
export async function activateManagedRuntime(payload: ManagedMcpHandoffV1): Promise<{ close(): Promise<void>; revisions: ManagedRuntimeRevisions }> {
  checkConsumerAuthentication();
  if (payload.transport.host !== '127.0.0.1' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(payload.transport.endpoint) ||
    payload.transport.endpoint === '/health' || payload.transport.endpoint.startsWith('/health/') || !payload.trustedOperationBindings.length ||
    fingerprint(payload.openApiData) !== payload.behaviorFingerprint) throw new Error();
  const source = payload.registrySource;
  const text = await readStableUpstreamCredentialText(source.path);
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== source.expectedContentDigest) throw new Error();
  const candidate = parseUpstreamCredentialBindings(text, source.format);
  if (candidate.metadata.revision !== source.expectedRevision || candidate.metadata.environment !== source.environment || candidate.reload.mode !== 'manual') throw new Error();
  const spec = payload.openApiData as OpenAPISpec;
  const compiled = compileTrustedOperationBindings(spec, payload.trustedOperationBindings);
  const sources = new Set(payload.trustedOperationBindings.map(binding => binding.sourceServiceAssetId));
  if (candidate.sites.some(site => !sources.has(site.sourceServiceAssetId))) throw new Error();
  const registry = new UpstreamCredentialRegistry({ environment: source.environment });
  // Activate the very text whose digest was checked, never a second file read.
  const snapshot = await registry.reloadText(text, source.format);
  const baseUrl = spec.servers?.[0]?.url;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || baseUrl.includes('{')) throw new Error();
  const target = new URL(baseUrl);
  if (target.username || target.password || target.search || target.hash) throw new Error();
  for (const binding of payload.trustedOperationBindings) {
    if (!compiled.get(binding.method, binding.path)) throw new Error();
    const url = baseUrl.replace(/\/+$/, '') + '/' + binding.path.replace(/^\/+/, '').replace(/\{[^}]+\}/g, 'managed-preflight');
    await resolveUpstreamCredential(snapshot, { sourceServiceAssetId: binding.sourceServiceAssetId, endpointDefinitionId: binding.endpointDefinitionId, url });
  }
  const tools = transformToMCPTools(spec, { baseUrl, includeDeprecated: true, requestTimeout: 30000,
    trustedOperationBindings: payload.trustedOperationBindings,
    upstreamCredentialPolicy: Object.freeze({ mode: 'single-hop' as const, captureSnapshot: () => snapshot }) });
  if (tools.length !== payload.trustedOperationBindings.length) throw new Error();
  const names = new Set<string>(), selectors = new Set<string>();
  for (const tool of tools) {
    const method = tool.metadata?.method?.toUpperCase(), path = tool.metadata?.path;
    if (!method || !path || !compiled.get(method, path) || names.has(tool.name) || selectors.has(method + ' ' + path)) throw new Error();
    names.add(tool.name); selectors.add(method + ' ' + path);
  }
  const sessions = new Set<McpServer>();
  const factory = async () => {
    const server = new McpServer({ name: 'api-nova-managed', version: '1' }, { capabilities: { tools: {} } });
    try { registerManagedMcpTools(server, tools); sessions.add(server); return server; }
    catch { await server.close(); throw new Error('MANAGED_RUNTIME_FAILED'); }
  };
  // Validate SDK registration before listening, not on the first consumer session.
  const probe = await factory(); await probe.close(); sessions.delete(probe);
  let http: Server | undefined, closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const closed = http?.listening ? new Promise<void>(resolve => http!.close(() => resolve())) : Promise.resolve();
      http?.closeAllConnections();
      await Promise.allSettled([...sessions].map(server => server.close()));
      sessions.clear(); await closed;
    })();
    return closing;
  };
  try {
    const start = payload.transport.type === 'sse' ? startSseMcpServer : startStreamableMcpServer;
    http = await start(factory, payload.transport.endpoint, payload.transport.port, { host: '127.0.0.1' });
    if (!http.listening) await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== payload.transport.port) throw new Error();
    return { close, revisions: Object.freeze({ candidateRevision: payload.candidateRevision, verificationRunId: payload.verificationRunId,
      behaviorFingerprint: payload.behaviorFingerprint, registryRevision: source.expectedRevision, registryContentDigest: source.expectedContentDigest,
      authMode: 'api_key', credentialMode: 'single-hop' }) };
  } catch { await close(); throw new Error('MANAGED_RUNTIME_FAILED'); }
}
