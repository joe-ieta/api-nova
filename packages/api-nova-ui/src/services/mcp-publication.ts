export type McpInboundAuthMode = 'private_jwt' | 'private_api_key' | 'anonymous';
export function configuredMcpMode(value: unknown): McpInboundAuthMode | undefined {
  return value === 'private_jwt' || value === 'private_api_key' || value === 'anonymous' ? value : undefined;
}
export const temporaryAnonymousDraft = (saved?: any) => ({ enabled: saved !== undefined, locked: saved !== undefined, reason: typeof saved?.reason === 'string' ? saved.reason : '', expiresAt: typeof saved?.expiresAt === 'string' ? saved.expiresAt : '', allowProduction: saved?.allowProduction === true, actor: typeof saved?.actor === 'string' ? saved.actor : '' });
export function temporaryAnonymousError(draft: ReturnType<typeof temporaryAnonymousDraft>): 'anonymousReason' | 'anonymousExpiry' | null {
  if (!draft.enabled && !draft.locked) return null;
  if (!draft.reason.trim() || draft.reason.trim().length > 500) return 'anonymousReason';
  if (typeof draft.expiresAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(draft.expiresAt) || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) <= Date.now()) return 'anonymousExpiry';
  return null;
}
export function temporaryAnonymousInput(draft: ReturnType<typeof temporaryAnonymousDraft>) {
  return draft.enabled || draft.locked ? { reason: draft.reason.trim(), expiresAt: new Date(draft.expiresAt).toISOString(), allowProduction: draft.allowProduction } : undefined;
}
export function gatewayTemporaryAnonymousConfig(form: { routeVisibility: string; authPolicyRef: string; upstreamConfig: Record<string, unknown>; temporaryAnonymous: ReturnType<typeof temporaryAnonymousDraft> }) {
  if (form.routeVisibility !== 'external' || !/^anonymous(?:[-_:].+)?$/i.test(form.authPolicyRef.trim())) return {};
  const error = temporaryAnonymousError(form.temporaryAnonymous); if (error) throw new Error(error);
  const grant = temporaryAnonymousInput(form.temporaryAnonymous);
  return grant ? { upstreamConfig: { ...form.upstreamConfig, temporaryAnonymous: grant } } : {};
}
export type McpTransport = 'streamable' | 'sse';
export interface McpDeploymentInput { temporaryAnonymous?: { reason: string; expiresAt: string; allowProduction: boolean }; targetServerId?: string; inboundAuthMode?: McpInboundAuthMode; transport?: McpTransport; port?: number; endpointPath?: string; missingSmokeWaiverReason?: string; autoStart?: boolean; name?: string; description?: string; }
export interface McpEndpointPreview { inboundAuthMode: McpInboundAuthMode | 'unknown'; effectiveInboundAuthMode: 'unknown'; transport: McpTransport; port: number | null; endpointPath: string; portMode: 'automatic' | 'existing' | 'explicit'; consumerUrl: string | null; messagesUrl: string | null; addressScope: 'loopback'; availability: 'not_checked'; }
export async function mcpPublicationRequest(id: string, operation: 'detail' | 'preview' | 'deploy' | 'redeploy', token: string, signal: AbortSignal, input?: McpDeploymentInput) {
  const suffix = operation === 'detail' ? '' : operation === 'preview' ? '/mcp-endpoint-preview' : operation === 'redeploy' ? '/redeploy' : '/deploy-mcp';
  const response = await fetch('/api/v1/runtime-assets/' + encodeURIComponent(id) + suffix, {
    method: operation === 'detail' ? 'GET' : 'POST', signal, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(operation === 'detail' ? {} : { body: JSON.stringify(input) }),
  });
  const body = await response.json();
  if (!response.ok) {
    const code = body?.code ?? body?.message?.code;
    if (typeof body?.message === 'string' && /temporary[ _]anonymous/i.test(body.message)) throw new Error('TEMPORARY_ANONYMOUS_REJECTED');
    throw new Error(['MCP_INBOUND_AUTH_MODE_REQUIRED', 'MCP_INBOUND_AUTH_MODE_CHANGE_REQUIRES_STOP'].includes(code) ? code : 'MCP_PUBLICATION_FAILED');
  }
  return body;
}
export const mcpPublicationState = () => ({ visible: false, loading: false, previewLoading: false, saving: false,
  temporaryAnonymous: temporaryAnonymousDraft(), error: null as 'load' | 'preview' | 'deploy' | 'authRequired' | 'authStop' | 'anonymousReason' | 'anonymousExpiry' | 'anonymousRejected' | null, id: '', transport: 'streamable' as McpTransport,
  inboundAuthMode: undefined as McpInboundAuthMode | undefined, savedInboundAuthMode: undefined as McpInboundAuthMode | undefined,
  port: undefined as number | undefined, endpointPath: '/mcp', targetServerId: undefined as string | undefined,
  actualEndpoint: null as string | null, actualStatus: null as string | null, preview: null as McpEndpointPreview | null });
export class McpPublicationForm {
  private generation = 0; private controller: AbortController | null = null;
  private mode: 'deploy' | 'redeploy' = 'deploy';
  private owner: string | null = null; private waiver: string | undefined;
  private done: ((saved: boolean) => void) | null = null;
  constructor(readonly state: ReturnType<typeof mcpPublicationState>, private session: () => { key: string; token: string } | null, private request = mcpPublicationRequest) {}
  close(saved = false) { this.generation++; this.controller?.abort(); this.controller = null; this.owner = null;
    Object.assign(this.state, mcpPublicationState()); this.done?.(saved); this.done = null; }
  open(id: string, waiver?: string, mode: 'deploy' | 'redeploy' = 'deploy'): Promise<boolean> {
    this.close(); const session = this.session(); if (!session) return Promise.resolve(false);
    this.owner = session.key; this.waiver = waiver; this.mode = mode; this.state.visible = true; this.state.id = id;
    const result = new Promise<boolean>(resolve => { this.done = resolve; }); void this.load(); return result;
  }
  private valid(generation: number) { return generation === this.generation && this.owner === this.session()?.key; }
  private begin() { this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation; const deadline = setTimeout(() => controller.abort(), 10000);
    return { controller, generation, finish: () => clearTimeout(deadline) }; }
  private input(): McpDeploymentInput { return { ...(this.state.inboundAuthMode === 'anonymous' && !temporaryAnonymousError(this.state.temporaryAnonymous) ? { temporaryAnonymous: temporaryAnonymousInput(this.state.temporaryAnonymous) } : {}), targetServerId: this.state.targetServerId, inboundAuthMode: this.state.inboundAuthMode, transport: this.state.transport,
    ...(this.state.port === undefined ? {} : { port: this.state.port }), endpointPath: this.state.endpointPath,
    ...(this.waiver ? { missingSmokeWaiverReason: this.waiver } : {}) }; }
  authBlock(): 'authRequired' | 'authStop' | 'anonymousReason' | 'anonymousExpiry' | null {
    if (!configuredMcpMode(this.state.inboundAuthMode)) return 'authRequired';
    if (this.state.inboundAuthMode === 'anonymous' && temporaryAnonymousError(this.state.temporaryAnonymous)) return temporaryAnonymousError(this.state.temporaryAnonymous);
    return this.state.actualStatus === 'running' && this.state.inboundAuthMode !== this.state.savedInboundAuthMode ? 'authStop' : null;
  }
  async load() {
    const session = this.session(); if (!session || !this.state.visible) return;
    const task = this.begin(); this.state.loading = true; this.state.error = null;
    try {
      const detail = await this.request(this.state.id, 'detail', session.token, task.controller.signal);
      if (!this.valid(task.generation)) return;
      if (detail?.asset?.type !== 'mcp_server') throw new Error('INVALID_DETAIL');
      const server = detail.managedServer;
      if (server && (!['streamable', 'sse'].includes(server.transport) || !Number.isInteger(server.port))) throw new Error('INVALID_DETAIL');
      this.state.temporaryAnonymous = temporaryAnonymousDraft(server?.temporaryAnonymous);
      this.state.savedInboundAuthMode = configuredMcpMode(server?.inboundAuthMode);
      this.state.inboundAuthMode = this.state.savedInboundAuthMode;
      this.state.transport = server?.transport ?? 'streamable'; this.state.port = server?.port;
      this.state.endpointPath = server?.endpointPath ?? (this.state.transport === 'sse' ? '/sse' : '/mcp');
      this.state.targetServerId = server?.id; this.state.actualEndpoint = server?.endpoint ?? null; this.state.actualStatus = server?.status ?? null;
    } catch { if (this.valid(task.generation)) this.state.error = 'load'; }
    finally { task.finish(); if (this.valid(task.generation)) { this.state.loading = false; if (!this.state.error) void this.refresh(); } }
  }
  async refresh() {
    if (!this.state.visible || this.state.loading || this.state.saving || this.state.error === 'load') return;
    const session = this.session(); if (!session) { this.close(); return; }
    const task = this.begin(); this.state.preview = null; this.state.previewLoading = true; this.state.error = null;
    try {
      const preview = await this.request(this.state.id, 'preview', session.token, task.controller.signal, this.input());
      if (!this.valid(task.generation)) return;
      if (preview?.addressScope !== 'loopback' || preview?.availability !== 'not_checked' ||
        preview.inboundAuthMode !== (this.state.inboundAuthMode ?? 'unknown') || preview.effectiveInboundAuthMode !== 'unknown' ||
        preview.transport !== this.state.transport || preview.endpointPath !== this.state.endpointPath ||
        !(preview.port === null || Number.isInteger(preview.port))) throw new Error('INVALID_PREVIEW');
      this.state.preview = preview;
    } catch { if (this.valid(task.generation)) this.state.error = 'preview'; }
    finally { task.finish(); if (this.valid(task.generation)) this.state.previewLoading = false; }
  }
  async save() {
    if (this.authBlock()) { this.state.error = this.authBlock(); return; }
    if (this.state.preview?.inboundAuthMode !== this.state.inboundAuthMode) { this.state.preview = null; return; }
    if (!this.state.preview || this.state.saving || this.state.previewLoading || this.state.loading) return;
    const session = this.session(); if (!session || session.key !== this.owner) { this.close(); return; }
    const task = this.begin(); this.state.saving = true; this.state.error = null;
    try { await this.request(this.state.id, this.mode, session.token, task.controller.signal, this.input());
      if (this.valid(task.generation)) this.close(true);
    } catch (error) { if (this.valid(task.generation)) {
      this.state.error = error instanceof Error && error.message === 'MCP_INBOUND_AUTH_MODE_REQUIRED' ? 'authRequired'
        : error instanceof Error && error.message === 'MCP_INBOUND_AUTH_MODE_CHANGE_REQUIRES_STOP' ? 'authStop' : error instanceof Error && error.message === 'TEMPORARY_ANONYMOUS_REJECTED' ? 'anonymousRejected' : 'deploy';
      this.state.preview = null;
    } }
    finally { task.finish(); if (this.valid(task.generation)) this.state.saving = false; }
  }
}
