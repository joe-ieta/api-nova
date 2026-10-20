import { types } from 'node:util';
import type { EntityManager } from 'typeorm';
import type { UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';
import type { TrustedBindingRepository } from './upstream-security-context-authority';
import type { TrustedChallengeSessionAuthority, ChallengeIntentAudit } from './trusted-challenge-intent-authority';
import type { PublicationPreviewSelector } from '../services/publication-security-preview-adapter';

export const PUBLICATION_HOST_AUTHORITY_PLAN = Symbol('PUBLICATION_HOST_AUTHORITY_PLAN');
declare const planBrand: unique symbol;
export type PublicationHostAuthorityPlan = { readonly [planBrand]: true };
export interface PublicationHostAuthorityOptions {
  sessions: TrustedChallengeSessionAuthority;
  /** Authoritative policy store; never source.owner, request.user or JSON claims.
   * Both checks must use manager when supplied and must reject unknown ownership. */
  ownership: {
    resolve(actorId: string, ids: { sourceServiceAssetId: string; endpointDefinitionId: string }, manager?: EntityManager): Promise<{ revision: string } | undefined>;
    resolveMembership(actorId: string, selector: Readonly<PublicationPreviewSelector>, manager: EntityManager): Promise<{ revision: string } | undefined>;
  };
  bindings: TrustedBindingRepository;
  captureSnapshot(): UpstreamCredentialRegistrySnapshot;
  audit: ChallengeIntentAudit;
  ttlMs?: number;
}
const plans = new WeakMap<PublicationHostAuthorityPlan, Readonly<PublicationHostAuthorityOptions>>();
const invalid = (): never => { throw Error('publication_host_authority_plan_invalid'); };
function methods(value: unknown, names: readonly string[]): Record<string, Function> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return invalid();
  const result: Record<string, Function> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) return invalid();
    result[name] = descriptor.value.bind(value);
  }
  return Object.freeze(result);
}
/** Host code only. There is intentionally no environment, DTO or database adapter
 * that can turn serialized configuration into this capability. No permission seed. */
export function attestPublicationHostAuthorityPlan(input: PublicationHostAuthorityOptions): PublicationHostAuthorityPlan {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  const values: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !['sessions', 'ownership', 'bindings', 'captureSnapshot', 'audit', 'ttlMs'].includes(key) || !('value' in descriptor)) return invalid();
    values[key] = descriptor.value;
  }
  const ttlMs = values.ttlMs ?? 30000;
  if (!Number.isSafeInteger(ttlMs) || Number(ttlMs) < 1 || Number(ttlMs) > 60000 ||
    typeof values.captureSnapshot !== 'function' || types.isProxy(values.captureSnapshot)) return invalid();
  const plan = Object.freeze({}) as PublicationHostAuthorityPlan;
  plans.set(plan, Object.freeze({
    sessions: methods(values.sessions, ['resolve']) as unknown as PublicationHostAuthorityOptions['sessions'],
    ownership: methods(values.ownership, ['resolve', 'resolveMembership']) as unknown as PublicationHostAuthorityOptions['ownership'],
    bindings: methods(values.bindings, ['read']) as unknown as PublicationHostAuthorityOptions['bindings'],
    captureSnapshot: values.captureSnapshot.bind(input) as PublicationHostAuthorityOptions['captureSnapshot'],
    audit: methods(values.audit, ['record']) as unknown as PublicationHostAuthorityOptions['audit'],
    ttlMs: Number(ttlMs),
  }));
  return plan;
}
export function inspectPublicationHostAuthorityPlan(plan: PublicationHostAuthorityPlan): Readonly<PublicationHostAuthorityOptions> {
  return plans.get(plan) ?? invalid();
}
