import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { basicCredentialHeader, checkedCredentialSecret } from './secret-material';

export interface StagedHostCredentialGeneration { readonly kind: 'staged-host-credentials' }
export interface HostCredentialGeneration { readonly kind: 'host-credential-generation' }
export interface HostCredentialMaterial {
  readonly providers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Explicit Basic pairing must validate as a unit before any generation activates. */
  readonly basicPairs?: readonly Readonly<{ providerId: string; usernameKey: string; passwordKey: string }>[];
  readonly expiresAt: number;
}
export interface HostCredentialGenerationEvent {
  readonly kind: 'activated' | 'revoked' | 'expired' | 'unavailable' | 'released';
  readonly generationId: string;
}
export class HostCredentialGenerationError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'denied' | 'unavailable' | 'capacity') { super('HOST_CREDENTIAL_GENERATION_' + code.toUpperCase()); this.name = 'HostCredentialGenerationError'; }
}
const fail = (code: HostCredentialGenerationError['code']): never => { throw new HostCredentialGenerationError(code); };
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail('invalid');
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(raw); if (keys.length > 1024) return fail('invalid');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (typeof key !== 'string' || !('value' in descriptor)) return fail('invalid'); result[key] = descriptor.value;
  }
  return result;
}
function id(raw: unknown): string { if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw)) return fail('invalid'); return raw; }
function materialKey(raw: unknown): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 512 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(raw) || raw.split('/').length > 16 || raw.split('/').some(part => part === '.' || part === '..')) return fail('invalid');
  return raw;
}
/**
 * Host-only in-memory material ownership; no env/file import, persistence or HTTP API.
 * Secrets remain private to a bounded generation. Clearing releases references; JS
 * strings cannot promise physical erasure. Handles/events/JSON never carry material.
 */
export function createHostCredentialGenerationStore(options: { maxGenerations?: number; maxTotalBytes?: number } = {}) {
  const config = record(options);
  if (Object.keys(config).some(key => !['maxGenerations', 'maxTotalBytes'].includes(key))) return fail('invalid');
  const maxGenerations = config.maxGenerations ?? 64, maxTotalBytes = config.maxTotalBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxGenerations) || Number(maxGenerations) < 1 || Number(maxGenerations) > 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || Number(maxTotalBytes) < 1 || Number(maxTotalBytes) > 64 * 1024 * 1024) return fail('invalid');
  type Entry = { generationId: string; providers: Map<string, Map<string, string>>; bytes: number; state: 'staged' | 'active' | 'revoked' | 'expired' | 'unavailable' | 'released';
    expiresAt: number; monotonic: number; controller: AbortController; timer?: ReturnType<typeof setTimeout>; handle?: HostCredentialGeneration };
  const staged = new WeakMap<object, Entry>(), generations = new WeakMap<object, Entry>(), entries = new Set<Entry>();
  const listeners = new Set<(event: HostCredentialGenerationEvent) => void>();
  const failureController = new AbortController();
  let current: HostCredentialGeneration | null = null, totalBytes = 0, closed = false, dispatching = false;
  const healthy = () => { if (closed) return fail('unavailable'); };
  const writable = () => { healthy(); if (dispatching) return fail('conflict'); };
  const dispose = (entry: Entry, state: Entry['state']) => {
    if (entry.state === 'released' || entry.state === 'expired') return;
    entry.state = state; clearTimeout(entry.timer); entry.timer = undefined;
    for (const values of entry.providers.values()) values.clear(); entry.providers.clear();
    totalBytes -= entry.bytes; entry.bytes = 0;
    // Terminal state is visible before any synchronous abort listener runs.
    const prior = dispatching; dispatching = true;
    try { entry.controller.abort(new HostCredentialGenerationError(state === 'unavailable' ? 'unavailable' : 'denied')); }
    finally { dispatching = prior; }
    if (state === 'released' || state === 'expired') entries.delete(entry);
  };
  const close = () => {
    if (closed) return; closed = true;
    for (const entry of [...entries]) dispose(entry, 'unavailable'); entries.clear(); listeners.clear(); current = null;
    failureController.abort(new HostCredentialGenerationError('unavailable'));
  };
  const publish = (kind: HostCredentialGenerationEvent['kind'], entry: Entry) => {
    const event = Object.freeze({ kind, generationId: entry.generationId });
    const prior = dispatching; dispatching = true;
    try { for (const listener of [...listeners]) {
      if (closed) break; if (!listeners.has(listener)) continue;
      try { const returned = listener(event) as unknown; if (returned !== undefined) { close(); void Promise.resolve(returned).catch(() => undefined); } }
      catch { close(); }
    } } finally { dispatching = prior; }
  };
  const remaining = (entry: Entry) => Math.min(entry.expiresAt - Date.now(), entry.monotonic - performance.now());
  const expire = (entry: Entry) => {
    if (entry.state === 'released' || entry.state === 'expired' || closed) return;
    if (remaining(entry) <= 0) { dispose(entry, 'expired'); publish('expired', entry); return; }
    entry.timer = setTimeout(() => { entry.timer = undefined; expire(entry); }, Math.min(remaining(entry), 2_147_483_647)); entry.timer.unref?.();
  };
  const inspect = (handle: unknown, allowStaged = false): Entry => {
    healthy(); if (!handle || typeof handle !== 'object') return fail('denied');
    const entry = generations.get(handle) ?? (allowStaged ? staged.get(handle) : undefined);
    if (!entry) return fail('denied');
    if (remaining(entry) <= 0) expire(entry);
    if (!entries.has(entry) || !['active', ...(allowStaged ? ['staged'] : [])].includes(entry.state)) return fail(entry.state === 'unavailable' ? 'unavailable' : 'denied');
    return entry;
  };
  return Object.freeze({
    stage(material: HostCredentialMaterial): StagedHostCredentialGeneration {
      writable(); const raw = record(material);
      if (Object.keys(raw).some(key => !['providers', 'basicPairs', 'expiresAt'].includes(key)) || !Number.isSafeInteger(raw.expiresAt) || Number(raw.expiresAt) <= Date.now()) return fail('invalid');
      const providers = new Map<string, Map<string, string>>(); let bytes = 0, keys = 0;
      try {
        const all = record(raw.providers); if (!Object.keys(all).length || Object.keys(all).length > 64) return fail('invalid');
        for (const [providerId, values] of Object.entries(all)) {
          id(providerId); const copy = new Map<string, string>(), fields = record(values); if (!Object.keys(fields).length) return fail('invalid');
          for (const [key, value] of Object.entries(fields)) { materialKey(key); if (++keys > 512) return fail('invalid'); const secret = checkedCredentialSecret(value); bytes += Buffer.byteLength(secret, 'utf8'); copy.set(key, secret); }
          providers.set(providerId, copy);
        }
        if (raw.basicPairs !== undefined) {
          if (types.isProxy(raw.basicPairs) || !Array.isArray(raw.basicPairs) || Object.getPrototypeOf(raw.basicPairs) !== Array.prototype || raw.basicPairs.length > 256) return fail('invalid');
          if (Reflect.ownKeys(raw.basicPairs).some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) return fail('invalid');
          const pairs = new Set<string>();
          for (let i = 0; i < raw.basicPairs.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(raw.basicPairs, String(i)); if (!descriptor || !('value' in descriptor)) return fail('invalid');
            const pair = record(descriptor.value); if (Object.keys(pair).sort().join(',') !== 'passwordKey,providerId,usernameKey') return fail('invalid');
            const provider = id(pair.providerId), username = materialKey(pair.usernameKey), password = materialKey(pair.passwordKey), identity = JSON.stringify([provider, username, password]);
            if (username === password || pairs.has(identity)) return fail('invalid'); pairs.add(identity);
            basicCredentialHeader(providers.get(provider)?.get(username), providers.get(provider)?.get(password));
          }
        }
      } catch { return fail('invalid'); }
      if (entries.size >= Number(maxGenerations) || totalBytes + bytes > Number(maxTotalBytes)) return fail('capacity');
      const expiresAt = Number(raw.expiresAt), entry: Entry = { generationId: randomUUID(), providers, bytes, state: 'staged', expiresAt, monotonic: performance.now() + expiresAt - Date.now(), controller: new AbortController() };
      const handle = Object.freeze({ kind: 'staged-host-credentials' as const }); staged.set(handle, entry); entries.add(entry); totalBytes += bytes; expire(entry); return handle;
    },
    activate(handle: StagedHostCredentialGeneration, expectedCurrent: HostCredentialGeneration | null): HostCredentialGeneration {
      writable(); if (expectedCurrent !== current) return fail('conflict'); const entry = inspect(handle, true);
      if (entry.state !== 'staged') return fail('denied');
      const generation = Object.freeze({ kind: 'host-credential-generation' as const }); entry.handle = generation; entry.state = 'active';
      generations.set(generation, entry); staged.delete(handle); current = generation; publish('activated', entry); healthy(); return generation;
    },
    capture(): HostCredentialGeneration { healthy(); if (!current) return fail('unavailable'); inspect(current); return current; },
    describe(handle: HostCredentialGeneration) { const entry = inspect(handle); return Object.freeze({ generationId: entry.generationId, expiresAt: entry.expiresAt, signal: entry.controller.signal }); },
    resolve(handle: HostCredentialGeneration, providerId: string, key: string): string { const entry = inspect(handle); const value = entry.providers.get(id(providerId))?.get(materialKey(key)); if (value === undefined) return fail('denied'); return value; },
    revoke(handle: HostCredentialGeneration): void { writable(); const entry = inspect(handle); dispose(entry, 'revoked'); expire(entry); publish('revoked', entry); },
    unavailable(handle: HostCredentialGeneration): void { writable(); const entry = inspect(handle); dispose(entry, 'unavailable'); expire(entry); publish('unavailable', entry); },
    release(handle: HostCredentialGeneration | StagedHostCredentialGeneration): void {
      writable(); const entry = generations.get(handle) ?? staged.get(handle); if (!entry) return fail('denied');
      if (entry.state === 'released' || entry.state === 'expired') return; dispose(entry, 'released'); publish('released', entry);
    },
    subscribe(listener: (event: HostCredentialGenerationEvent) => void) {
      writable(); if (typeof listener !== 'function' || listeners.size >= 128) return fail('capacity'); listeners.add(listener);
      return Object.freeze({ signal: failureController.signal, close: () => { listeners.delete(listener); } });
    },
    close,
  });
}
