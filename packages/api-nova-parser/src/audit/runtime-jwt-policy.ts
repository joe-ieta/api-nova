import { RuntimeAuthError } from './runtime-auth';

export interface RuntimeJwtPolicy {
  algorithms: string[];
  requiredClaims: string[];
  clockToleranceSeconds: number;
}
const allowedAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);
const baselineClaims = ['sub', 'exp', 'iat'];

/** Normalize trusted configuration; never accept a policy from request headers. */
export function normalizeRuntimeJwtPolicy(raw?: unknown): RuntimeJwtPolicy {
  const invalid = (): never => { throw new RuntimeAuthError(503, 'invalid_jwt_policy'); };
  if (raw === undefined) return { algorithms: ['RS256', 'ES256'], requiredClaims: [...baselineClaims], clockToleranceSeconds: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['algorithms', 'requiredClaims', 'clockToleranceSeconds'].includes(key))) return invalid();
  const algorithms = value.algorithms ?? ['RS256', 'ES256'];
  const requiredClaims = value.requiredClaims ?? baselineClaims;
  const clockToleranceSeconds = value.clockToleranceSeconds ?? 0;
  if (value.algorithms === null || value.requiredClaims === null || value.clockToleranceSeconds === null ||
      !Array.isArray(algorithms) || !algorithms.length || algorithms.length > 10 ||
      algorithms.some(algorithm => typeof algorithm !== 'string' || !allowedAlgorithms.has(algorithm)) ||
      !Array.isArray(requiredClaims) || requiredClaims.length > 32 ||
      requiredClaims.some(claim => typeof claim !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(claim)) ||
      baselineClaims.some(claim => !requiredClaims.includes(claim)) ||
      typeof clockToleranceSeconds !== 'number' || !Number.isInteger(clockToleranceSeconds) ||
      clockToleranceSeconds < 0 || clockToleranceSeconds > 300) return invalid();
  return { algorithms: [...new Set(algorithms)], requiredClaims: [...new Set(requiredClaims)], clockToleranceSeconds };
}

export function readRuntimeJwtPolicy(env: NodeJS.ProcessEnv = process.env): RuntimeJwtPolicy {
  if (env.API_NOVA_RUNTIME_JWT_POLICY === undefined) return normalizeRuntimeJwtPolicy();
  let raw: unknown;
  try { raw = JSON.parse(env.API_NOVA_RUNTIME_JWT_POLICY); }
  catch { throw new RuntimeAuthError(503, 'invalid_jwt_policy'); }
  return normalizeRuntimeJwtPolicy(raw);
}
