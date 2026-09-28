import { randomUUID } from 'node:crypto';
import type { UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import {
  createUpstreamSecurityContextAuthority,
  type ChallengeTarget,
  type TrustedBindingRepository,
} from '../../publication/security/upstream-security-context-authority';
import type {
  ManagedLifecyclePermitAuthority,
  ManagedLifecyclePermitContext,
  ManagedLifecyclePermitInput,
  ManagedLifecyclePermitProvider,
} from './managed-mcp-lifecycle-coordinator.service';

/** Exact trusted operation selector consumed by one live capability. The tool
 * name is reporting metadata only; binding identity is source/endpoint/method/
 * target. No proof or credential material is ever part of this shape. */
export interface ManagedExecutionPermitSelector {
  readonly method: string;
  readonly path: string;
  readonly sourceServiceAssetId: string;
  readonly endpointDefinitionId: string;
}
export interface ManagedExecutionPermitAuthorityOptions {
  readonly permitId: string;
  readonly launchId: string;
  readonly selectors: readonly ManagedExecutionPermitSelector[];
  readonly repository: TrustedBindingRepository;
  readonly captureSnapshot: () => UpstreamCredentialRegistrySnapshot;
  readonly now?: () => number;
  readonly ttlMs?: number;
}
/** Non-secret diagnostic projection. It never contains a capability token,
 * credential header, HMAC material or resolved secret. */
export interface ManagedExecutionPermitReport {
  readonly permitId: string;
  readonly launchId: string;
  readonly selectorCount: number;
  readonly livePermits: readonly string[];
  readonly allows: number;
  readonly denies: number;
  readonly revoked: boolean;
}
export interface ManagedExecutionPermitSource {
  readonly repository: TrustedBindingRepository;
  readonly captureSnapshot: () => UpstreamCredentialRegistrySnapshot;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly permitId?: (context: ManagedLifecyclePermitContext) => string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
const DEFAULT_TTL_MS = 60000;
const MAX_TTL_MS = 300000;
const ALLOW = Object.freeze({ decision: 'allow' as const });
const DENY = Object.freeze({ decision: 'deny' as const });

function selectorKey(selector: ManagedExecutionPermitSelector): string {
  return [selector.sourceServiceAssetId, selector.endpointDefinitionId, selector.method, selector.path].join('|');
}
/** A trusted operation path may be templated (`/items/{id}`); the live DB row
 * carries the concrete target. Compare per segment so a changed concrete target
 * that no longer satisfies the selector is rejected instead of matched loosely. */
function pathMatches(template: string, actual: string): boolean {
  const expected = template.split('/'), observed = actual.split('/');
  if (expected.length !== observed.length) return false;
  return expected.every((segment, index) => /^\{[^/{}]+\}$/.test(segment) ? observed[index].length > 0 : segment === observed[index]);
}

/** Host-side live permit authority for one launch generation. It consumes the
 * F1-02C3G1 capability authority: a real capability is issued per exact
 * source/endpoint selector, inspected for target/method/epoch, then revalidated
 * in-process on every execution. Forged, stale, revoked, rotated or DB-row
 * changes fail closed. The capability token is a process-local WeakMap key and
 * is never stored in a serializable field, returned or sent over IPC. */
export function createManagedExecutionPermitAuthority(
  options: ManagedExecutionPermitAuthorityOptions,
): ManagedLifecyclePermitAuthority & { report(): ManagedExecutionPermitReport } {
  const invalid = () => new Error('MANAGED_PERMIT_CONFIGURATION_INVALID');
  if (!options || typeof options !== 'object' || !IDENTIFIER.test(String(options.permitId ?? '')) ||
    !IDENTIFIER.test(String(options.launchId ?? '')) || typeof options.captureSnapshot !== 'function' ||
    !options.repository || typeof options.repository.read !== 'function') throw invalid();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw invalid();
  if (!Array.isArray(options.selectors) || !options.selectors.length || options.selectors.length > 10000) throw invalid();
  const allowed = new Map<string, ManagedExecutionPermitSelector>();
  for (const selector of options.selectors) {
    if (!selector || typeof selector !== 'object' || !IDENTIFIER.test(String(selector.sourceServiceAssetId ?? '')) ||
      !IDENTIFIER.test(String(selector.endpointDefinitionId ?? '')) || !METHODS.includes(selector.method) ||
      typeof selector.path !== 'string' || selector.path.length < 1 || selector.path.length > 1024 ||
      !selector.path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(selector.path)) throw invalid();
    const key = selectorKey(selector);
    if (allowed.has(key)) throw invalid();
    allowed.set(key, Object.freeze({ method: selector.method, path: selector.path,
      sourceServiceAssetId: selector.sourceServiceAssetId, endpointDefinitionId: selector.endpointDefinitionId }));
  }
  const now = options.now ?? (() => Date.now());
  const contextAuthority = createUpstreamSecurityContextAuthority(options.repository, options.captureSnapshot);
  const permits = new Map<string, {
    token: ChallengeTarget; contextDigest: string; providerEpoch: string;
    bindingId: string; bindingRevision: string; expiresAt: number;
  }>();
  let revoked = false, allows = 0, denies = 0;
  const drop = (entry: { token: ChallengeTarget } | undefined) => {
    if (entry) { try { contextAuthority.revoke(entry.token); } catch { /* already invalid */ } }
  };
  const revokeAll = () => { for (const entry of permits.values()) drop(entry); permits.clear(); };
  return Object.freeze({
    permitId: options.permitId,
    launchId: options.launchId,
    async authorize(request: ManagedLifecyclePermitInput): Promise<{ readonly decision: 'allow' | 'deny' }> {
      if (revoked) { denies += 1; return DENY; }
      let key: string | undefined;
      try {
        if (!request || typeof request !== 'object') { denies += 1; return DENY; }
        key = selectorKey(request as ManagedExecutionPermitSelector);
        const selector = allowed.get(key);
        if (!selector) { denies += 1; return DENY; }
        let entry = permits.get(key);
        if (entry && now() >= entry.expiresAt) { drop(entry); permits.delete(key); entry = undefined; }
        if (!entry) {
          const token = await contextAuthority.issue(Object.freeze({ sourceServiceAssetId: selector.sourceServiceAssetId,
            endpointDefinitionId: selector.endpointDefinitionId }));
          let context;
          try {
            context = contextAuthority.inspect(token);
            if (context.method !== selector.method || !pathMatches(selector.path, new URL(context.target).pathname) ||
              typeof context.contextDigest !== 'string' || typeof context.providerEpoch !== 'string' ||
              !context.bindingId || !context.bindingRevision) throw new Error();
          } catch { drop({ token }); throw new Error(); }
          entry = { token, contextDigest: context.contextDigest, providerEpoch: context.providerEpoch,
            bindingId: context.bindingId, bindingRevision: context.bindingRevision, expiresAt: now() + ttlMs };
          permits.set(key, entry);
        }
        // Live revalidation on every execution: DB row, declaration, registry,
        // provider epoch and resolved material must still match this capability.
        await contextAuthority.resolveCurrent(entry.token);
        if (revoked || permits.get(key) !== entry || now() >= entry.expiresAt) { drop(entry); permits.delete(key); denies += 1; return DENY; }
        allows += 1;
        return ALLOW;
      } catch {
        if (key) { const entry = permits.get(key); if (entry) { drop(entry); permits.delete(key); } }
        denies += 1;
        return DENY;
      }
    },
    /** Permanent for this per-launch authority: a restarted generation gets a
     * fresh authority and can never reuse a revoked permit identity. */
    revoke(): void { revoked = true; revokeAll(); },
    report(): ManagedExecutionPermitReport {
      return Object.freeze({ permitId: options.permitId, launchId: options.launchId, selectorCount: allowed.size,
        livePermits: Object.freeze([...permits.keys()]), allows, denies, revoked });
    },
  });
}

/** Trusted-only provider seam: builds one authority per launch generation from
 * the handoff's trusted operation bindings. Absence of the provider keeps the
 * E3b default-open child behavior; presence opts every execution into the live
 * host permit round trip. */
export function createManagedExecutionPermitProvider(source: ManagedExecutionPermitSource): ManagedLifecyclePermitProvider {
  if (!source || typeof source !== 'object' || typeof source.captureSnapshot !== 'function' ||
    !source.repository || typeof source.repository.read !== 'function') throw new Error('MANAGED_PERMIT_CONFIGURATION_INVALID');
  return (context: ManagedLifecyclePermitContext) => {
    if (!context || typeof context !== 'object' || !context.payload ||
      !Array.isArray(context.payload.trustedOperationBindings) || !IDENTIFIER.test(String(context.payload.launchId ?? ''))) {
      throw new Error('MANAGED_PERMIT_CONFIGURATION_INVALID');
    }
    const permitId = source.permitId ? source.permitId(context) : `permit-${randomUUID()}`;
    return createManagedExecutionPermitAuthority({
      permitId, launchId: context.payload.launchId,
      selectors: context.payload.trustedOperationBindings.map(binding => Object.freeze({ method: binding.method,
        path: binding.path, sourceServiceAssetId: binding.sourceServiceAssetId, endpointDefinitionId: binding.endpointDefinitionId })),
      repository: source.repository, captureSnapshot: source.captureSnapshot, now: source.now, ttlMs: source.ttlMs,
    });
  };
}
