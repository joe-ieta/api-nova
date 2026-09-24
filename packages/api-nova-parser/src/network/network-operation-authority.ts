import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { UpstreamCredentialRegistrySnapshot } from '../credentials/registry';
import { ControlledDnsError } from './controlled-dns';
import { createNetworkPolicyCompiler, CompiledNetworkPolicy, normalizeNetworkUrl } from './network-policy';
export interface NetworkOperationSelector { readonly sourceServiceAssetId: string; readonly operationKey: string }
export interface AuthorizedNetworkOperationContext {
  readonly snapshot: UpstreamCredentialRegistrySnapshot; readonly policy: CompiledNetworkPolicy;
  readonly sourceServiceAssetId: string; readonly siteId: string; readonly endpointDefinitionId: string;
  readonly targetUrl: string; readonly method: string; readonly providerEpoch: string;
  readonly credentialHeaders: Readonly<Record<string, string>>;
}
export interface NetworkOperationHandle { readonly operationId: string; readonly deadline: number; readonly signal: AbortSignal }
const error = (code: ControlledDnsError['code'] = 'upstream_network_policy_denied') => new ControlledDnsError(code);
function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw error();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptor)) throw error();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(result, key))) throw error(); return result;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) throw error(); return value; }
/** In-process host authority only. Provider epoch is injected evidence, never an atomic env/file revision claim.
 * Ordinary Registry reload is deliberately not observed by an existing operation. Security epoch changes are.
 * No network, publication, DI, persistence, redirect or managed-child event registration occurs here.
 */
export function createNetworkOperationAuthority(input: {
  compiler: ReturnType<typeof createNetworkPolicyCompiler>;
  readSecurityEpoch: (sourceServiceAssetId: string) => string;
  captureAuthorizedContext: (selector: Readonly<NetworkOperationSelector>, signal: AbortSignal) => Promise<AuthorizedNetworkOperationContext>;
  maxOperations?: number; maxSources?: number;
}) {
  const options = record(input, ['compiler', 'readSecurityEpoch', 'captureAuthorizedContext', 'maxOperations', 'maxSources'], ['compiler', 'readSecurityEpoch', 'captureAuthorizedContext']);
  const compiler = options.compiler as typeof input.compiler, readEpoch = options.readSecurityEpoch as typeof input.readSecurityEpoch, capture = options.captureAuthorizedContext as typeof input.captureAuthorizedContext;
  const limit = options.maxOperations ?? 128, sourceLimit = options.maxSources ?? 128;
  if (typeof readEpoch !== 'function' || typeof capture !== 'function' || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 4096 || !Number.isSafeInteger(sourceLimit) || Number(sourceLimit) < 1 || Number(sourceLimit) > 4096) throw error();
  type Slot = { generation: number; lastEpoch?: string; revoked: boolean; blockedEpoch?: string; unknownEpoch: boolean; operations: Set<Entry> };
  type Entry = { slot: Slot; source: string; epoch: string; generation: number; controller: AbortController; deadline: number; monotonicDeadline: number;
    handle: NetworkOperationHandle; context?: Readonly<AuthorizedNetworkOperationContext>; failure?: ControlledDnsError; timer?: ReturnType<typeof setTimeout>; detach?: () => void; closed: boolean; capturePending?: boolean };
  const sources = new Map<string, Slot>(), handles = new WeakMap<NetworkOperationHandle, Entry>(); let count = 0, orphanCaptures = 0;
  const slotFor = (source: string) => { let slot = sources.get(source); if (!slot) {
    if (sources.size >= Number(sourceLimit)) throw error('upstream_network_policy_unavailable');
    slot = { generation: 0, revoked: false, unknownEpoch: false, operations: new Set() }; sources.set(source, slot);
  } return slot; };
  const stop = (entry: Entry, failure: ControlledDnsError) => {
    if (entry.closed) return; entry.closed = true; entry.failure = failure; entry.context = undefined;
    clearTimeout(entry.timer); entry.detach?.(); entry.slot.operations.delete(entry); count--; if (entry.capturePending) orphanCaptures++;
    entry.controller.abort(failure); // State changes and cleanup happen before reentrant abort listeners.
  };
  const epoch = (source: string, slot: Slot) => {
    let observed: string; try { observed = id(readEpoch(source)); } catch {
      for (const entry of [...slot.operations]) stop(entry, error('upstream_network_policy_unavailable'));
      throw error('upstream_network_policy_unavailable');
    }
    if (slot.revoked && (slot.unknownEpoch || observed === slot.blockedEpoch)) throw error();
    slot.lastEpoch = observed; return observed;
  };
  const validate = (entry: Entry) => {
    if (entry.closed) throw entry.failure ?? error();
    try {
      if (Date.now() >= entry.deadline || performance.now() >= entry.monotonicDeadline) throw error('ETIMEDOUT');
      if (entry.controller.signal.aborted) throw error('ABORT_ERR');
      const observed = epoch(entry.source, entry.slot);
      if (entry.closed) throw entry.failure ?? error();
      if (Date.now() >= entry.deadline || performance.now() >= entry.monotonicDeadline) throw error('ETIMEDOUT');
      if (entry.slot.generation !== entry.generation || observed !== entry.epoch) throw error();
      if (entry.context && !compiler.authorizeTarget(entry.context.policy, { sourceServiceAssetId: entry.source, siteId: entry.context.siteId, url: entry.context.targetUrl })) throw error();
    } catch (failure) { const safe = failure instanceof ControlledDnsError ? failure : error('upstream_network_policy_unavailable'); stop(entry, safe); throw safe; }
  };
  const freezeContext = (raw: AuthorizedNetworkOperationContext, source: string) => {
    const value = record(raw, ['snapshot', 'policy', 'sourceServiceAssetId', 'siteId', 'endpointDefinitionId', 'targetUrl', 'method', 'providerEpoch', 'credentialHeaders']);
    const snapshot = value.snapshot as UpstreamCredentialRegistrySnapshot, policy = value.policy as CompiledNetworkPolicy;
    const siteId = id(value.siteId), endpointDefinitionId = id(value.endpointDefinitionId), providerEpoch = id(value.providerEpoch);
    if (value.sourceServiceAssetId !== source || !snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.candidate) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      !snapshot.candidate.sites.some(site => site.id === siteId && site.sourceServiceAssetId === source) || typeof value.method !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/.test(value.method)) throw error();
    const targetUrl = normalizeNetworkUrl(value.targetUrl).url;
    if (!compiler.authorizeTarget(policy, { sourceServiceAssetId: source, siteId, url: targetUrl })) throw error();
    const names = Reflect.ownKeys(value.credentialHeaders as object); if (names.length > 128) throw error();
    const fields = record(value.credentialHeaders, names as string[]), headers: Record<string, string> = {};
    for (const [name, secret] of Object.entries(fields)) { if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof secret !== 'string' || secret.length > 8192 || /[\r\n\x00]/.test(secret)) throw error(); Object.defineProperty(headers, name, { value: secret, enumerable: true }); }
    return Object.freeze({ snapshot, policy, sourceServiceAssetId: source, siteId, endpointDefinitionId, targetUrl, method: value.method, providerEpoch, credentialHeaders: Object.freeze(headers) });
  };
  return Object.freeze({
    async begin(raw: NetworkOperationSelector & { readonly deadline: number; readonly signal?: AbortSignal }): Promise<NetworkOperationHandle> {
      const request = record(raw, ['sourceServiceAssetId', 'operationKey', 'deadline', 'signal'], ['sourceServiceAssetId', 'operationKey', 'deadline']);
      const source = id(request.sourceServiceAssetId), operationKey = id(request.operationKey), deadline = request.deadline;
      if (typeof deadline !== 'number' || !Number.isFinite(deadline)) throw error();
      if (deadline <= Date.now()) throw error('ETIMEDOUT');
      const signal = request.signal as AbortSignal | undefined; if (signal !== undefined && !(signal instanceof AbortSignal)) throw error(); if (signal?.aborted) throw error('ABORT_ERR');
      if (count + orphanCaptures >= Number(limit)) throw error('upstream_network_policy_unavailable');
      const slot = slotFor(source), securityEpoch = epoch(source, slot), controller = new AbortController();
      const handle = Object.freeze({ operationId: randomUUID(), deadline, signal: controller.signal });
      const entry: Entry = { slot, source, epoch: securityEpoch, generation: slot.generation, controller, deadline, monotonicDeadline: performance.now() + deadline - Date.now(), handle, closed: false };
      count++; slot.operations.add(entry); handles.set(handle, entry);
      const cancelled = () => stop(entry, error('ABORT_ERR')); signal?.addEventListener('abort', cancelled, { once: true }); entry.detach = () => signal?.removeEventListener('abort', cancelled);
      entry.timer = setTimeout(() => stop(entry, error('ETIMEDOUT')), Math.min(2147483647, Math.max(1, deadline - Date.now()))); entry.timer.unref?.();
      let detachRace: () => void = () => undefined;
      try {
        if (signal?.aborted) cancelled(); validate(entry);
        const aborted = new Promise<never>((_resolve, reject) => { const failed = () => reject(entry.failure ?? error('ABORT_ERR')); controller.signal.addEventListener('abort', failed, { once: true }); detachRace = () => controller.signal.removeEventListener('abort', failed); });
        const captured = await Promise.race([Promise.resolve().then(() => { validate(entry); entry.capturePending = true; return Promise.resolve().then(() => { validate(entry); return capture(Object.freeze({ sourceServiceAssetId: source, operationKey }), controller.signal); }).finally(() => { entry.capturePending = false; if (entry.closed) orphanCaptures--; }); }), aborted]);
        validate(entry); entry.context = freezeContext(captured, source); validate(entry); return handle;
      } catch (failure) { const safe = failure instanceof ControlledDnsError ? failure : error('upstream_network_policy_unavailable'); stop(entry, safe); throw safe; }
      finally { detachRace(); }
    },
    assertCurrent(handle: NetworkOperationHandle): Readonly<AuthorizedNetworkOperationContext> {
      const entry = handles.get(handle); if (!entry || !entry.context) throw entry?.failure ?? error(); validate(entry); return entry.context!;
    },
    revoke(sourceInput: string): void {
      const source = id(sourceInput), slot = slotFor(source); slot.generation++; slot.revoked = true; slot.blockedEpoch = slot.lastEpoch; slot.unknownEpoch = slot.lastEpoch === undefined;
      if (slot.unknownEpoch) { try { slot.blockedEpoch = id(readEpoch(source)); slot.unknownEpoch = false; } catch { /* Unknown state stays closed; no guessed epoch. */ } }
      for (const entry of [...slot.operations]) stop(entry, error());
    },
    close(handle: NetworkOperationHandle): void { const entry = handles.get(handle); if (!entry) throw error(); stop(entry, error('ABORT_ERR')); },
  });
}
