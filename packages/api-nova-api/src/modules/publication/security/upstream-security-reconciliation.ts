import { createHash } from 'node:crypto';
import type { UpstreamCredentialDescription } from 'api-nova-parser';

export type SecurityState = 'Unsecured' | 'Declared' | 'Configured' | 'Verified';
export type SecurityReason = 'DeclarationInvalid' | 'DeclarationUnresolved' | 'BindingMissing' |
  'BindingIncompatible' | 'BindingAmbiguous' | 'SecretUnavailable' | 'CredentialInactive' |
  'ScopeMismatch' | 'CombinationUnsupported' | 'OAuthUnsupported' |
  'VerificationMissing' | 'VerificationFailed' | 'VerificationStale';
export interface SecurityDeclaration {
  version: 1;
  source: 'operation' | 'global' | 'operation-explicit-empty' | 'global-explicit-empty' | 'absent';
  expression: Array<Record<string, string[]>>;
  schemes: Record<string, Record<string, unknown>>;
  reason?: SecurityReason;
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
export const securityDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Capture only declaration data; unrelated scheme metadata and provider material never enter evidence. */
export function normalizeUpstreamSecurity(root: unknown, operation: unknown): SecurityDeclaration {
  const rootObject = object(root) ? root : {};
  const operationObject = object(operation) ? operation : {};
  const fromOperation = own(operationObject, 'security');
  const fromRoot = own(rootObject, 'security');
  const declaration: SecurityDeclaration = { version: 1, source: fromOperation ? 'operation' : fromRoot ? 'global' : 'absent', expression: [], schemes: {} };
  const invalid = (reason: SecurityReason) => ({ ...declaration, reason });
  if (!fromOperation && !fromRoot) return declaration;
  const raw = fromOperation ? operationObject.security : rootObject.security;
  if (!Array.isArray(raw) || raw.length > 64) return invalid('DeclarationInvalid');
  if (raw.length === 0) { declaration.source = fromOperation ? 'operation-explicit-empty' : 'global-explicit-empty'; return declaration; }
  const components = object(rootObject.components) ? rootObject.components : {};
  const definitions = object(components.securitySchemes) ? components.securitySchemes : {};
  for (const item of raw) {
    if (!object(item) || Object.keys(item).length > 16) return invalid('DeclarationInvalid');
    const branch: Record<string, string[]> = {};
    for (const [name, scopes] of Object.entries(item)) {
      if (!name || name.length > 256 || forbidden.has(name) || !Array.isArray(scopes) || scopes.length > 64 || scopes.some(scope => typeof scope !== 'string' || scope.length > 256)) return invalid('DeclarationInvalid');
      branch[name] = [...scopes];
      const scheme = own(definitions, name) ? definitions[name] : undefined;
      if (!object(scheme) || own(scheme, '$ref')) return invalid('DeclarationUnresolved');
      const type = scheme.type;
      if (typeof type !== 'string') return invalid('DeclarationInvalid');
      declaration.schemes[name] = Object.fromEntries(['type', 'in', 'name', 'scheme', 'bearerFormat'].filter(key => own(scheme, key)).map(key => [key, scheme[key]]));
      if (type === 'apiKey' && (typeof scheme.name !== 'string' || !scheme.name || typeof scheme.in !== 'string')) return invalid('DeclarationInvalid');
      if (type === 'http' && typeof scheme.scheme !== 'string') return invalid('DeclarationInvalid');
      if (!['apiKey', 'http', 'oauth2', 'openIdConnect'].includes(type)) return invalid('DeclarationInvalid');
      if (!['oauth2', 'openIdConnect'].includes(type) && scopes.length) return invalid('DeclarationInvalid');
    }
    declaration.expression.push(branch);
  }
  // Product policy applies to all referenced branches, not only the selected OR arm.
  if (Object.values(declaration.schemes).some(scheme => scheme.type === 'oauth2' || scheme.type === 'openIdConnect')) return invalid('OAuthUnsupported');
  return declaration;
}

/** This input is constructed from the current trusted Resolver, never from endpoint metadata. */
export interface TrustedSecurityBinding {
  mode: 'none' | 'reference' | 'unresolved';
  credential?: UpstreamCredentialDescription;
  credentialId?: string;
  revision: string;
  generation: number;
  providerEpoch: string;
  secretsResolved: boolean;
  reason?: SecurityReason;
}
export interface SecurityContext {
  sourceServiceAssetId: string; endpointDefinitionId: string; target: string;
  method: string; environment: string;
}
export interface TrustedSecurityEvidence {
  contextDigest: string;
  providerEpoch: string;
  result: 'passed' | 'failed';
  verifiedAt: string;
  actorId: string;
  resultId: string;
}
export interface SecurityDecision {
  state: SecurityState; canPublish: boolean; reason?: SecurityReason;
  selectedBranch?: number; contextDigest?: string;
}
export function reconcileUpstreamSecurity(input: {
  declaration: SecurityDeclaration; selectedBranch?: number; context: SecurityContext;
  binding?: TrustedSecurityBinding; evidence?: TrustedSecurityEvidence;
}): SecurityDecision {
  const { declaration, selectedBranch, binding, evidence } = input;
  const blocked = (reason: SecurityReason, state: SecurityState = 'Declared', contextDigest?: string): SecurityDecision => ({ state, canPublish: false, reason, selectedBranch, contextDigest });
  if (declaration.reason) return blocked(declaration.reason);
  const branches = declaration.expression;
  const selection = selectedBranch ?? (branches.length === 1 ? 0 : undefined);
  if (branches.length && (selection === undefined || !Number.isInteger(selection) || selection < 0 || selection >= branches.length)) return blocked('BindingAmbiguous');
  if (!branches.length && selectedBranch !== undefined) return blocked('DeclarationInvalid');
  const names = branches.length ? Object.keys(branches[selection!]) : [];
  if (binding?.reason) return blocked(binding.reason);
  if (names.length > 1) return blocked('CombinationUnsupported');
  if (!names.length && (!binding || binding.mode === 'none' || binding.mode === 'unresolved')) {
    // Legacy absent declarations have no implicit credential requirement. Explicit OR
    // choices are checked above; failures in trusted resolution never land here.
    return { state: 'Unsecured', canPublish: true, selectedBranch: selection };
  }
  if (!binding || binding.mode === 'unresolved') return blocked('BindingMissing');
  if (binding.mode === 'none') return blocked('BindingIncompatible');
  if (!binding.credential || !binding.credentialId) return blocked('BindingMissing');
  const credential = binding.credential;
  if (!binding.secretsResolved) return blocked('SecretUnavailable');
  const now = Date.now();
  if (credential.enabled === false ||
    (credential.notBefore !== undefined && (!Number.isFinite(Date.parse(credential.notBefore)) || Date.parse(credential.notBefore) > now)) ||
    (credential.expiresAt !== undefined && (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= now))) return blocked('CredentialInactive');
  let hostname: string;
  try { hostname = new URL(input.context.target).hostname.toLowerCase(); } catch { return blocked('ScopeMismatch'); }
  if ((credential.environment !== undefined && credential.environment !== input.context.environment) ||
    (credential.methods !== undefined && !credential.methods.includes(input.context.method.toUpperCase())) ||
    (credential.endpointDefinitionIds !== undefined && !credential.endpointDefinitionIds.includes(input.context.endpointDefinitionId)) ||
    (credential.allowedHosts !== undefined && !credential.allowedHosts.some(host => host.toLowerCase() === hostname))) return blocked('ScopeMismatch');
  if (names.length) {
    const scheme = declaration.schemes[names[0]];
    if (!scheme) return blocked('DeclarationUnresolved');
    const compatible = scheme.type === 'apiKey' && scheme.in === 'header'
      ? (credential.type === 'apiKey' && credential.placement.in === 'header' && credential.placement.name.toLowerCase() === String(scheme.name).toLowerCase()) ||
        (credential.type === 'customHeader' && credential.name.toLowerCase() === String(scheme.name).toLowerCase())
      : scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer' ? credential.type === 'bearer'
      : scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'basic' ? credential.type === 'basic' : false;
    if (!compatible) return blocked('BindingIncompatible');
  }
  // providerEpoch is an opaque trusted change marker, never a secret hash.
  if (!binding.providerEpoch) return blocked('VerificationMissing', 'Configured');
  const contextDigest = securityDigest({ context: input.context, declaration, selectedBranch: selection,
    credentialId: binding.credentialId, revision: binding.revision, generation: binding.generation });
  if (!evidence) return blocked('VerificationMissing', 'Configured', contextDigest);
  if (evidence.contextDigest !== contextDigest || evidence.providerEpoch !== binding.providerEpoch) return blocked('VerificationStale', 'Configured', contextDigest);
  if (!evidence.resultId || !evidence.actorId || !Number.isFinite(Date.parse(evidence.verifiedAt))) return blocked('VerificationMissing', 'Configured', contextDigest);
  if (evidence.result !== 'passed') return blocked('VerificationFailed', 'Configured', contextDigest);
  return { state: 'Verified', canPublish: true, selectedBranch: selection, contextDigest };
}
