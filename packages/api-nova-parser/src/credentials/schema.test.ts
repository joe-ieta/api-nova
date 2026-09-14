import { validateUpstreamCredentialBindings as validate, UpstreamCredentialValidationError,
  UPSTREAM_CREDENTIAL_LIMITS as limits } from './schema';

function input(): any {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'orders-prod-1', environment: 'production' },
    reload: { mode: 'watch', debounceMs: 1000, rejectPlaintextSecrets: true },
    secretProviders: { processEnv: { type: 'env' }, local: { type: 'file', root: '/etc/apinova/secrets', requireOwnerOnly: true } },
    credentials: { service: { type: 'apiKey', placement: { in: 'header', name: 'X-API-Key' }, secretRef: 'processEnv:ORDERS_KEY' },
      admin: { type: 'bearer', secretRef: 'local:orders/admin-token' } },
    sites: [{ id: 'orders', sourceServiceAssetId: 'asset-orders',
      match: { scheme: 'https', host: 'ORDERS.EXAMPLE.', port: 443, basePath: '/api/' },
      credential: 'service', allowedHosts: ['orders.example'], endpoints: [
        { endpointDefinitionId: 'endpoint-admin', credential: 'admin' },
        { method: 'get', path: '/health', credential: 'none' },
        { endpointDefinitionId: 'endpoint-inherit' },
      ] }],
  };
}
function rejected(value: unknown, code?: string): void {
  let caught: unknown;
  try { validate(value); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(UpstreamCredentialValidationError);
  const error = caught as UpstreamCredentialValidationError;
  expect(error.message).toBe(error.code);
  expect(error.message).toMatch(/^[A-Z_]+$/);
  if (code) expect(error.code).toBe(code);
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(frozen);
  }
}

describe('TP-C1 pure upstream credential candidate', () => {
  it('normalizes the approved reference-only structure without modifying input', () => {
    const raw = input(), before = JSON.stringify(raw), result = validate(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(result).toMatchObject({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
      metadata: { revision: 'orders-prod-1', environment: 'production' } });
    expect(result.sites[0].match).toEqual({ scheme: 'https', host: 'orders.example', port: 443, basePath: '/api' });
    expect(result.credentials.service).toMatchObject({ placement: { in: 'header', name: 'x-api-key' } });
    expect(result.credentials.admin).toEqual({ type: 'bearer', secretRef: 'local:orders/admin-token' });
    frozen(result);
  });
  it('returns a fully independent candidate and works on frozen input', () => {
    const raw = input(), result = validate(raw);
    raw.secretProviders.local.root = '/changed'; raw.sites[0].allowedHosts.push('other.example');
    raw.sites[0].endpoints[0].credential = 'none'; raw.credentials.admin.secretRef = 'local:changed';
    expect(result.secretProviders.local).toMatchObject({ root: '/etc/apinova/secrets' });
    expect(result.sites[0].allowedHosts).toEqual(['orders.example']);
    expect(result.sites[0].endpoints[0].credential).toEqual({ mode: 'reference', credentialId: 'admin' });
    const lock = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(lock); Object.freeze(v); } return v; };
    expect(validate(lock(input()))).toEqual(result);
  });
  it('preserves inherit, explicit none and reference as different decisions', () => {
    const raw = input(); delete raw.sites[0].credential;
    const result = validate(raw);
    expect(result.sites[0].credential).toEqual({ mode: 'inherit' });
    expect(result.sites[0].endpoints.map(e => e.credential)).toEqual([
      { mode: 'reference', credentialId: 'admin' }, { mode: 'none' }, { mode: 'inherit' },
    ]);
    raw.sites[0].credential = 'none'; expect(validate(raw).sites[0].credential).toEqual({ mode: 'none' });
  });
  it('accepts empty registries as structural intent without asserting resolution', () => {
    const raw = input(); raw.secretProviders = {}; raw.credentials = {}; raw.sites = [];
    expect(validate(raw).sites).toEqual([]);
  });
  it('accepts null-prototype data and does not consult provider availability', () => {
    const raw = Object.assign(Object.create(null), input());
    raw.credentials.service.secretRef = 'processEnv:NOT_READ_BY_THIS_VALIDATOR';
    expect(validate(raw).credentials.service.secretRef).toBe('processEnv:NOT_READ_BY_THIS_VALIDATOR');
  });
  it.each([null, undefined, 1, true, [], 'apiVersion: security.apinova.io/v1', '{"apiVersion":"security.apinova.io/v1"}'])
    ('rejects non-object and unparsed text input %#', value => rejected(value));

  const invalid: Array<[string, (raw: any) => void]> = [
    ['version', r => { r.apiVersion = 'security.apinova.io/v2'; }],
    ['kind', r => { r.kind = 'Other'; }],
    ['missing top field', r => { delete r.reload; }],
    ['unknown top field', r => { r.extra = true; }],
    ['metadata unknown', r => { r.metadata.extra = true; }],
    ['numeric revision', r => { r.metadata.revision = 1; }],
    ['blank environment', r => { r.metadata.environment = ''; }],
    ['reload unknown', r => { r.reload.extra = true; }],
    ['reload invalid mode', r => { r.reload.mode = 'automatic'; }],
    ['reload string debounce', r => { r.reload.debounceMs = '1000'; }],
    ['reload fractional debounce', r => { r.reload.debounceMs = 1.5; }],
    ['reload excessive debounce', r => { r.reload.debounceMs = 60001; }],
    ['provider unknown', r => { r.secretProviders.processEnv.extra = true; }],
    ['file missing owner policy', r => { delete r.secretProviders.local.requireOwnerOnly; }],
    ['file false owner policy', r => { r.secretProviders.local.requireOwnerOnly = false; }],
    ['file relative root', r => { r.secretProviders.local.root = 'secrets'; }],
    ['file traversal root', r => { r.secretProviders.local.root = '/secrets/../private'; }],
    ['credential unknown', r => { r.credentials.service.extra = true; }],
    ['placement unknown', r => { r.credentials.service.placement.extra = true; }],
    ['site unknown', r => { r.sites[0].extra = true; }],
    ['match unknown', r => { r.sites[0].match.extra = true; }],
    ['string port', r => { r.sites[0].match.port = '443'; }],
    ['port zero', r => { r.sites[0].match.port = 0; }],
    ['port overflow', r => { r.sites[0].match.port = 65536; }],
    ['unsupported scheme', r => { r.sites[0].match.scheme = 'ftp'; }],
    ['missing host allowlist membership', r => { r.sites[0].allowedHosts = ['elsewhere.example']; }],
    ['wildcard host', r => { r.sites[0].match.host = '*.example'; }],
    ['url instead of host', r => { r.sites[0].match.host = 'https://orders.example'; }],
    ['path traversal', r => { r.sites[0].match.basePath = '/a/../b'; }],
    ['encoded path', r => { r.sites[0].match.basePath = '/%2e%2e'; }],
    ['query in path', r => { r.sites[0].endpoints[1].path = '/health?token=secret'; }],
    ['endpoint unknown', r => { r.sites[0].endpoints[0].extra = true; }],
    ['ambiguous endpoint selector', r => { Object.assign(r.sites[0].endpoints[0], { method: 'GET', path: '/admin' }); }],
    ['incomplete method/path selector', r => { delete r.sites[0].endpoints[1].path; }],
    ['missing endpoint selector', r => { r.sites[0].endpoints[0] = {}; }],
    ['invalid method', r => { r.sites[0].endpoints[1].method = 'CONNECT'; }],
    ['null selection', r => { r.sites[0].credential = null; }],
    ['object selection', r => { r.sites[0].credential = { mode: 'none' }; }],
    ['undefined selection', r => { r.sites[0].credential = undefined; }],
    ['array credential registry', r => { r.credentials = []; }],
  ];
  it.each(invalid)('strictly rejects %s', (_name, mutate) => { const raw = input(); mutate(raw); rejected(raw); });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous own key %s', key => {
    const raw = input(); Object.defineProperty(raw.credentials, key, { value: {}, enumerable: true }); rejected(raw, 'UNSAFE_OBJECT');
  });
  it('rejects accessors without executing getters', () => {
    const raw = input(); let calls = 0;
    Object.defineProperty(raw.metadata, 'revision', { enumerable: true, get() { calls++; throw Error('private-marker'); } });
    rejected(raw, 'UNSAFE_OBJECT'); expect(calls).toBe(0);
  });
  it('rejects cycles without recursing forever', () => { const raw = input(); raw.loop = raw; rejected(raw, 'UNSAFE_OBJECT'); });
  it('rejects custom prototypes, symbols and sparse arrays', () => {
    const custom = input(); Object.setPrototypeOf(custom.metadata, { private: true }); rejected(custom, 'UNSAFE_OBJECT');
    const symbol = input(); symbol[Symbol('private')] = true; rejected(symbol, 'UNSAFE_OBJECT');
    const sparse = input(); sparse.sites = new Array(2); rejected(sparse);
  });
  it.each(['missing:KEY', 'processEnv:', 'processEnv:lowercase', 'processEnv:A:B', 'local:../secret',
    'local:/absolute', 'local:dir\\secret', 'local:dir/../secret', 'local:dir\r\nsecret'])
    ('rejects invalid or dangling secret reference %#', value => { const raw = input(); raw.credentials.admin.secretRef = value; rejected(raw); });
  it('rejects dangling credential references and reserved none credential IDs', () => {
    const site = input(); site.sites[0].credential = 'missing'; rejected(site, 'INVALID_REFERENCE');
    const endpoint = input(); endpoint.sites[0].endpoints[0].credential = 'missing'; rejected(endpoint, 'INVALID_REFERENCE');
    const reserved = input(); reserved.credentials.none = reserved.credentials.admin; rejected(reserved);
  });
  it('rejects duplicate site IDs and normalized site selectors', () => {
    const ids = input(); ids.sites.push({ ...ids.sites[0], match: { ...ids.sites[0].match, basePath: '/other' } }); rejected(ids, 'DUPLICATE_SELECTOR');
    const selectors = input(); selectors.sites.push({ ...selectors.sites[0], id: 'other', match: { ...selectors.sites[0].match, host: 'orders.example', basePath: '/api' } }); rejected(selectors, 'DUPLICATE_SELECTOR');
  });
  it('rejects duplicate endpoint ID and normalized method/path selectors', () => {
    for (const endpoint of [{ endpointDefinitionId: 'endpoint-admin', credential: 'none' }, { method: 'GET', path: '/health' }]) {
      const raw = input(); raw.sites[0].endpoints.push(endpoint); rejected(raw, 'DUPLICATE_SELECTOR');
    }
  });
  it('rejects duplicate normalized allowed hosts', () => { const raw = input(); raw.sites[0].allowedHosts.push('ORDERS.EXAMPLE.'); rejected(raw, 'DUPLICATE_SELECTOR'); });
  it.each(['X-API-Key', 'Authorization', 'X!Vendor', 'x_vendor.token'])('accepts safe header %s', name => {
    const raw = input(); raw.credentials.service.placement.name = name;
    expect(validate(raw).credentials.service).toMatchObject({ placement: { name: name.toLowerCase() } });
  });
  it.each(['', 'Host', 'Content-Length', 'Connection', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'Transfer-Encoding',
    'bad header', 'X-Test\r\nInjected', 'X-Test:evil'])('rejects forbidden or malformed header %#', name => {
      const raw = input(); raw.credentials.service.placement.name = name; rejected(raw);
    });
  it.each(['production', 'development', 'test'])('is reference-only in %s', environment => {
    const raw = input(); raw.metadata.environment = environment; raw.reload.rejectPlaintextSecrets = false;
    rejected(raw, 'PLAINTEXT_NOT_ALLOWED');
    for (const field of ['secret', 'value', 'token', 'password']) {
      const inline = input(); inline.metadata.environment = environment; inline.credentials.admin[field] = 'private-marker'; rejected(inline, 'UNKNOWN_FIELD');
    }
  });
  it.each(['basic', 'customHeader', 'query', 'oauth2', 'inline'])('rejects unsupported credential type %s', type => {
    const raw = input(); raw.credentials.admin.type = type; rejected(raw, 'UNSUPPORTED_CREDENTIAL_TYPE');
  });
  it('rejects query API keys and external secret providers', () => {
    const query = input(); query.credentials.service.placement.in = 'query'; rejected(query, 'UNSUPPORTED_CREDENTIAL_TYPE');
    const external = input(); external.secretProviders.local.type = 'vault'; rejected(external, 'UNSUPPORTED_PROVIDER_TYPE');
  });
  it('never includes input values, secrets or file fragments in rejection messages', () => {
    const raw = input(); raw.secretProviders.local.root = 'private-marker/secret-location';
    rejected(raw);
    try { validate(raw); } catch (error) { expect(String(error)).not.toMatch(/private-marker|secret-location/); }
  });
  it('bounds input string length, aggregate text, node count, depth and object keys', () => {
    rejected({ value: 'x'.repeat(limits.maxStringCharacters + 1) }, 'INPUT_LIMIT_EXCEEDED');
    rejected(Array.from({ length: 300 }, () => 'x'.repeat(4096)), 'INPUT_LIMIT_EXCEEDED');
    rejected(Array.from({ length: 1024 }, () => Array(20).fill(null)), 'INPUT_LIMIT_EXCEEDED');
    let deep: any = {}; for (let i = 0; i < limits.maxDepth + 2; i++) deep = { child: deep };
    rejected(deep, 'INPUT_LIMIT_EXCEEDED');
    rejected(Object.fromEntries(Array.from({ length: limits.maxObjectKeys + 1 }, (_, i) => ['k' + i, null])), 'INPUT_LIMIT_EXCEEDED');
  });
  it('bounds every configuration collection', () => {
    const providers = input(); providers.secretProviders = Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['p' + i, { type: 'env' }])); rejected(providers, 'INPUT_LIMIT_EXCEEDED');
    const creds = input(); creds.credentials = Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['c' + i, { type: 'bearer', secretRef: 'processEnv:KEY' }])); rejected(creds, 'INPUT_LIMIT_EXCEEDED');
    const sites = input(); sites.sites = Array(129).fill(sites.sites[0]); rejected(sites, 'INPUT_LIMIT_EXCEEDED');
    const endpoints = input(); endpoints.sites[0].endpoints = Array.from({ length: 257 }, (_, i) => ({ endpointDefinitionId: 'e' + i })); rejected(endpoints, 'INPUT_LIMIT_EXCEEDED');
    const hosts = input(); hosts.sites[0].allowedHosts = Array.from({ length: 65 }, (_, i) => 'host' + i + '.example'); rejected(hosts, 'INPUT_LIMIT_EXCEEDED');
  });
  it('bounds aggregate endpoint count across distinct sites', () => {
    const raw = input(); const base = raw.sites[0];
    raw.sites = Array.from({ length: 9 }, (_, i) => ({ ...base, id: 'site' + i, sourceServiceAssetId: 'asset' + i,
      endpoints: Array.from({ length: 256 }, (_, n) => ({ endpointDefinitionId: 'endpoint' + n })) }));
    rejected(raw, 'INPUT_LIMIT_EXCEEDED');
  });
});
