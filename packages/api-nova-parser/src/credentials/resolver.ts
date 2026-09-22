import { basicCredentialHeader, checkedSingleCredentialSecret } from './secret-material';
import type { UpstreamCredentialRegistrySnapshot } from './registry';
import type { UpstreamCredentialDescription, UpstreamCredentialSelection, UpstreamCredentialSite } from './types';

type ResolvedCredentialSelection = Exclude<UpstreamCredentialSelection, { readonly mode: 'inherit' }>;

export type UpstreamCredentialResolverErrorCode =
  | 'INVALID_RESOLUTION_INPUT' | 'INVALID_TARGET_URL' | 'SITE_NOT_FOUND'
  | 'ENDPOINT_SELECTOR_AMBIGUOUS' | 'CREDENTIAL_POLICY_UNRESOLVED'
  | 'CREDENTIAL_NOT_FOUND' | 'SECRET_RESOLUTION_FAILED' | 'CREDENTIAL_INACTIVE' | 'SCOPE_MISMATCH' | 'UNSUPPORTED_CREDENTIAL_TYPE';

export class UpstreamCredentialResolverError extends Error {
  constructor(public readonly code: UpstreamCredentialResolverErrorCode) {
    super('Upstream credential resolver rejected the request: ' + code);
    this.name = 'UpstreamCredentialResolverError';
  }
}

export interface UpstreamCredentialResolveInput {
  readonly sourceServiceAssetId: string;
  readonly url: string;
  readonly endpointDefinitionId?: string;
  readonly method?: string;
  readonly endpointPath?: string;
  /** Actual outbound method, independent of fallback Endpoint selector. */
  readonly requestMethod?: string;
}

export interface UpstreamCredentialResolution {
  readonly generation: number;
  readonly revision: string;
  readonly siteId: string;
  readonly mode: 'none' | 'reference';
  readonly credentialId?: string;
  readonly headers: Readonly<Record<string, string>>;
}

function reject(code: UpstreamCredentialResolverErrorCode): never {
  throw new UpstreamCredentialResolverError(code);
}

function readInput(input: UpstreamCredentialResolveInput): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('INVALID_RESOLUTION_INPUT');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return reject('INVALID_RESOLUTION_INPUT');
  const allowed = new Set(['sourceServiceAssetId', 'url', 'endpointDefinitionId', 'method', 'endpointPath', 'requestMethod']);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) return reject('INVALID_RESOLUTION_INPUT');
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !('value' in property)) return reject('INVALID_RESOLUTION_INPUT');
    result[key] = property.value;
  }
  return result;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    return reject('INVALID_RESOLUTION_INPUT');
  }
  return value;
}

function safePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 ||
      value.includes('?') || value.includes('#') || value.includes('\\') ||
      /%(?:2e|2f|5c)/iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    return reject('INVALID_RESOLUTION_INPUT');
  }
  return value;
}

interface Target {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

function target(value: unknown): Target {
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(value) || /%(?:2e|2f|5c)/iu.test(value)) {
    return reject('INVALID_TARGET_URL');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { return reject('INVALID_TARGET_URL'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username ||
      parsed.password || parsed.hash || !parsed.hostname || parsed.hostname.endsWith('.') ||
      parsed.pathname.includes('\\')) return reject('INVALID_TARGET_URL');
  const scheme = parsed.protocol.slice(0, -1) as 'http' | 'https';
  const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return reject('INVALID_TARGET_URL');
  return { scheme, host: parsed.hostname.toLowerCase(), port, path: parsed.pathname || '/' };
}

function within(base: string, path: string): boolean {
  return base === '/' || path === base || path.startsWith(base + '/');
}

function siteFor(
  snapshot: UpstreamCredentialRegistrySnapshot,
  asset: string,
  requestTarget: Target,
): UpstreamCredentialSite {
  const matches = snapshot.candidate.sites.filter(site =>
    site.sourceServiceAssetId === asset &&
    site.match.scheme === requestTarget.scheme &&
    site.match.host === requestTarget.host &&
    site.match.port === requestTarget.port &&
    site.allowedHosts.includes(requestTarget.host) &&
    within(site.match.basePath, requestTarget.path));
  if (matches.length === 0) return reject('SITE_NOT_FOUND');
  matches.sort((left, right) => right.match.basePath.length - left.match.basePath.length);
  return matches[0];
}

function selectionFor(site: UpstreamCredentialSite, input: Record<string, unknown>): ResolvedCredentialSelection {
  const hasId = input.endpointDefinitionId !== undefined;
  const hasMethod = input.method !== undefined;
  const hasPath = input.endpointPath !== undefined;
  if ((hasId && (hasMethod || hasPath)) || hasMethod !== hasPath) {
    return reject('ENDPOINT_SELECTOR_AMBIGUOUS');
  }

  let selected: UpstreamCredentialSelection | undefined;
  if (hasId) {
    const id = identifier(input.endpointDefinitionId);
    selected = site.endpoints.find(
      endpoint => 'endpointDefinitionId' in endpoint && endpoint.endpointDefinitionId === id,
    )?.credential;
  } else if (hasMethod && hasPath) {
    if (typeof input.method !== 'string') return reject('INVALID_RESOLUTION_INPUT');
    const method = input.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)) {
      return reject('INVALID_RESOLUTION_INPUT');
    }
    const path = safePath(input.endpointPath);
    selected = site.endpoints.find(
      endpoint => 'method' in endpoint && endpoint.method === method && endpoint.path === path,
    )?.credential;
  }

  if (!selected || selected.mode === 'inherit') selected = site.credential;
  if (selected.mode === 'inherit') return reject('CREDENTIAL_POLICY_UNRESOLVED');
  return selected;
}

/** Pure resolution only: no network, DNS, mutation, secret caching or redirect authorization. */
export async function resolveUpstreamCredential(
  snapshot: UpstreamCredentialRegistrySnapshot,
  request: UpstreamCredentialResolveInput,
): Promise<UpstreamCredentialResolution> {
  const input = readInput(request);
  const requestTarget = target(input.url);
  const site = siteFor(snapshot, identifier(input.sourceServiceAssetId), requestTarget);
  const selection = selectionFor(site, input);
  const metadata = {
    generation: snapshot.generation,
    revision: snapshot.candidate.metadata.revision,
    siteId: site.id,
  };
  if (selection.mode === 'none') {
    return Object.freeze({ ...metadata, mode: 'none' as const, headers: Object.freeze({}) });
  }

  const credential = snapshot.candidate.credentials[selection.credentialId];
  if (!credential) return reject('CREDENTIAL_NOT_FOUND');
  const checkConstraints = () => {
    const now = Date.now();
    if (credential.enabled === false || (credential.notBefore && now < Date.parse(credential.notBefore)) ||
        (credential.expiresAt && now >= Date.parse(credential.expiresAt))) return reject('CREDENTIAL_INACTIVE');
    if ((credential.environment && credential.environment !== snapshot.candidate.metadata.environment) ||
        (credential.allowedHosts && !credential.allowedHosts.includes(requestTarget.host.replace(/^\[|\]$/g, ''))) ||
        (credential.endpointDefinitionIds && (!input.endpointDefinitionId || !credential.endpointDefinitionIds.includes(String(input.endpointDefinitionId)))) ||
        (credential.methods && (typeof input.requestMethod !== 'string' || !credential.methods.includes(input.requestMethod.toUpperCase())))) return reject('SCOPE_MISMATCH');
  };
  if (input.requestMethod !== undefined && (typeof input.requestMethod !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(input.requestMethod.toUpperCase()))) return reject('INVALID_RESOLUTION_INPUT');
  checkConstraints();
  const headers: Record<string, string> = Object.create(null);
  if (!['basic', 'bearer', 'apiKey', 'customHeader'].includes(credential.type)) return reject('UNSUPPORTED_CREDENTIAL_TYPE');
  try {
    if (credential.type === 'basic') {
      if (!snapshot.resolveBasicSecret) return reject('SECRET_RESOLUTION_FAILED');
      const pair = await snapshot.resolveBasicSecret(selection.credentialId);
      headers.authorization = basicCredentialHeader(pair.username, pair.password);
    } else {
      const secret = checkedSingleCredentialSecret(await snapshot.resolveSecret(selection.credentialId), credential.type);
      switch (credential.type) {
        case 'bearer':
          headers.authorization = 'Bearer ' + secret; break;
        case 'apiKey': headers[credential.placement.name] = secret; break;
        case 'customHeader': headers[credential.name] = secret; break;
      }
    }
  } catch { return reject('SECRET_RESOLUTION_FAILED'); }
  checkConstraints();
  return Object.freeze({
    ...metadata,
    mode: 'reference' as const,
    credentialId: selection.credentialId,
    headers: Object.freeze(headers),
  });
}
