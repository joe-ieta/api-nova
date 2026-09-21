export interface UpstreamCredentialStatus {
  configured: boolean; state: string; generation: number; reloading: boolean;
  environment?: string; revision?: string | number; lastReloadError?: unknown;
}
export async function upstreamCredentialRequest(operation: 'status' | 'reload', token: string, signal: AbortSignal,
  input?: { expectedGeneration: number; reason: string }): Promise<UpstreamCredentialStatus> {
  const response = await fetch('/api/security/upstream-credentials/' + operation, {
    method: operation === 'status' ? 'GET' : 'POST', signal, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(operation === 'reload' ? { body: JSON.stringify(input) } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 403 ? 'permission' : response.status === 409 ? 'conflict' : 'request');
  if (!body || typeof body.configured !== 'boolean' || typeof body.state !== 'string' ||
    !Number.isSafeInteger(body.generation) || body.generation < 0 || typeof body.reloading !== 'boolean') throw new Error('response');
  return { configured: body.configured, state: body.state, generation: body.generation, reloading: body.reloading,
    environment: typeof body.environment === 'string' ? body.environment : undefined,
    revision: typeof body.revision === 'string' || typeof body.revision === 'number' ? body.revision : undefined,
    lastReloadError: !!body.lastReloadError };
}
export const upstreamCredentialState = () => ({ status: null as UpstreamCredentialStatus | null, busy: false,
  reason: '', error: '' as '' | 'permission' | 'conflict' | 'request' | 'reason', needsRefresh: true, reloaded: false });
export class UpstreamCredentialPanel {
  private sequence = 0; private controller: AbortController | null = null;
  constructor(readonly state: ReturnType<typeof upstreamCredentialState>, private session: () => { key: string; token: string } | null,
    private request = upstreamCredentialRequest) {}
  close() { this.sequence++; this.controller?.abort(); Object.assign(this.state, upstreamCredentialState()); }
  canReload() { return !!this.session() && !this.state.busy && !this.state.needsRefresh &&
    this.state.status?.configured === true && !this.state.status.reloading; }
  async refresh() { if (!this.state.busy) await this.run('status'); }
  async reload() {
    if (!this.canReload()) return;
    const reason = this.state.reason.trim();
    if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) { this.state.error = 'reason'; return; }
    await this.run('reload', { expectedGeneration: this.state.status!.generation, reason });
  }
  private async run(operation: 'status' | 'reload', input?: { expectedGeneration: number; reason: string }) {
    const current = this.session(); if (!current) return; const session = { ...current };
    const sequence = ++this.sequence, controller = new AbortController(); this.controller = controller;
    const valid = () => sequence === this.sequence && session.key === this.session()?.key;
    const deadline = setTimeout(() => controller.abort(), 10000);
    this.state.busy = true; this.state.error = ''; this.state.reloaded = false; this.state.needsRefresh = true;
    try {
      const result = await this.request(operation, session.token, controller.signal, input);
      if (!valid()) return;
      this.state.status = result; this.state.needsRefresh = false; this.state.reloaded = operation === 'reload';
      if (operation === 'reload') this.state.reason = '';
    } catch (error) {
      if (valid()) { const code = error instanceof Error ? error.message : ''; this.state.error = code === 'permission' || code === 'conflict' ? code : 'request'; }
    } finally { clearTimeout(deadline); if (valid()) this.state.busy = false; }
  }
}
