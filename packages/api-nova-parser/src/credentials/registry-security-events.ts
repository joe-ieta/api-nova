import type { UpstreamCredentialRegistrySnapshot } from './registry';

/** In-process host observer only; never supplied by config or requests. */
export interface RegistrySecurityCommitEvent {
  readonly generation: number;
  readonly revision: string;
  readonly changes: readonly Readonly<{ sourceServiceAssetId: string; kind: 'initial' | 'reload' | 'security-change' }>[];
}
export interface RegistrySecuritySubscription { readonly signal: AbortSignal; assertAvailable(): void; close(): void; }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
};
/** Conservative: all changes beyond revision/reload metadata require security review. */
export function registrySecurityCommit(previous: UpstreamCredentialRegistrySnapshot | undefined, next: UpstreamCredentialRegistrySnapshot): RegistrySecurityCommitEvent {
  const sources = new Set([...(previous?.candidate.sites ?? []), ...next.candidate.sites].map(site => site.sourceServiceAssetId));
  const scope = (snapshot: UpstreamCredentialRegistrySnapshot, source: string) => canonical({
    environment: snapshot.candidate.metadata.environment,
    historicalHeaderNames: [...snapshot.historicalAuthenticationHeaderNames ?? []].sort(),
    sites: snapshot.candidate.sites.filter(site => site.sourceServiceAssetId === source),
    credentials: snapshot.candidate.credentials, providers: snapshot.candidate.secretProviders,
  });
  return Object.freeze({ generation: next.generation, revision: next.candidate.metadata.revision,
    changes: Object.freeze([...sources].sort().map(sourceServiceAssetId => Object.freeze({ sourceServiceAssetId,
      kind: !previous ? 'initial' as const : scope(previous, sourceServiceAssetId) === scope(next, sourceServiceAssetId) ? 'reload' as const : 'security-change' as const }))) });
}

/** Observer failure is sticky; a trusted host must replace the subscription. */
export class RegistrySecurityObservers {
  private readonly observers = new Set<{ callback: (event: RegistrySecurityCommitEvent) => void; unavailable: boolean; controller: AbortController }>();
  subscribe(callback: (event: RegistrySecurityCommitEvent) => void): RegistrySecuritySubscription {
    if (typeof callback !== 'function' || this.observers.size >= 128) throw new Error('REGISTRY_OBSERVER_UNAVAILABLE');
    const entry = { callback, unavailable: false, controller: new AbortController() }; this.observers.add(entry);
    return Object.freeze({ signal: entry.controller.signal, assertAvailable: () => { if (entry.unavailable || !this.observers.has(entry)) throw new Error('REGISTRY_OBSERVER_UNAVAILABLE'); },
      close: () => { this.observers.delete(entry); entry.controller.abort(new Error('REGISTRY_OBSERVER_UNAVAILABLE')); } });
  }
  publish(event: RegistrySecurityCommitEvent): void {
    for (const entry of [...this.observers]) {
      if (entry.unavailable || !this.observers.has(entry)) continue;
      try {
        const result = entry.callback(event) as unknown;
        if (result !== undefined) { entry.unavailable = true; entry.controller.abort(new Error('REGISTRY_OBSERVER_UNAVAILABLE')); void Promise.resolve(result).catch(() => undefined); }
      } catch { entry.unavailable = true; entry.controller.abort(new Error('REGISTRY_OBSERVER_UNAVAILABLE')); }
    }
  }
}
