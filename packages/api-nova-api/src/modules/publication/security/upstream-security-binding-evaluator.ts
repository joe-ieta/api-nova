import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolveUpstreamCredential, type UpstreamCredentialRegistrySnapshot,
  type UpstreamCredentialResolveInput } from 'api-nova-parser';
import type { SecurityReason, TrustedSecurityBinding } from './upstream-security-reconciliation';

/** Internal host API: use only an authoritative Registry capture callback.
 * This never probes an upstream or produces Verified evidence. Epochs are local
 * opaque change tokens; restart/eviction conservatively requires reverification.
 * They describe the observed injection, not an atomic/durable Provider version.
 * A future verification ledger must evaluate again before using its evidence.
 */
export function createUpstreamSecurityBindingEvaluator(
  captureSnapshot: () => UpstreamCredentialRegistrySnapshot,
): { evaluate(input: UpstreamCredentialResolveInput): Promise<TrustedSecurityBinding> } {
  if (typeof captureSnapshot !== 'function') throw new Error('Trusted registry capture is required');
  // Neither keyed fingerprints nor secret values can be enumerated/serialized from
  // the public object. A fresh random key also defeats offline token dictionaries.
  const fingerprintKey = randomBytes(32);
  const slots = new Map<string, { request: number; digest?: string; epoch?: string }>();
  let sequence = 0;
  const blocked = (reason: SecurityReason, snapshot?: UpstreamCredentialRegistrySnapshot): TrustedSecurityBinding => ({
    mode: 'unresolved', revision: snapshot?.candidate.metadata.revision || '',
    generation: snapshot?.generation || 0, providerEpoch: '', secretsResolved: false, reason,
  });
  const reasons: Record<string, SecurityReason> = {
    SITE_NOT_FOUND: 'BindingMissing', CREDENTIAL_POLICY_UNRESOLVED: 'BindingMissing',
    CREDENTIAL_NOT_FOUND: 'BindingMissing', ENDPOINT_SELECTOR_AMBIGUOUS: 'BindingAmbiguous',
    SECRET_RESOLUTION_FAILED: 'SecretUnavailable', CREDENTIAL_INACTIVE: 'CredentialInactive',
    SCOPE_MISMATCH: 'ScopeMismatch', INVALID_TARGET_URL: 'ScopeMismatch',
    INVALID_RESOLUTION_INPUT: 'ScopeMismatch', UNSUPPORTED_CREDENTIAL_TYPE: 'BindingIncompatible',
  };
  return Object.freeze({
    async evaluate(input: UpstreamCredentialResolveInput): Promise<TrustedSecurityBinding> {
      let snapshot: UpstreamCredentialRegistrySnapshot;
      try { snapshot = captureSnapshot(); } catch { slots.clear(); return blocked('BindingMissing'); }
      // Copy only the supported scalar request fields. Do not retain mutable caller objects.
      const request = { ...input };
      const key = JSON.stringify([request.sourceServiceAssetId, request.endpointDefinitionId,
        request.url, request.requestMethod, request.method, request.endpointPath]);
      const entry = slots.get(key) || { request: 0 };
      const requestId = ++sequence;
      entry.request = requestId;
      slots.delete(key); slots.set(key, entry);
      if (slots.size > 256) slots.delete(slots.keys().next().value!);
      const current = () => slots.get(key) === entry && entry.request === requestId;
      try {
        const resolution = await resolveUpstreamCredential(snapshot, request);
        // Never let a late old provider read overwrite a newer evaluation or reload.
        if (!current()) return blocked('VerificationStale', snapshot);
        if (captureSnapshot() !== snapshot) {
          slots.delete(key); return blocked('VerificationStale', snapshot);
        }
        const metadata = { revision: resolution.revision, generation: resolution.generation,
          providerEpoch: '', secretsResolved: true };
        if (resolution.mode === 'none') {
          entry.digest = undefined; entry.epoch = undefined;
          return Object.freeze({ ...metadata, mode: 'none' as const });
        }
        const credential = resolution.credentialId && snapshot.candidate.credentials[resolution.credentialId];
        if (!credential) { slots.delete(key); return blocked('BindingMissing', snapshot); }
        const digest = createHmac('sha256', fingerprintKey).update(JSON.stringify([
          resolution.generation, resolution.revision, resolution.siteId, resolution.credentialId, credential.type, snapshot.candidate.metadata.environment,
          Object.entries(resolution.headers).sort(([a], [b]) => a.localeCompare(b)),
        ])).digest('hex');
        if (entry.digest !== digest) { entry.digest = digest; entry.epoch = randomUUID(); }
        return Object.freeze({ ...metadata, mode: 'reference' as const,
          credentialId: resolution.credentialId, credential, providerEpoch: entry.epoch!,
        });
      } catch (error) {
        if (!current()) return blocked('VerificationStale', snapshot);
        slots.delete(key); // A failed read breaks continuity, even if the next secret matches.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        return blocked(reasons[code] || 'SecretUnavailable', snapshot);
      }
    },
  });
}
