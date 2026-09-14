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
  | 'REVISION_ALREADY_ACTIVE' | 'SECRET_RESOLUTION_FAILED' | 'UNKNOWN_CREDENTIAL'
  | 'CONFIGURATION_READ_FAILED' | 'CONFIGURATION_UNSTABLE' | 'UNSUPPORTED_RELOAD_MODE';

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
  /** Trusted host adapter only. Never accept executable adapters from configuration text. */
  readonly providerFactory?: UpstreamSecretProviderFactory;
}

export interface UpstreamCredentialRegistrySnapshot {
  readonly generation: number;
  readonly candidate: UpstreamCredentialBindingsCandidate;
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

interface SecretBinding {
  readonly read: () => Promise<string>;
}

function reject(code: UpstreamCredentialRegistryErrorCode): never {
  throw new UpstreamCredentialRegistryError(code);
}

function checkedOptions(input: UpstreamCredentialRegistryOptions): {
  environment: string;
  providerFactory: UpstreamSecretProviderFactory;
} {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    if (Reflect.ownKeys(input).some(key => key !== 'environment' && key !== 'providerFactory')) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const environmentProperty = Object.getOwnPropertyDescriptor(input, 'environment');
    const factoryProperty = Object.getOwnPropertyDescriptor(input, 'providerFactory');
    if (!environmentProperty || !('value' in environmentProperty) ||
        (factoryProperty && !('value' in factoryProperty))) {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    const environment = environmentProperty.value;
    const providerFactory = factoryProperty?.value === undefined
      ? createUpstreamSecretProvider : factoryProperty.value;
    if (typeof environment !== 'string' || !environment ||
        environment.length > 256 || environment.trim() !== environment ||
        /[\u0000-\u001f\u007f]/u.test(environment) || typeof providerFactory !== 'function') {
      return reject('INVALID_REGISTRY_CONFIGURATION');
    }
    return { environment, providerFactory };
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
 * Manual, process-local candidate registry. No watcher, persistence, transport or auto-activation.
 * An active snapshot stays available while a replacement undergoes dry resolution.
 */
export class UpstreamCredentialRegistry {
  private readonly environment: string;
  private readonly providerFactory: UpstreamSecretProviderFactory;
  private active: UpstreamCredentialRegistrySnapshot | undefined;
  private reloading = false;
  private lastReloadError: UpstreamCredentialRegistryErrorCode | undefined;

  constructor(options: UpstreamCredentialRegistryOptions) {
    const checked = checkedOptions(options);
    this.environment = checked.environment;
    this.providerFactory = checked.providerFactory;
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
    return this.performReload(() => parseUpstreamCredentialBindings(text, format));
  }

  /** Stable local-file activation; watch mode requires a future lifecycle adapter. */
  async reloadFile(
    path: string,
    format: UpstreamCredentialTextFormat,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    return this.performReload(async () => {
      if (format !== 'json' && format !== 'yaml') return reject('CANDIDATE_REJECTED');
      const text = await readStableUpstreamCredentialText(path);
      const candidate = parseUpstreamCredentialBindings(text, format);
      if (candidate.reload.mode !== 'manual') return reject('UNSUPPORTED_RELOAD_MODE');
      return candidate;
    });
  }

  private async performReload(
    loadCandidate: () => UpstreamCredentialBindingsCandidate | Promise<UpstreamCredentialBindingsCandidate>,
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    // Acquire synchronously before parsing or provider I/O. Attempts cannot commit out of order.
    if (this.reloading) return reject('RELOAD_IN_PROGRESS');
    this.reloading = true;
    try {
      let candidate: UpstreamCredentialBindingsCandidate;
      try {
        candidate = await loadCandidate();
      } catch (error) {
        if (error instanceof UpstreamCredentialFileError) return reject(error.code);
        if (error instanceof UpstreamCredentialRegistryError) throw error;
        return reject('CANDIDATE_REJECTED');
      }
      return await this.activateCandidate(candidate);
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
  ): Promise<UpstreamCredentialRegistrySnapshot> {
    if (candidate.metadata.environment !== this.environment) return reject('ENVIRONMENT_MISMATCH');
    if (candidate.metadata.revision === this.active?.candidate.metadata.revision) {
      return reject('REVISION_ALREADY_ACTIVE');
    }

    const providers = new Map<string, UpstreamSecretProvider>();
    for (const [id, description] of Object.entries(candidate.secretProviders)) {
      const provider = this.providerFactory(description);
      if (!provider || provider.type !== description.type || typeof provider.resolve !== 'function') {
        return reject('SECRET_RESOLUTION_FAILED');
      }
      providers.set(id, provider);
    }

    const bindings = new Map<string, SecretBinding>();
    for (const [id, credential] of Object.entries(candidate.credentials)) {
      const separator = credential.secretRef.indexOf(':');
      const provider = providers.get(credential.secretRef.slice(0, separator));
      if (!provider) return reject('SECRET_RESOLUTION_FAILED');
      const key = credential.secretRef.slice(separator + 1);
      const resolve = provider.resolve.bind(provider);
      bindings.set(id, Object.freeze({ read: () => resolve(key) }));
    }

    // Resolve all credentials, including currently unused entries, without retaining values.
    for (const binding of bindings.values()) await resolveBinding(binding);

    const snapshot: UpstreamCredentialRegistrySnapshot = Object.freeze({
      generation: (this.active?.generation ?? 0) + 1,
      candidate,
      resolveSecret: async (credentialId: string): Promise<string> => {
        if (typeof credentialId !== 'string') return reject('UNKNOWN_CREDENTIAL');
        const binding = bindings.get(credentialId);
        if (!binding) return reject('UNKNOWN_CREDENTIAL');
        return resolveBinding(binding);
      },
    });
    // The only commit point; no await occurs after completed validation and before the swap.
    this.active = snapshot;
    this.lastReloadError = undefined;
    return snapshot;
  }
}
