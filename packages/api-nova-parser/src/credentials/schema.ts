import { normalizeHeaderPolicyV1 } from '../headers/header-policy';
import { isIP } from 'node:net';
import type {
  UpstreamCredentialBindingsCandidate, UpstreamCredentialDescription, UpstreamCredentialSelection,
  UpstreamCredentialSite, UpstreamEndpointCredentialOverride, UpstreamSecretProviderDescription,
  UpstreamCredentialValidationCode,
} from './types';

export const UPSTREAM_CREDENTIAL_LIMITS = Object.freeze({
  maxDepth: 12, maxNodes: 20000, maxTextCharacters: 1048576, maxStringCharacters: 4096,
  maxObjectKeys: 2048, maxArrayItems: 1024, maxProviders: 32, maxCredentials: 256,
  maxSites: 128, maxEndpointsPerSite: 256, maxEndpoints: 2048, maxAllowedHosts: 64,
});

export class UpstreamCredentialValidationError extends Error {
  constructor(readonly code: UpstreamCredentialValidationCode) {
    super(code);
    this.name = 'UpstreamCredentialValidationError';
  }
}

type Dict = Record<string, unknown>;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const forbiddenHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding',
  'upgrade', 'cookie', 'set-cookie', 'authorization', 'www-authenticate', 'forwarded', 'x-real-ip', 'x-request-id', 'expect', 'traceparent', 'tracestate', 'baggage', 'server', 'x-powered-by']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function fail(code: UpstreamCredentialValidationCode): never { throw new UpstreamCredentialValidationError(code); }

/** Snapshot only plain, bounded data. Do not invoke input getters or retain caller-owned objects. */
function snapshot(input: unknown): unknown {
  let nodes = 0, characters = 0;
  const ancestors = new WeakSet<object>();
  const textBudget = (value: string) => {
    characters += value.length;
    if (value.length > UPSTREAM_CREDENTIAL_LIMITS.maxStringCharacters ||
      characters > UPSTREAM_CREDENTIAL_LIMITS.maxTextCharacters) fail('INPUT_LIMIT_EXCEEDED');
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > UPSTREAM_CREDENTIAL_LIMITS.maxNodes || depth > UPSTREAM_CREDENTIAL_LIMITS.maxDepth) fail('INPUT_LIMIT_EXCEEDED');
    if (typeof value === 'string') { textBudget(value); return value; }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value) fail('INVALID_STRUCTURE');
    if (ancestors.has(value)) fail('UNSAFE_OBJECT');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('UNSAFE_OBJECT');
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? UPSTREAM_CREDENTIAL_LIMITS.maxArrayItems + 1 : UPSTREAM_CREDENTIAL_LIMITS.maxObjectKeys)) fail('INPUT_LIMIT_EXCEEDED');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isInteger(length) || length < 0 || length > UPSTREAM_CREDENTIAL_LIMITS.maxArrayItems || keys.length !== length + 1) fail('INVALID_STRUCTURE');
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) fail('UNSAFE_OBJECT');
        result.push(visit(descriptor.value, depth + 1));
      }
      ancestors.delete(value);
      return result;
    }
    const result: Dict = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || dangerous.has(key)) fail('UNSAFE_OBJECT');
      textBudget(key);
      const descriptor = descriptors[key];
      if (!own(descriptor, 'value') || !descriptor.enumerable) fail('UNSAFE_OBJECT');
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, 0);
}

function object(value: unknown): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE');
  return value as Dict;
}
function shape(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Dict {
  const result = object(value);
  if (Object.keys(result).some(key => !allowed.includes(key))) fail('UNKNOWN_FIELD');
  if (required.some(key => !own(result, key))) fail('MISSING_FIELD');
  return result;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u0020\u007f]/.test(value)) fail('INVALID_VALUE');
  return value;
}
function identifier(value: unknown): string {
  const id = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || dangerous.has(id)) fail('INVALID_VALUE');
  return id;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail('INVALID_VALUE');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_STRUCTURE');
  if (value.length > max) fail('INPUT_LIMIT_EXCEEDED');
  return value;
}
function host(value: unknown): string {
  let name = text(value, 253).toLowerCase();
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (isIP(name) === 6) return new URL('http://[' + name + ']/').hostname.slice(1, -1);
  if (isIP(name) === 4) return name;
  if (/^[0-9.]+$/.test(name)) fail('INVALID_HOST');
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (!name || name.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) fail('INVALID_HOST');
  return name;
}
function routePath(value: unknown, base = false): string {
  const path = text(value, 2048);
  // Encoded paths are intentionally outside this first contract slice.
  if (!path.startsWith('/') || /[\\%?#]/.test(path) || path.includes('//') ||
    path.split('/').some(part => part === '.' || part === '..')) fail('INVALID_PATH');
  return base && path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
function header(value: unknown): string {
  const name = text(value, 128).toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || (forbiddenHeaders.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-apinova-'))) fail('INVALID_HEADER');
  return name;
}
function selection(value: unknown, present: boolean, credentials: Record<string, UpstreamCredentialDescription>): UpstreamCredentialSelection {
  if (!present) return { mode: 'inherit' };
  if (value === 'none') return { mode: 'none' };
  const id = identifier(value);
  if (!own(credentials, id)) fail('INVALID_REFERENCE');
  return { mode: 'reference', credentialId: id };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate an already-parsed plain object and return an independent frozen candidate.
 * No YAML/JSON parsing, env/file reads, secret resolution, DNS, asset lookup or activation.
 * Missing credential, reference and literal "none" remain distinct normalized selections.
 * All environments are reference-only. Error messages contain only static codes.
 */
export function validateUpstreamCredentialBindings(input: unknown): UpstreamCredentialBindingsCandidate {
  try { return validate(snapshot(input)); }
  catch (error) {
    if (error instanceof UpstreamCredentialValidationError) throw error;
    // Do not leak messages from hostile objects, URL parsing or native operations.
    throw new UpstreamCredentialValidationError('INVALID_STRUCTURE');
  }
}

function validate(input: unknown): UpstreamCredentialBindingsCandidate {
  const root = shape(input, ['apiVersion', 'kind', 'metadata', 'reload', 'secretProviders', 'credentials', 'sites']);
  if (root.apiVersion !== 'security.apinova.io/v1' || root.kind !== 'UpstreamCredentialBindings') fail('UNSUPPORTED_VERSION');
  const meta = shape(root.metadata, ['revision', 'environment']);
  const revision = identifier(meta.revision), environment = identifier(meta.environment).toLowerCase();
  const reload = shape(root.reload, ['mode', 'debounceMs', 'rejectPlaintextSecrets']);
  if (reload.mode !== 'manual' && reload.mode !== 'watch') fail('INVALID_VALUE');
  if (reload.rejectPlaintextSecrets !== true) fail('PLAINTEXT_NOT_ALLOWED');
  const debounceMs = integer(reload.debounceMs, 0, 60000);
  const providerInput = object(root.secretProviders);
  if (Object.keys(providerInput).length > UPSTREAM_CREDENTIAL_LIMITS.maxProviders) fail('INPUT_LIMIT_EXCEEDED');
  const secretProviders: Record<string, UpstreamSecretProviderDescription> = Object.create(null);
  for (const [id, raw] of Object.entries(providerInput)) {
    identifier(id);
    const entry = object(raw);
    if (entry.type === 'env') { shape(entry, ['type']); secretProviders[id] = { type: 'env' }; }
    else if (entry.type === 'file') {
      shape(entry, ['type', 'root', 'requireOwnerOnly']);
      const fileRoot = text(entry.root, 2048);
      if ((!fileRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(fileRoot)) ||
        fileRoot.startsWith('//') || fileRoot.split(/[\\/]/).some(part => part === '.' || part === '..')) fail('INVALID_PATH');
      if (entry.requireOwnerOnly !== true) fail('INVALID_VALUE');
      secretProviders[id] = { type: 'file', root: fileRoot, requireOwnerOnly: true };
    } else fail('UNSUPPORTED_PROVIDER_TYPE');
  }
  const credentialInput = object(root.credentials);
  if (Object.keys(credentialInput).length > UPSTREAM_CREDENTIAL_LIMITS.maxCredentials) fail('INPUT_LIMIT_EXCEEDED');
  const credentials: Record<string, UpstreamCredentialDescription> = Object.create(null);
  for (const [id, raw] of Object.entries(credentialInput)) {
    identifier(id);
    if (id === 'none') fail('INVALID_VALUE');
    const entry = object(raw);
    if (!['apiKey', 'bearer', 'basic', 'customHeader'].includes(entry.type as string)) fail('UNSUPPORTED_CREDENTIAL_TYPE');
    const typeFields = entry.type === 'apiKey' ? ['type', 'placement', 'secretRef']
      : entry.type === 'basic' ? ['type', 'usernameRef', 'passwordRef']
        : entry.type === 'customHeader' ? ['type', 'name', 'secretRef'] : ['type', 'secretRef'];
    const constraintFields = ['enabled', 'notBefore', 'expiresAt', 'environment', 'allowedHosts', 'endpointDefinitionIds', 'methods'];
    shape(entry, [...typeFields, ...constraintFields], typeFields);
    const reference = (raw: unknown): string => {
      const ref = text(raw, 1024), separator = ref.indexOf(':');
      if (separator < 1 || separator !== ref.lastIndexOf(':')) fail('INVALID_REFERENCE');
      const providerId = ref.slice(0, separator), key = ref.slice(separator + 1);
      if (!own(secretProviders, providerId)) fail('INVALID_REFERENCE');
      if (secretProviders[providerId].type === 'env') {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail('INVALID_REFERENCE');
      } else if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) fail('INVALID_REFERENCE');
      return ref;
    };
    const constraints: Record<string, any> = { enabled: true, environment };
    if (own(entry, 'enabled')) { if (typeof entry.enabled !== 'boolean') fail('INVALID_VALUE'); constraints.enabled = entry.enabled; }
    if (own(entry, 'environment')) {
      constraints.environment = identifier(entry.environment).toLowerCase();
      if (constraints.environment !== environment) fail('INVALID_VALUE');
    }
    for (const field of ['notBefore', 'expiresAt']) if (own(entry, field)) {
      const value = text(entry[field], 64);
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
      if (!match || !Number.isFinite(Date.parse(value))) fail('INVALID_VALUE');
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) fail('INVALID_VALUE');
      constraints[field] = new Date(value).toISOString();
    }
    if (constraints.notBefore && constraints.expiresAt && Date.parse(constraints.notBefore) >= Date.parse(constraints.expiresAt)) fail('INVALID_VALUE');
    for (const field of ['allowedHosts', 'endpointDefinitionIds', 'methods']) if (own(entry, field)) {
      const values = list(entry[field], field === 'allowedHosts' ? UPSTREAM_CREDENTIAL_LIMITS.maxAllowedHosts : 256).map(value => {
        if (field === 'allowedHosts') return host(value);
        if (field === 'endpointDefinitionIds') return identifier(value);
        const method = text(value, 16).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)) fail('INVALID_VALUE');
        return method;
      });
      if (!values.length || new Set(values).size !== values.length) fail('INVALID_VALUE');
      constraints[field] = values;
    }
    if (entry.type === 'apiKey') {
      const placement = shape(entry.placement, ['in', 'name']);
      if (placement.in !== 'header') fail('UNSUPPORTED_CREDENTIAL_TYPE');
      credentials[id] = { ...constraints, type: 'apiKey', placement: { in: 'header', name: header(placement.name) }, secretRef: reference(entry.secretRef) };
    } else if (entry.type === 'basic') {
      credentials[id] = { ...constraints, type: 'basic', usernameRef: reference(entry.usernameRef), passwordRef: reference(entry.passwordRef) };
    } else if (entry.type === 'customHeader') {
      credentials[id] = { ...constraints, type: 'customHeader', name: header(entry.name), secretRef: reference(entry.secretRef) };
    } else credentials[id] = { ...constraints, type: 'bearer', secretRef: reference(entry.secretRef) };
  }

  const sites: UpstreamCredentialSite[] = [];
  const siteIds = new Set<string>(), siteSelectors = new Set<string>();
  let endpointCount = 0;
  for (const raw of list(root.sites, UPSTREAM_CREDENTIAL_LIMITS.maxSites)) {
    const site = shape(raw, ['id', 'sourceServiceAssetId', 'match', 'credential', 'allowedHosts', 'endpoints', 'headerPolicy'],
      ['id', 'sourceServiceAssetId', 'match', 'allowedHosts']);
    const id = identifier(site.id), sourceServiceAssetId = identifier(site.sourceServiceAssetId);
    const match = shape(site.match, ['scheme', 'host', 'port', 'basePath']);
    if (match.scheme !== 'http' && match.scheme !== 'https') fail('INVALID_VALUE');
    const normalizedMatch: UpstreamCredentialSite['match'] = { scheme: match.scheme, host: host(match.host), port: integer(match.port, 1, 65535), basePath: routePath(match.basePath, true) };
    const selector = JSON.stringify([sourceServiceAssetId, normalizedMatch]);
    if (siteIds.has(id) || siteSelectors.has(selector)) fail('DUPLICATE_SELECTOR');
    siteIds.add(id); siteSelectors.add(selector);
    const allowedHosts = list(site.allowedHosts, UPSTREAM_CREDENTIAL_LIMITS.maxAllowedHosts).map(host);
    if (new Set(allowedHosts).size !== allowedHosts.length) fail('DUPLICATE_SELECTOR');
    if (!allowedHosts.includes(normalizedMatch.host)) fail('INVALID_HOST');
    const endpoints: UpstreamEndpointCredentialOverride[] = [];
    const selectors = new Set<string>();
    for (const endpointRaw of own(site, 'endpoints') ? list(site.endpoints, UPSTREAM_CREDENTIAL_LIMITS.maxEndpointsPerSite) : []) {
      if (++endpointCount > UPSTREAM_CREDENTIAL_LIMITS.maxEndpoints) fail('INPUT_LIMIT_EXCEEDED');
      const endpoint = shape(endpointRaw, ['endpointDefinitionId', 'method', 'path', 'credential', 'headerPolicy'], []);
      const policy = own(endpoint, 'headerPolicy') ? { headerPolicy: normalizeHeaderPolicyV1(endpoint.headerPolicy) } : {};
      const credential = selection(endpoint.credential, own(endpoint, 'credential'), credentials);
      let endpointSelector: string;
      if (own(endpoint, 'endpointDefinitionId')) {
        if (own(endpoint, 'method') || own(endpoint, 'path')) fail('INVALID_VALUE');
        const endpointDefinitionId = identifier(endpoint.endpointDefinitionId);
        endpointSelector = JSON.stringify(['id', endpointDefinitionId]);
        endpoints.push({ endpointDefinitionId, credential, ...policy });
      } else {
        if (!own(endpoint, 'method') || !own(endpoint, 'path')) fail('MISSING_FIELD');
        const method = text(endpoint.method, 16).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)) fail('INVALID_VALUE');
        const path = routePath(endpoint.path);
        endpointSelector = JSON.stringify(['route', method, path]);
        endpoints.push({ method, path, credential, ...policy });
      }
      if (selectors.has(endpointSelector)) fail('DUPLICATE_SELECTOR');
      selectors.add(endpointSelector);
    }
    sites.push({ id, sourceServiceAssetId, match: normalizedMatch,
      ...(own(site, 'headerPolicy') ? { headerPolicy: normalizeHeaderPolicyV1(site.headerPolicy) } : {}),
      credential: selection(site.credential, own(site, 'credential'), credentials), allowedHosts, endpoints });
  }
  return freeze({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision, environment },
    reload: { mode: reload.mode, debounceMs, rejectPlaintextSecrets: true }, secretProviders, credentials, sites });
}
