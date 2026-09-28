import type { Repository } from 'typeorm';
import { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import type { TrustedChallengeIntent } from '../../publication/security/trusted-challenge-intent-authority';
import type { UpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import type { UpstreamAuthenticationChallengeTransport } from '../../publication/security/upstream-authentication-challenge-transport';
import {
  createUpstreamAuthenticationChallengeOrchestrator,
  type OrchestratedChallengeResult,
  type TrustedChallengeIntentAuthority,
} from '../../publication/security/upstream-authentication-challenge-orchestrator';
import {
  createUpstreamSecurityAuthorizationAdapter,
  type TrustedProofConsumptionContextReader,
} from '../../publication/security/upstream-security-authorization-adapter';
import type { SecurityProof } from '../../publication/security/upstream-security-proof-authority';
import { securityDigest } from '../../publication/security/upstream-security-reconciliation';
import {
  createGatewayUpstreamRequestCapability,
  type GatewayUpstreamRequestCapabilityProvider,
} from './gateway-upstream-request-capability.provider';

declare const gatewayUpstreamProofGrant: unique symbol;
export type GatewayUpstreamProofGrant = { readonly [gatewayUpstreamProofGrant]: true };

export interface GatewayUpstreamChallengeIntentIssuer extends TrustedChallengeIntentAuthority {
  issue(session: unknown, ids: Readonly<{ sourceServiceAssetId: string; endpointDefinitionId: string }>): Promise<TrustedChallengeIntent>;
  complete(intent: TrustedChallengeIntent, status: 'passed' | 'failed'): Promise<void>;
}

export interface GatewayUpstreamProofAuthorityLifecycle {
  issue(session: unknown, ids: Readonly<{ sourceServiceAssetId: string; endpointDefinitionId: string }>, signal?: AbortSignal): Promise<GatewayUpstreamProofGrant>;
  bind(request: object, grant: GatewayUpstreamProofGrant, selector: Readonly<{ runtimeAssetId: string; runtimeMembershipId: string }>,
    capabilities: GatewayUpstreamRequestCapabilityProvider, requestMethod: string): Promise<boolean>;
  authorize(proof: SecurityProof, session: unknown, selector: Readonly<{ runtimeAssetId: string; runtimeMembershipId: string }>): Promise<boolean>;
  isCurrent(grant: GatewayUpstreamProofGrant): Promise<boolean>;
  revoke(grant: GatewayUpstreamProofGrant): Promise<void>;
  active(): number;
  close(): Promise<void>;
}

interface GrantState {
  readonly proof: SecurityProof;
  readonly session: unknown;
  readonly result: OrchestratedChallengeResult;
  readonly expiresAt: number;
  consumed: boolean;
  revoked: boolean;
}

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const unavailable = (): Error => Error('GATEWAY_UPSTREAM_PROOF_AUTHORITY_UNAVAILABLE');

export function createGatewayUpstreamProofAuthorityLifecycle(options: {
  authority: UpstreamSecurityContextAuthority;
  transport: UpstreamAuthenticationChallengeTransport;
  intents: GatewayUpstreamChallengeIntentIssuer;
  repository: Pick<Repository<Evidence>, 'create' | 'save' | 'findOneBy' | 'update'>;
  contexts: TrustedProofConsumptionContextReader;
  ttlMs?: number;
  now?: () => number;
}): GatewayUpstreamProofAuthorityLifecycle {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60000;
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300000
    || !options.authority || !options.transport || !options.intents || !options.repository || !options.contexts) throw Error('GATEWAY_UPSTREAM_PROOF_LIFECYCLE_CONFIGURATION');
  const orchestrator = createUpstreamAuthenticationChallengeOrchestrator({
    intents: options.intents, authority: options.authority, transport: options.transport, repository: options.repository, ttlMs,
  });
  const authorization = createUpstreamSecurityAuthorizationAdapter(orchestrator, options.contexts);
  const grants = new WeakMap<GatewayUpstreamProofGrant, GrantState>();
  const live = new Set<GatewayUpstreamProofGrant>();

  async function current(state: GrantState): Promise<boolean> {
    if (state.revoked || state.consumed || now() >= state.expiresAt) return false;
    try { return await orchestrator.isCurrent(state.result); } catch { return false; }
  }
  async function revokeState(state: GrantState): Promise<void> {
    state.revoked = true;
    try { await orchestrator.revoke(state.result); } catch { throw unavailable(); }
  }
  const validIds = (ids: unknown): ids is { sourceServiceAssetId: string; endpointDefinitionId: string } =>
    Boolean(ids) && typeof ids === 'object' && Object.keys(ids as object).sort().join(',') === 'endpointDefinitionId,sourceServiceAssetId'
    && identifier((ids as { sourceServiceAssetId?: unknown }).sourceServiceAssetId)
    && identifier((ids as { endpointDefinitionId?: unknown }).endpointDefinitionId);
  const validSelector = (selector: unknown): selector is { runtimeAssetId: string; runtimeMembershipId: string } =>
    Boolean(selector) && typeof selector === 'object' && Object.keys(selector as object).sort().join(',') === 'runtimeAssetId,runtimeMembershipId'
    && identifier((selector as { runtimeAssetId?: unknown }).runtimeAssetId)
    && identifier((selector as { runtimeMembershipId?: unknown }).runtimeMembershipId);

  return Object.freeze({
    async issue(session: unknown, ids: { sourceServiceAssetId: string; endpointDefinitionId: string }, signal?: AbortSignal): Promise<GatewayUpstreamProofGrant> {
      if (!validIds(ids)) throw unavailable();
      let intent: TrustedChallengeIntent | undefined, result: OrchestratedChallengeResult | undefined;
      try {
        intent = await options.intents.issue(session, Object.freeze({ ...ids }));
        result = await orchestrator.execute(intent, signal);
      } catch {
        if (intent) { try { await options.intents.complete(intent, 'failed'); } catch { /* fail closed */ } }
        throw unavailable();
      }
      try { await options.intents.complete(intent, 'passed'); } catch {
        try { await orchestrator.revoke(result); } catch { /* fail closed */ }
        throw unavailable();
      }
      const grant = Object.freeze({}) as GatewayUpstreamProofGrant;
      grants.set(grant, { proof: result.proof, session, result, expiresAt: now() + ttlMs, consumed: false, revoked: false });
      live.add(grant);
      return grant;
    },

    async bind(request: object, grant: GatewayUpstreamProofGrant, selector: { runtimeAssetId: string; runtimeMembershipId: string },
      capabilities: GatewayUpstreamRequestCapabilityProvider, requestMethod: string): Promise<boolean> {
      const state = grants.get(grant);
      if (!state || !request || typeof request !== 'object' || typeof capabilities?.bind !== 'function' || !validSelector(selector)) return false;
      try {
        const normalizedMethod = String(requestMethod ?? '').toUpperCase();
        if (!(await current(state)) || !(await authorization.authorize(state.proof, state.session, selector))) return false;
        const first = await options.contexts.read(state.session, Object.freeze({ ...selector }));
        if (!first || normalizedMethod !== first.method) return false;
        if (!(await authorization.authorize(state.proof, state.session, selector))) return false;
        const second = await options.contexts.read(state.session, Object.freeze({ ...selector }));
        if (!second || securityDigest(second) !== securityDigest(first)) return false;
        state.consumed = true;
        const capability = createGatewayUpstreamRequestCapability({
          proof: state.proof, session: state.session,
          scope: { runtimeAssetId: selector.runtimeAssetId, runtimeMembershipId: selector.runtimeMembershipId,
            endpointDefinitionId: first.endpointDefinitionId, sourceServiceAssetId: first.sourceServiceAssetId },
          method: first.method, requestMethod: normalizedMethod,
          target: first.target, contextDigest: first.contextDigest, providerEpoch: first.providerEpoch,
          generation: first.generation, actorId: first.actorId, expiresAt: Math.min(state.expiresAt, now() + ttlMs),
        });
        if (!capabilities.bind(request, capability)) return false;
        live.delete(grant);
        return true;
      } catch { return false; }
    },

    async authorize(proof: SecurityProof, session: unknown, selector: { runtimeAssetId: string; runtimeMembershipId: string }): Promise<boolean> {
      try {
        if (!validSelector(selector)) return false;
        return await authorization.authorize(proof, session, selector);
      } catch { return false; }
    },

    async isCurrent(grant: GatewayUpstreamProofGrant): Promise<boolean> {
      const state = grants.get(grant);
      return state ? current(state) : false;
    },

    async revoke(grant: GatewayUpstreamProofGrant): Promise<void> {
      const state = grants.get(grant);
      if (!state) return;
      grants.delete(grant);
      live.delete(grant);
      await revokeState(state);
    },

    active(): number { return live.size; },

    async close(): Promise<void> {
      for (const grant of [...live]) {
        const state = grants.get(grant);
        if (!state) continue;
        grants.delete(grant);
        live.delete(grant);
        try { await revokeState(state); } catch { /* fail closed */ }
      }
    },
  });
}
