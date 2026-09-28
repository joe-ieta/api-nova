import type { SecurityProof } from '../../publication/security/upstream-security-proof-authority';
import type { TrustedProofBindingContext } from '../../publication/security/upstream-authentication-challenge-orchestrator';
import type { TrustedProofConsumptionContextReader } from '../../publication/security/upstream-security-authorization-adapter';
import type { GatewayExecutionProofCapabilityBinding, GatewayExecutionProofScope } from './gateway-upstream-proof-execution.guard';

export interface GatewayUpstreamRequestCapability {
  readonly kind: 'gateway-upstream-request-capability';
}

export interface GatewayUpstreamRequestCapabilityConsumption {
  readonly proof: SecurityProof;
  readonly session: unknown;
  readonly binding: GatewayExecutionProofCapabilityBinding;
}

export interface GatewayUpstreamRequestCapabilityProvider {
  bind(request: object, capability: GatewayUpstreamRequestCapability): boolean;
  read(request: object, scope: GatewayExecutionProofScope): Promise<GatewayUpstreamRequestCapabilityConsumption | undefined>;
  has(request: object): boolean;
  revoke(request: object): void;
}

interface CapabilityState {
  readonly proof: SecurityProof;
  readonly session: unknown;
  readonly scope: GatewayExecutionProofScope;
  readonly binding: GatewayExecutionProofCapabilityBinding;
  readonly expiresAt: number;
  consumed: boolean;
  revoked: boolean;
}

const capabilities = new WeakMap<object, CapabilityState>();
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const invalid = (): never => { throw Error('GATEWAY_UPSTREAM_REQUEST_CAPABILITY_INVALID'); };

export function createGatewayUpstreamRequestCapability(input: {
  proof: SecurityProof;
  session: unknown;
  scope: GatewayExecutionProofScope;
  method: 'GET' | 'HEAD';
  requestMethod: string;
  target: string;
  contextDigest: string;
  providerEpoch: string;
  generation: number;
  actorId: string;
  expiresAt: number;
}): GatewayUpstreamRequestCapability {
  if (!input || typeof input !== 'object' || !input.proof || typeof input.proof !== 'object'
    || input.scope == null || typeof input.scope !== 'object'
    || Object.keys(input.scope).sort().join(',') !== 'endpointDefinitionId,runtimeAssetId,runtimeMembershipId,sourceServiceAssetId'
    || ![input.scope.runtimeAssetId, input.scope.runtimeMembershipId, input.scope.endpointDefinitionId, input.scope.sourceServiceAssetId].every(identifier)
    || !['GET', 'HEAD'].includes(input.method)
    || typeof input.requestMethod !== 'string' || !/^[A-Z]{1,16}$/.test(input.requestMethod)
    || typeof input.target !== 'string'
    || !digest(input.contextDigest) || !digest(input.providerEpoch)
    || !Number.isSafeInteger(input.generation) || input.generation < 1
    || !identifier(input.actorId)
    || !Number.isFinite(input.expiresAt)) invalid();
  let url: URL;
  try { url = new URL(input.target); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid();
  const capability = Object.freeze({ kind: 'gateway-upstream-request-capability' as const });
  capabilities.set(capability, {
    proof: input.proof,
    session: input.session,
    scope: Object.freeze({ ...input.scope }),
    binding: Object.freeze({
      runtimeAssetId: input.scope.runtimeAssetId,
      runtimeMembershipId: input.scope.runtimeMembershipId,
      endpointDefinitionId: input.scope.endpointDefinitionId,
      sourceServiceAssetId: input.scope.sourceServiceAssetId,
      method: input.method,
      requestMethod: input.requestMethod,
      target: url.href,
      contextDigest: input.contextDigest,
      providerEpoch: input.providerEpoch,
      generation: input.generation,
      actorId: input.actorId,
    }),
    expiresAt: input.expiresAt,
    consumed: false,
    revoked: false,
  });
  return capability;
}

function sameScope(left: GatewayExecutionProofScope, right: GatewayExecutionProofScope): boolean {
  return left.runtimeAssetId === right.runtimeAssetId && left.runtimeMembershipId === right.runtimeMembershipId
    && left.endpointDefinitionId === right.endpointDefinitionId && left.sourceServiceAssetId === right.sourceServiceAssetId;
}

function sameBinding(binding: GatewayExecutionProofCapabilityBinding, current: TrustedProofBindingContext): boolean {
  return current.sourceServiceAssetId === binding.sourceServiceAssetId && current.endpointDefinitionId === binding.endpointDefinitionId
    && current.actorId === binding.actorId && current.method === binding.method && current.target === binding.target
    && current.contextDigest === binding.contextDigest && current.providerEpoch === binding.providerEpoch
    && current.generation === binding.generation;
}

export function createGatewayUpstreamRequestCapabilityProvider(options: {
  contexts?: TrustedProofConsumptionContextReader;
  now?: () => number;
  ttlMs?: number;
} = {}): GatewayUpstreamRequestCapabilityProvider {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60000;
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300000) throw Error('GATEWAY_UPSTREAM_REQUEST_CAPABILITY_CONFIGURATION');
  const bound = new WeakMap<object, GatewayUpstreamRequestCapability>();
  const unusable = (state: CapabilityState | undefined) => !state || state.consumed || state.revoked;
  return Object.freeze({
    bind(request: object, capability: GatewayUpstreamRequestCapability): boolean {
      if (!request || typeof request !== 'object' || !capability || typeof capability !== 'object') return false;
      const state = capabilities.get(capability);
      if (unusable(state) || now() >= state.expiresAt) return false;
      if (bound.has(request)) return false;
      bound.set(request, capability);
      return true;
    },
    async read(request: object, scope: GatewayExecutionProofScope): Promise<GatewayUpstreamRequestCapabilityConsumption | undefined> {
      if (!request || typeof request !== 'object' || !scope || typeof scope !== 'object') return undefined;
      const capability = bound.get(request);
      if (!capability) return undefined;
      const state = capabilities.get(capability);
      if (unusable(state)) { bound.delete(request); return undefined; }
      state.consumed = true;
      try {
        if (now() >= state.expiresAt || !sameScope(state.scope, scope)) return undefined;
        const requestMethod = typeof (request as { method?: unknown }).method === 'string'
          ? String((request as { method?: unknown }).method).toUpperCase() : '';
        if (requestMethod !== state.binding.requestMethod) return undefined;
        if (options.contexts) {
          const current = await options.contexts.read(state.session, Object.freeze({
            runtimeAssetId: state.scope.runtimeAssetId, runtimeMembershipId: state.scope.runtimeMembershipId,
          }));
          if (!current || !sameBinding(state.binding, current)) return undefined;
        }
        return Object.freeze({ proof: state.proof, session: state.session, binding: state.binding });
      } catch { return undefined; }
    },
    has(request: object): boolean {
      return Boolean(request && typeof request === 'object' && bound.has(request));
    },
    revoke(request: object): void {
      if (!request || typeof request !== 'object') return;
      const capability = bound.get(request);
      bound.delete(request);
      const state = capability ? capabilities.get(capability) : undefined;
      if (state) state.revoked = true;
    },
  });
}
