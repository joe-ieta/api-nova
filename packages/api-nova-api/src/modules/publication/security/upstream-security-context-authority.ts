import { createHmac, randomBytes } from 'node:crypto';
import { resolveUpstreamCredential, type UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import { createUpstreamSecurityBindingEvaluator } from './upstream-security-binding-evaluator';
import { reconcileUpstreamSecurity, securityDigest, type SecurityDeclaration } from './upstream-security-reconciliation';
/** Repository is a host capability, never a request DTO or metadata adapter. */
export interface TrustedBindingRepository {
  read(ids: { sourceServiceAssetId: string; endpointDefinitionId: string }): Promise<Readonly<{
    sourceServiceAssetId: string; endpointDefinitionId: string; bindingId: string; bindingRevision: string;
    declaration: SecurityDeclaration; selectedBranch?: number; target: string; method: 'GET' | 'HEAD';
  }> | undefined>;
}
declare const challengeTarget: unique symbol;
export type ChallengeTarget = { readonly [challengeTarget]: true };
export interface ChallengeContext {
  readonly sourceServiceAssetId: string; readonly endpointDefinitionId: string;
  readonly contextDigest: string; readonly providerEpoch: string;
  readonly bindingId: string; readonly bindingRevision: string; readonly registryRevision: string; readonly generation: number;
  readonly target: string; readonly method: 'GET' | 'HEAD'; readonly credentialType: string;
}
export function createUpstreamSecurityContextAuthority(repository: TrustedBindingRepository, captureSnapshot: () => UpstreamCredentialRegistrySnapshot) {
  const evaluator = createUpstreamSecurityBindingEvaluator(captureSnapshot);
  const key = randomBytes(32);
  const tokens = new WeakMap<ChallengeTarget, { context: ChallengeContext; material: string }>();
  const digest = (headers: Readonly<Record<string, string>>) => createHmac('sha256', key).update(JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const failed = () => new Error('CHALLENGE_CONTEXT_UNAVAILABLE');
  async function read(ids: { sourceServiceAssetId: string; endpointDefinitionId: string }) {
    const row = await repository.read(Object.freeze({ ...ids }));
    if (!row || row.sourceServiceAssetId !== ids.sourceServiceAssetId || row.endpointDefinitionId !== ids.endpointDefinitionId || !row.bindingRevision || typeof row.bindingId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.bindingId)) throw failed();
    const captured = structuredClone(row), url = new URL(captured.target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !['GET', 'HEAD'].includes(captured.method)) throw failed();
    const snapshot = captureSnapshot();
    const input = { ...ids, url: url.href, requestMethod: captured.method };
    const binding = await evaluator.evaluate(input);
    const context = { ...ids, target: url.href, method: captured.method, environment: snapshot.candidate.metadata.environment };
    const decision = reconcileUpstreamSecurity({ context, declaration: captured.declaration, selectedBranch: captured.selectedBranch, binding });
    if (decision.state !== 'Configured' || binding.reason || !binding.providerEpoch) throw failed();
    const credentials = await resolveUpstreamCredential(snapshot, input);
    const after = await evaluator.evaluate(input);
    if (captureSnapshot() !== snapshot || after.reason || after.providerEpoch !== binding.providerEpoch || credentials.mode !== 'reference') throw failed();
    const currentRow = await repository.read(Object.freeze({ ...ids }));
    if (captureSnapshot() !== snapshot || securityDigest(currentRow) !== securityDigest(captured)) throw failed();
    return { context: Object.freeze({ ...ids, contextDigest: securityDigest({ decision: decision.contextDigest, bindingId: captured.bindingId, bindingRevision: captured.bindingRevision, registryRevision: binding.revision, generation: binding.generation }),
      bindingId: captured.bindingId, bindingRevision: captured.bindingRevision, registryRevision: binding.revision, generation: binding.generation,
      providerEpoch: binding.providerEpoch, target: url.href, method: captured.method, credentialType: binding.credential!.type }), headers: credentials.headers };
  }
  return Object.freeze({
    async issue(ids: { sourceServiceAssetId: string; endpointDefinitionId: string }): Promise<ChallengeTarget> {
      try {
        if (!ids || Object.keys(ids).sort().join(',') !== 'endpointDefinitionId,sourceServiceAssetId' ||
          ![ids.sourceServiceAssetId, ids.endpointDefinitionId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))) throw failed();
        const result = await read({ ...ids }); const token = Object.freeze({}) as ChallengeTarget;
        tokens.set(token, { context: result.context, material: digest(result.headers) }); return token;
      } catch { throw failed(); }
    },
    inspect(token: ChallengeTarget): ChallengeContext { const entry = tokens.get(token); if (!entry) throw failed(); return entry.context; },
    async resolveCurrent(token: ChallengeTarget): Promise<Readonly<Record<string, string>>> {
      const entry = tokens.get(token); if (!entry) throw failed();
      try {
        const current = await read({ sourceServiceAssetId: entry.context.sourceServiceAssetId, endpointDefinitionId: entry.context.endpointDefinitionId });
        if (tokens.get(token) !== entry || securityDigest(current.context) !== securityDigest(entry.context) || digest(current.headers) !== entry.material) throw failed();
        return Object.freeze({ ...current.headers });
      } catch { tokens.delete(token); throw failed(); }
    },
    revoke(token: ChallengeTarget): void { tokens.delete(token); },
  });
}
export type UpstreamSecurityContextAuthority = ReturnType<typeof createUpstreamSecurityContextAuthority>;
