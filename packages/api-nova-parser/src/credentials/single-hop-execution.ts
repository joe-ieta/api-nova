import type { UpstreamCredentialRegistrySnapshot } from './registry';
import { resolveUpstreamCredential } from './resolver';
import { upstreamCredentialHeaderName } from './types';
import type { TrustedOperationBinding } from './trusted-operation-bindings';

/** Explicit in-process opt-in. Redirects are returned to the caller, never followed automatically. */
export interface SingleHopUpstreamCredentialPolicy {
  readonly mode: 'single-hop';
  readonly captureSnapshot: () => UpstreamCredentialRegistrySnapshot;
}
export class UpstreamCredentialExecutionError extends Error {
  constructor() { super('UPSTREAM_CREDENTIAL_UNAVAILABLE'); this.name = 'UpstreamCredentialExecutionError'; }
}
export interface ResolvedSingleHopCredentials {
  readonly siteId: string; readonly generation: number; readonly revision: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly managedHeaderNames: readonly string[];
}
export function compileSingleHopUpstreamCredentials(policy: SingleHopUpstreamCredentialPolicy) {
  const invalid = () => { throw new Error('INVALID_UPSTREAM_CREDENTIAL_EXECUTION'); };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(policy)) ||
    Reflect.ownKeys(policy).length !== 2 || Reflect.ownKeys(policy).some(key => !['mode', 'captureSnapshot'].includes(String(key)))) invalid();
  const mode = Object.getOwnPropertyDescriptor(policy, 'mode');
  const capture = Object.getOwnPropertyDescriptor(policy, 'captureSnapshot');
  if (!mode || !('value' in mode) || mode.value !== 'single-hop' || !capture || !('value' in capture) || typeof capture.value !== 'function') invalid();
  const captureSnapshot = capture!.value as () => UpstreamCredentialRegistrySnapshot;
  return Object.freeze({
    async resolve(binding: Readonly<TrustedOperationBinding> | undefined, url: string, requestMethod?: string): Promise<ResolvedSingleHopCredentials> {
      try {
        if (!binding) throw new UpstreamCredentialExecutionError();
        const snapshot = captureSnapshot();
        if (!snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.candidate)) throw new UpstreamCredentialExecutionError();
        const resolution = await resolveUpstreamCredential(snapshot, {
          sourceServiceAssetId: binding.sourceServiceAssetId, endpointDefinitionId: binding.endpointDefinitionId, url, requestMethod,
        });
        const managed = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'cookie', ...snapshot.historicalAuthenticationHeaderNames ?? [], ...Object.keys(resolution.headers).map(name => name.toLowerCase())]);
        for (const credential of Object.values(snapshot.candidate.credentials)) {
          managed.add(upstreamCredentialHeaderName(credential));
        }
        return Object.freeze({ siteId: resolution.siteId, generation: resolution.generation, revision: resolution.revision, headers: resolution.headers, managedHeaderNames: Object.freeze([...managed]) });
      } catch { throw new UpstreamCredentialExecutionError(); }
    },
  });
}
