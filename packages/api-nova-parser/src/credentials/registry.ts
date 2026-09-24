import { assertRegistryProviderEvidence, captureRegistryProviderGeneration, assertCapturedRegistryProviderGeneration, capturedRegistrySecretProvider, associateRegistryProviderGeneration, type RegistryProviderEvidence, type CapturedRegistryProviderGeneration } from './registry-provider-evidence';
import { RegistrySecurityObservers, registrySecurityCommit, type RegistrySecurityCommitEvent, type RegistrySecuritySubscription } from './registry-security-events';
import { checkedCredentialHeaderHistoryState, CREDENTIAL_HEADER_HISTORY_LIMIT, type CredentialHeaderHistoryBinding } from './credential-header-history';
export type { CredentialHeaderHistoryStore, CredentialHeaderHistoryState, CredentialHeaderHistoryBinding } from './credential-header-history';
import { upstreamCredentialHeaderName } from './types';
import { basicCredentialHeader, checkedSingleCredentialSecret } from './secret-material';
import { compileHeaderPolicyV1, type CompiledHeaderPolicyV1 } from '../headers/header-policy';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { validateUpstreamCredentialBindings } from './schema';
import { readStableUpstreamCredentialText, UpstreamCredentialFileError } from './file-source';
import { parseUpstreamCredentialBindings, type UpstreamCredentialTextFormat } from './loader';
import {
  createUpstreamSecretProvider,
  UPSTREAM_SECRET_PROVIDER_LIMITS,
  type UpstreamSecretProvider,
} from './secret-provider';
import type {
  UpstreamCredentialBindingsCandidate,
  UpstreamSecretProviderDescription,
} from './types';

export type UpstreamCredentialRegistryErrorCode =
  | 'INVALID_REGISTRY_CONFIGURATION' | 'REGISTRY_NOT_READY'
  | 'RELOAD_IN_PROGRESS' | 'CANDIDATE_REJECTED' | 'ENVIRONMENT_MISMATCH'
  | 'ASSET_OWNERSHIP_REJECTED' | 'REVISION_ALREADY_ACTIVE' | 'SECRET_RESOLUTION_FAILED' | 'UNKNOWN_CREDENTIAL'
  | 'CONFIGURATION_READ_FAILED' | 'CONFIGURATION_UNSTABLE' | 'UNSUPPORTED_RELOAD_MODE'
  | 'HISTORY_UNAVAILABLE' | 'HISTORY_CONFLICT'
  | 'WATCH_STOPPED' | 'WATCH_ALREADY_STARTED' | 'WATCH_SOURCE_MISMATCH' | 'GENERATION_CONFLICT';

export class UpstreamCredentialRegistryError extends Error {
  constructor(public readonly code: UpstreamCredentialRegistryErrorCode) {
    super('Upstream credential registry rejected the request: ' + code);
    this.name = 'UpstreamCredentialRegistryError';
  }
}

export type UpstreamSecretProviderFactory = (
  description: UpstreamSecretProviderDescription,
) => UpstreamSecretProvider;

export interface UpstreamCredentialRegistryOptions {
  readonly environment: string;
  /** Optional host-owned immutable generation evidence; never configuration supplied. */
  readonly providerEvidence?: RegistryProviderEvidence;
  readonly credentialHeaderHistory?: CredentialHeaderHistoryBinding;
  /** Trusted host adapter only. Never accept executable adapters from configuration text. */
  readonly providerFactory?: UpstreamSecretProviderFactory;
  /** Host-owned validation against the authoritative asset store; never config supplied. */
  readonly validateCandidateOwnership?: (candidate: UpstreamCredentialBindingsCandidate) => Promise<void>;
}

export type UpstreamHeaderPolicyEndpoint = { readonly endpointDefinitionId: string } | { readonly method: string; readonly path: string };

export interface UpstreamCredentialRegistrySnapshot {
  /** Compiled preparation only: host transport must explicitly support v1 before activation. */
  getHeaderPolicy?(siteId: string, endpoint?: UpstreamHeaderPolicyEndpoint): CompiledHeaderPolicyV1 | undefined;
  readonly generation: number;
  readonly candidate: UpstreamCredentialBindingsCandidate;
  readonly historicalAuthenticationHeaderNames?: readonly string[];
  resolveBasicSecret?(credentialId: string): Promise<Readonly<{ username: string; password: string }>>;
  /**
   * Trusted in-process API returning secret material, not an HTTP/control-plane response.
   * Captures this revision's binding; provider contents are read fresh, never cached here.
   */
  resolveSecret(credentialId: string): Promise<string>;
}

export interface UpstreamCredentialRegistryStatus {
  readonly state: 'empty' | 'ready';
  readonly environment: string;
  readonly generation: number;
  readonly revision?: string;
  readonly reloading: boolean;
  readonly lastReloadError?: UpstreamCredentialRegistryErrorCode;
}

interface RegistryWatchState {
  path: string; format: UpstreamCredentialTextFormat; watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>; pending: boolean; running: boolean; debounceMs: number;
}

interface SecretBinding {
  readonly read: () => Promise<string>;
}

function reject(code: UpstreamCredentialRegistryErrorCode): never {
  throw new UpstreamCredentialRegistryError(code);
}

function checkedOptions(input: UpstreamCredentialRegistryOptions): {
  environment: string;
  providerEvidence?: RegistryProviderEvidence;
  providerFactory: UpstreamSecretProviderFactory;
  credentialHeaderHistory?: CredentialHeaderHistoryBinding;
  validateCandidateOwnership?: UpstreamCredentialRegistryOptions['validateCandidateOwnership'];
} {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    if (Reflect.ownKeys(input).some(key => key !== 'environment' && key !== 'providerEvidence' && key !== 'providerFactory' && key !== 'validateCandidateOwnership' && key !== 'credentialHeaderHistory')) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const evidenceProperty = Object.getOwnPropertyDescriptor(input, 'providerEvidence');
    if (evidenceProperty && !('value' in evidenceProperty)) return reject('INVALID_REGISTRY_CONFIGURATION');
    const providerEvidence = evidenceProperty?.value as RegistryProviderEvidence | undefined;
    if (providerEvidence !== undefined) assertRegistryProviderEvidence(providerEvidence);
    const environmentProperty = Object.getOwnPropertyDescriptor(input, 'environment');
    const factoryProperty = Object.getOwnPropertyDescriptor(input, 'providerFactory');
    if (providerEvidence !== undefined && factoryProperty?.value !== undefined) return reject('INVALID_REGISTRY_CONFIGURATION');
    const ownershipProperty = Object.getOwnPropertyDescriptor(input, 'validateCandidateOwnership');
    if (!environmentProperty || !('value' in environmentProperty) ||
        (factoryProperty && !('value' in factoryProperty)) ||
        (ownershipProperty && (!('value' in ownershipProperty) || (ownershipProperty.value !== undefined && typeof ownershipProperty.value !== 'function')))) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const historyProperty = Object.getOwnPropertyDescriptor(input, 'credentialHeaderHistory');
    if (historyProperty && !('value' in historyProperty)) return reject('INVALID_REGISTRY_CONFIGURATION');
    const history = historyProperty?.value as CredentialHeaderHistoryBinding | undefined;
    if (history !== undefined && (!history || typeof history !== 'object' ||
      typeof history.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(history.namespace) ||
      !history.store || typeof history.store.load !== 'function' || typeof history.store.commit !== 'function')) return reject('INVALID_REGISTRY_CONFIGURATION');
    // Capture host adapter methods once; later option mutations cannot retarget the ledger.
    const credentialHeaderHistory = history && Object.freeze({ namespace: history.namespace,
      store: Object.freeze({ load: history.store.load.bind(history.store), commit: history.store.commit.bind(history.store) }) });
    const environment = environmentProperty.value;
    const providerFactory = factoryProperty?.value === undefined
      ? createUpstreamSecretProvider : factoryProperty.value;
    if (typeof environment !== 'string' || !environment ||
        environment.length > 256 || environment.trim() !== environment ||
        /[\u0000-\u001f\u007f]/u.test(environment) || typeof providerFactory !== 'function') {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    return { environment, providerEvidence, providerFactory, credentialHeaderHistory, validateCandidateOwnership: ownershipProperty?.value };
  } catch {
    return reject('INVALID_REGISTRY_CONFIGURATION');
  }
}

async function resolveBinding(binding: SecretBinding): Promise<string> {
  try {
    const value = await binding.read();
    if (typeof value !== 'string' || !value || value.trim() !== value ||
        Buffer.byteLength(value, 'utf8') > UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
      return reject('SECRET_RESOLUTION_FAILED');
    }
    return value;
  } catch {
    // Never attach provider errors: they may contain environment names, file paths or secrets.
    return reject('SECRET_RESOLUTION_FAILED');
  }
}

/**
 * Process-local registry with explicit host-owned file watching and atomic candidate swaps.
 * An active snapshot stays available while a replacement undergoes dry resolution.
 */
export class UpstreamCredentialRegistry {
  private readonly securityObservers = new RegistrySecurityObservers();
  /** Host-only synchronous notification after atomic activation. No initial replay. */
  observeSecurityCommits(callback: (event: RegistrySecurityCommitEvent) => void): RegistrySecuritySubscription {
    if (typeof callback !== 'function') return this.securityObservers.subscribe(callback);
    return this.securityObservers.subscribe(event => {
      try { const result = callback(event) as unknown; if (result !== undefined) this.providerEvidence?.close(); return result as void; }
      catch (error) { this.providerEvidence?.close(); throw error; }
    });
  }
  private readonly providerEvidence?: RegistryProviderEvidence;
  private readonly environment: string;
  private readonly providerFactory: UpstreamSecretProviderFactory;
  private readonly validateCandidateOwnership?: UpstreamCredentialRegistryOptions['validateCandidateOwnership'];
  private readonly credentialHeaderHistory?: CredentialHeaderHistoryBinding;
  private active: UpstreamCredentialRegistrySnapshot | undefined;
  private reloading = false;
  private historicalAuthenticationHeaderNames = new Set<string>();
  private watchState?: RegistryWatchState;
  private lastReloadError: UpstreamCredentialRegistryErrorCode | undefined;

  constructor(options: UpstreamCredentialRegistryOptions) {
    const checked = checkedOptions(options);
    this.environment = checked.environment;
    this.providerEvidence = checked.providerEvidence;
    this.credentialHeaderHistory = checked.credentialHeaderHistory;
    this.providerFactory = checked.providerFactory;
    this.validateCandidateOwnership = checked.validateCandidateOwnership;
  }

  getStatus(): UpstreamCredentialRegistryStatus {
    const active = this.active;
    return Object.freeze({
      state: active ? 'ready' as const : 'empty' as const,
      environment: this.environment,
      generation: active?.generation ?? 0,
      ...(active ? { revision: active.candidate.metadata.revision } : {}),
      reloading: this.reloading,
      ...(this.lastReloadError ? { lastReloadError: this.lastReloadError } : {}),
    });
  }

  captureSnapshot(): UpstreamCredentialRegistrySnapshot {
    if (!this.active) return reject('REGISTRY_NOT_READY');
    return this.active;
  }

  async reload(input: unknown): Promise<UpstreamCredentialRegistrySnapshot> {
    if (this.watchState) return reject('WATCH_SOURCE_MISMATCH');
    return this.performReload(() => validateUpstreamCredentialBindings(input));
  }

  /**
   * Parse and activate bounded JSON/YAML text under the same reload lock.
   * Parsed candidates are not passed through the raw-object parser a second time.
   */
  async reloadText(
    text: string,
    format: UpstreamCredentialTextFormat,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    if (this.watchState) return reject('WATCH_SOURCE_MISMATCH');
    return this.performReload(() => parseUpstreamCredentialBindings(text, format));
  }

  /** Stable local-file activation; a running watcher only accepts its fixed source. */
  async reloadFile(
    path: string,
    format: UpstreamCredentialTextFormat,
    expectedGeneration?: number,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    const watching = this.watchState;
    if (watching && (resolve(path) !== watching.path || format !== watching.format)) {
      return reject('WATCH_SOURCE_MISMATCH');
    }
    return this.performReload(async () => {
      if (expectedGeneration !== undefined && expectedGeneration !== (this.active?.generation ?? 0)) {
        return reject('GENERATION_CONFLICT');
      }
      if (format !== 'json' && format !== 'yaml') return reject('CANDIDATE_REJECTED');
      const text = await readStableUpstreamCredentialText(path);
      const candidate = parseUpstreamCredentialBindings(text, format);
      if (candidate.reload.mode !== (watching ? 'watch' : 'manual')) return reject('UNSUPPORTED_RELOAD_MODE');
      return candidate;
    }, watching ? () => this.watchState === watching : undefined);
  }

  /** Host-only opt-in. Watches the parent directory so atomic replacements remain visible. */
  async startWatchingFile(path: string, format: UpstreamCredentialTextFormat): Promise<void> {
    if (this.watchState) return reject('WATCH_ALREADY_STARTED');
    if (this.reloading) return reject('RELOAD_IN_PROGRESS');
    if (typeof path !== 'string') return reject('CONFIGURATION_READ_FAILED');
    const registry = this;
    const state = { path: resolve(path), format, pending: false, running: false, debounceMs: 50 } as RegistryWatchState;
    this.watchState = state;
    try {
      // Validate the original native absolute path before opening a native watch handle.
      await readStableUpstreamCredentialText(path);
      if (this.watchState !== state) return reject('WATCH_STOPPED');
      state.watcher = watch(dirname(state.path), (_event, filename) => {
        if (filename === null || filename.toString() === basename(state.path)) {
          state.pending = true;
          schedule();
        }
      });
      state.watcher.on('error', () => {
        if (this.watchState !== state) return;
        this.lastReloadError = 'CONFIGURATION_READ_FAILED';
        this.stopWatching();
      });
      state.running = true;
      await this.reloadFile(state.path, format);
      state.debounceMs = this.captureSnapshot().candidate.reload.debounceMs;
      state.running = false;
      if (state.pending) schedule();
    } catch (error) {
      if (this.watchState === state) this.stopWatching();
      throw new UpstreamCredentialRegistryError(error instanceof UpstreamCredentialRegistryError || error instanceof UpstreamCredentialFileError
        ? error.code : 'CONFIGURATION_READ_FAILED');
    }

    function schedule(): void {
      if (registry.watchState !== state || state.running) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { void reload(); }, Math.max(10, state.debounceMs));
    }
    async function reload(): Promise<void> {
      state.timer = undefined;
      if (registry.watchState !== state) return;
      if (registry.reloading) { schedule(); return; }
      state.pending = false;
      state.running = true;
      try {
        await registry.reloadFile(state.path, state.format);
        state.debounceMs = registry.captureSnapshot().candidate.reload.debounceMs;
      } catch {
        // The registry records sanitized errors and preserves its last good snapshot.
      } finally {
        state.running = false;
        if (state.pending) schedule();
      }
    }
  }

  stopWatching(): void {
    const state = this.watchState;
    this.watchState = undefined;
    if (state?.timer) clearTimeout(state.timer);
    state?.watcher?.close();
  }

  /** Nest also calls this on factory-provided instances during application shutdown. */
  onModuleDestroy(): void { this.stopWatching(); }

  private async performReload(
    loadCandidate: () => UpstreamCredentialBindingsCandidate | Promise<UpstreamCredentialBindingsCandidate>,
    commitAllowed?: () => boolean,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    // Acquire synchronously before parsing or provider I/O. Attempts cannot commit out of order.
    if (this.reloading) return reject('RELOAD_IN_PROGRESS');
    this.reloading = true;
    try {
      const providerCapture = this.providerEvidence ? captureRegistryProviderGeneration(this.providerEvidence) : undefined;
      let candidate: UpstreamCredentialBindingsCandidate;
      try {
        candidate = await loadCandidate();
      } catch (error) {
        if (error instanceof UpstreamCredentialFileError) return reject(error.code);
        if (error instanceof UpstreamCredentialRegistryError) throw error;
        return reject('CANDIDATE_REJECTED');
      }
      return await this.activateCandidate(candidate, commitAllowed, 0, providerCapture);
    } catch (error) {
      const safe = error instanceof UpstreamCredentialRegistryError
        ? new UpstreamCredentialRegistryError(error.code)
        : new UpstreamCredentialRegistryError('SECRET_RESOLUTION_FAILED');
      this.lastReloadError = safe.code;
      throw safe;
    } finally {
      this.reloading = false;
    }
  }

  private async activateCandidate(
    candidate: UpstreamCredentialBindingsCandidate,
    commitAllowed?: () => boolean,
    historyAttempt = 0,
    providerCapture?: CapturedRegistryProviderGeneration,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    if (providerCapture) assertCapturedRegistryProviderGeneration(providerCapture);
    if (candidate.metadata.environment !== this.environment) return reject('ENVIRONMENT_MISMATCH');
    if (candidate.metadata.revision === this.active?.candidate.metadata.revision) {
      return reject('REVISION_ALREADY_ACTIVE');
    }

    const credentialHeaderNames = Object.values(candidate.credentials).map(upstreamCredentialHeaderName);
    let history = { version: 0, names: [] as readonly string[] };
    if (this.credentialHeaderHistory) {
      try { history = checkedCredentialHeaderHistoryState(await this.credentialHeaderHistory.store.load(this.credentialHeaderHistory.namespace)); }
      catch { return reject('HISTORY_UNAVAILABLE'); }
    }
    const historicalNames = new Set([...history.names, ...this.historicalAuthenticationHeaderNames, ...credentialHeaderNames]);
    if (historicalNames.size > CREDENTIAL_HEADER_HISTORY_LIMIT) return reject('HISTORY_UNAVAILABLE');
    const compiled = new Map<string, CompiledHeaderPolicyV1>();
    const policyKey = (siteId: string, endpoint?: UpstreamHeaderPolicyEndpoint): string => JSON.stringify([siteId, endpoint === undefined ? null : 'endpointDefinitionId' in endpoint ? ['id', endpoint.endpointDefinitionId] : ['route', endpoint.method.toUpperCase(), endpoint.path]]);
    try {
      for (const site of candidate.sites) {
        const baseSource = JSON.stringify(['registry', candidate.metadata.environment, candidate.metadata.revision, site.id]);
        if (site.headerPolicy) compiled.set(policyKey(site.id), compileHeaderPolicyV1({ policy: site.headerPolicy, sourceId: baseSource, credentialHeaderNames, historicalAuthenticationHeaderNames: [...historicalNames] }));
        for (const endpoint of site.endpoints) {
          if (site.headerPolicy || endpoint.headerPolicy) compiled.set(policyKey(site.id, endpoint), compileHeaderPolicyV1({ policy: endpoint.headerPolicy, inheritedPolicy: site.headerPolicy, sourceId: JSON.stringify([baseSource, policyKey(site.id, endpoint)]), credentialHeaderNames, historicalAuthenticationHeaderNames: [...historicalNames] }));
        }
      }
    } catch { return reject('CANDIDATE_REJECTED'); }

    const providers = new Map<string, UpstreamSecretProvider>();
    for (const [id, description] of Object.entries(candidate.secretProviders)) {
      const provider = providerCapture ? capturedRegistrySecretProvider(providerCapture, id, description) : this.providerFactory(description);
      if (!provider || provider.type !== description.type || typeof provider.resolve !== 'function') {
        return reject('SECRET_RESOLUTION_FAILED');
      }
      providers.set(id, provider);
    }

    const bindings = new Map<string, SecretBinding>();
    const basicBindings = new Map<string, { username: SecretBinding; password: SecretBinding }>();
    const bind = (reference: string): SecretBinding => {
      const separator = reference.indexOf(':');
      const provider = providers.get(reference.slice(0, separator));
      if (!provider) return reject('SECRET_RESOLUTION_FAILED');
      const key = reference.slice(separator + 1), resolve = provider.resolve.bind(provider);
      return Object.freeze({ read: () => resolve(key) });
    };
    const readBasic = async (id: string): Promise<Readonly<{ username: string; password: string }>> => {
      const pair = basicBindings.get(id);
      if (!pair) return reject('UNKNOWN_CREDENTIAL');
      const username = await resolveBinding(pair.username), password = await resolveBinding(pair.password);
      try { basicCredentialHeader(username, password); } catch { return reject('SECRET_RESOLUTION_FAILED'); }
      return Object.freeze({ username, password });
    };
    for (const [id, credential] of Object.entries(candidate.credentials)) {
      if (credential.type === 'basic') basicBindings.set(id, { username: bind(credential.usernameRef), password: bind(credential.passwordRef) });
      else bindings.set(id, bind(credential.secretRef));
    }
    // Resolve every reference, even disabled/unreferenced credentials, without retaining material.
    for (const [id, binding] of bindings) {
      const value = await resolveBinding(binding);
      try {
        const credential = candidate.credentials[id];
        if (credential.type === 'basic') throw new Error();
        checkedSingleCredentialSecret(value, credential.type);
      } catch { return reject('SECRET_RESOLUTION_FAILED'); }
    }
    for (const id of basicBindings.keys()) await readBasic(id);

    // Run after asynchronous secret checks, so database changes during dry-run are observed.
    if (this.validateCandidateOwnership) {
      try { await this.validateCandidateOwnership(candidate); }
      catch { return reject('ASSET_OWNERSHIP_REJECTED'); }
    }

    const snapshot: UpstreamCredentialRegistrySnapshot = Object.freeze({
      generation: (this.active?.generation ?? 0) + 1,
      candidate,
      historicalAuthenticationHeaderNames: Object.freeze([...historicalNames]),
      resolveBasicSecret: readBasic,
      getHeaderPolicy: (siteId: string, endpoint?: UpstreamHeaderPolicyEndpoint): CompiledHeaderPolicyV1 | undefined => {
        if (!candidate.sites.some(site => site.id === siteId)) return reject('CANDIDATE_REJECTED');
        if (endpoint !== undefined) {
          if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) return reject('CANDIDATE_REJECTED');
          const keys = Object.keys(endpoint);
          if ('endpointDefinitionId' in endpoint ? keys.length !== 1 || typeof endpoint.endpointDefinitionId !== 'string' : keys.length !== 2 || typeof endpoint.method !== 'string' || typeof endpoint.path !== 'string') return reject('CANDIDATE_REJECTED');
        }
        return compiled.get(policyKey(siteId, endpoint)) ?? compiled.get(policyKey(siteId));
      },
      resolveSecret: async (credentialId: string): Promise<string> => {
        if (typeof credentialId !== 'string') return reject('UNKNOWN_CREDENTIAL');
        const binding = bindings.get(credentialId);
        if (!binding) return reject('UNKNOWN_CREDENTIAL');
        return resolveBinding(binding);
      },
    });
    if (providerCapture) assertCapturedRegistryProviderGeneration(providerCapture);
    const securityEvent = registrySecurityCommit(this.active, snapshot);
    // Durable CAS is the activation commit point. A watcher stopped before it
    // starts cancels; stopping during an accepted commit only stops future reloads.
    if (commitAllowed && !commitAllowed()) return reject('WATCH_STOPPED');
    if (this.credentialHeaderHistory) {
      let committed: boolean;
      try { committed = await this.credentialHeaderHistory.store.commit(this.credentialHeaderHistory.namespace, history.version, Object.freeze([...historicalNames].sort())); }
      catch { return reject('HISTORY_UNAVAILABLE'); }
      if (committed !== true) {
        if (committed !== false) return reject('HISTORY_UNAVAILABLE');
        if (historyAttempt >= 2) return reject('HISTORY_CONFLICT');
        if (commitAllowed && !commitAllowed()) return reject('WATCH_STOPPED');
        // Recompile against the new union; a newly retired header may invalidate policy.
        return this.activateCandidate(candidate, commitAllowed, historyAttempt + 1, providerCapture);
      }
    }
    // A revoked generation cannot activate even if the monotonic header union CAS succeeded.
    // This final synchronous check may reject; no await is allowed before the active swap.
    if (providerCapture) assertCapturedRegistryProviderGeneration(providerCapture);
    this.historicalAuthenticationHeaderNames = historicalNames;
    this.active = snapshot;
    if (providerCapture) associateRegistryProviderGeneration(providerCapture, snapshot);
    this.lastReloadError = undefined;
    this.securityObservers.publish(securityEvent);
    return snapshot;
  }
}
