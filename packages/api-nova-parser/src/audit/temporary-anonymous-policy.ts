import { RuntimeAuthError } from './runtime-auth';

/** A grant issued by the authenticated control plane, never by an inbound caller. */
export interface TemporaryAnonymousPolicy {
  reason: string;
  actor: string;
  expiresAt: string;
  allowProduction: boolean;
}

export function normalizeTemporaryAnonymousPolicy(raw: unknown, trustedActor?: string): TemporaryAnonymousPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RuntimeAuthError(503, 'temporary_anonymous_policy_invalid');
  const value = raw as Record<string, unknown>;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const actor = trustedActor === undefined ? value.actor : trustedActor;
  if (!reason || reason.length > 500 || typeof actor !== 'string' || !actor.trim() || actor.length > 200 ||
      typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      (value.allowProduction !== undefined && typeof value.allowProduction !== 'boolean'))
    throw new RuntimeAuthError(503, 'temporary_anonymous_policy_invalid');
  return { reason, actor: actor.trim(), expiresAt: new Date(value.expiresAt).toISOString(), allowProduction: value.allowProduction === true };
}

export function assertTemporaryAnonymousPolicy(raw: unknown, options: {
  now?: number; environment?: string; hostAllowsProduction?: boolean;
} = {}): TemporaryAnonymousPolicy {
  const policy = normalizeTemporaryAnonymousPolicy(raw);
  if (Date.parse(policy.expiresAt) <= (options.now ?? Date.now()))
    throw new RuntimeAuthError(403, 'temporary_anonymous_expired');
  if ((options.environment ?? process.env.NODE_ENV) === 'production' &&
      !(policy.allowProduction && (options.hostAllowsProduction ?? process.env.API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION === 'true')))
    throw new RuntimeAuthError(403, 'temporary_anonymous_production_forbidden');
  return policy;
}

export function readTemporaryAnonymousEnvironment(): unknown | undefined {
  const raw = process.env.API_NOVA_TEMPORARY_ANONYMOUS;
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); }
  catch { throw new RuntimeAuthError(503, 'temporary_anonymous_policy_invalid'); }
}
