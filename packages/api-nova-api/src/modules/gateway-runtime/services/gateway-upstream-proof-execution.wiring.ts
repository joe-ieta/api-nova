import type { ValueProvider } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { UpstreamProductionChallengeEvidenceEntity as Evidence } from '../../../database/entities/upstream-production-challenge-evidence.entity';
import type { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import type { UpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import type { UpstreamAuthenticationChallengeTransport } from '../../publication/security/upstream-authentication-challenge-transport';
import type { TrustedProofConsumptionContextReader } from '../../publication/security/upstream-security-authorization-adapter';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayUpstreamProofExecutionGuard } from './gateway-upstream-proof-execution.guard';
import {
  createGatewayUpstreamProofAuthorityLifecycle,
  type GatewayUpstreamChallengeIntentIssuer,
  type GatewayUpstreamProofAuthorityLifecycle,
} from './gateway-upstream-proof-authority.lifecycle';
import {
  createGatewayUpstreamRequestCapabilityProvider,
  type GatewayUpstreamRequestCapabilityProvider,
} from './gateway-upstream-request-capability.provider';

export const GATEWAY_UPSTREAM_PROOF_EXECUTION = Symbol('GATEWAY_UPSTREAM_PROOF_EXECUTION');

export interface GatewayUpstreamProofExecution {
  readonly kind: 'gateway-upstream-proof-execution';
  readonly guard: Readonly<{ assertCurrent(route: GatewayResolvedRoute, request: object): Promise<void> }>;
  readonly lifecycle: GatewayUpstreamProofAuthorityLifecycle;
  readonly capabilities: GatewayUpstreamRequestCapabilityProvider;
  close(): Promise<void>;
}

const executions = new WeakSet<object>();
const invalid = (): never => { throw Error('gateway_upstream_proof_execution_invalid'); };

export function createGatewayUpstreamProofExecution(input: {
  endpoints: Pick<Repository<EndpointDefinitionEntity>, 'findOneBy'>;
  authority: UpstreamSecurityContextAuthority;
  transport: UpstreamAuthenticationChallengeTransport;
  intents: GatewayUpstreamChallengeIntentIssuer;
  repository: Pick<Repository<Evidence>, 'create' | 'save' | 'findOneBy' | 'update'>;
  contexts: TrustedProofConsumptionContextReader;
  ttlMs?: number;
  now?: () => number;
}): GatewayUpstreamProofExecution {
  if (!input || typeof input !== 'object' || !input.endpoints || typeof input.endpoints.findOneBy !== 'function'
    || !input.authority || !input.transport || !input.intents || !input.repository || !input.contexts
    || typeof input.contexts.read !== 'function') invalid();
  const capabilities = createGatewayUpstreamRequestCapabilityProvider({ contexts: input.contexts, now: input.now, ttlMs: input.ttlMs });
  const lifecycle = createGatewayUpstreamProofAuthorityLifecycle({
    authority: input.authority, transport: input.transport, intents: input.intents, repository: input.repository,
    contexts: input.contexts, ttlMs: input.ttlMs, now: input.now,
  });
  const guard = new GatewayUpstreamProofExecutionGuard(input.endpoints, capabilities,
    { authorize: (proof, session, selector) => lifecycle.authorize(proof, session, selector) });
  const execution = Object.freeze({
    kind: 'gateway-upstream-proof-execution' as const,
    guard: Object.freeze({ assertCurrent: (route: GatewayResolvedRoute, request: object) => guard.assertCurrent(route, request) }),
    lifecycle,
    capabilities,
    close: () => lifecycle.close(),
  });
  executions.add(execution);
  return execution;
}

export function assertGatewayUpstreamProofExecution(value: unknown): GatewayUpstreamProofExecution {
  if (!value || typeof value !== 'object' || !executions.has(value as object)
    || typeof (value as GatewayUpstreamProofExecution).guard?.assertCurrent !== 'function'
    || typeof (value as GatewayUpstreamProofExecution).close !== 'function') invalid();
  return value as GatewayUpstreamProofExecution;
}

/** Only null or undefined are default-off; anything else must be an explicit branded execution. */
export function resolveGatewayUpstreamProofExecution(value: unknown): GatewayUpstreamProofExecution | null {
  if (value === null || value === undefined) return null;
  return assertGatewayUpstreamProofExecution(value);
}

export const gatewayUpstreamProofExecutionProvider: ValueProvider<null> = {
  provide: GATEWAY_UPSTREAM_PROOF_EXECUTION,
  useValue: null,
};
