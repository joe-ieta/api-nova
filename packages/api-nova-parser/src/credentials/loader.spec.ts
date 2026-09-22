import { parseUpstreamCredentialBindings, UPSTREAM_CREDENTIAL_TEXT_LIMITS,
  UpstreamCredentialTextError } from './loader';
import { UpstreamCredentialValidationError } from './schema';

type Format = 'json' | 'yaml';
const marker = 'SENSITIVE_LOADER_INPUT_4f3b';
const candidate = () => ({
  apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
  metadata: { revision: 'r1', environment: 'production' },
  reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
  secretProviders: { environment: { type: 'env' } },
  credentials: { token: { type: 'bearer', secretRef: 'environment:TEST_TOKEN' } },
  sites: [{ id: 'site', sourceServiceAssetId: 'asset',
    match: { scheme: 'https', host: 'api.example.invalid', port: 443, basePath: '/' },
    allowedHosts: ['api.example.invalid'], endpoints: [
      { method: 'get', path: '/inherit' },
      { method: 'get', path: '/none', credential: 'none' },
      { method: 'post', path: '/ref', credential: 'token' },
    ] }],
});
const yaml = `apiVersion: security.apinova.io/v1
kind: UpstreamCredentialBindings
metadata:
  revision: r1
  environment: production
reload:
  mode: manual
  debounceMs: 0
  rejectPlaintextSecrets: true
secretProviders:
  environment:
    type: env
credentials:
  token:
    type: bearer
    secretRef: environment:TEST_TOKEN
sites:
  - id: site
    sourceServiceAssetId: asset
    match:
      scheme: https
      host: api.example.invalid
      port: 443
      basePath: /
    allowedHosts: [api.example.invalid]
    endpoints:
      - method: get
        path: /inherit
      - method: get
        path: /none
        credential: none
      - method: post
        path: /ref
        credential: token
`;
function rejected(text: string, format: Format, code?: string): Error {
  let caught: unknown;
  try { parseUpstreamCredentialBindings(text, format); } catch (error) { caught = error; }
  expect(caught instanceof UpstreamCredentialTextError || caught instanceof UpstreamCredentialValidationError).toBe(true);
  const error = caught as Error & { code: string };
  expect(error.message).toBe(error.code);
  if (code) expect(error.code).toBe(code);
  expect(error.message).not.toContain(marker);
  expect(error.stack).not.toContain(marker);
  expect(JSON.stringify(error)).not.toContain(marker);
  for (const property of ['cause', 'mark', 'snippet', 'reason', 'input']) {
    expect(Object.prototype.hasOwnProperty.call(error, property)).toBe(false);
  }
  return error;
}
function deeplyFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(deeplyFrozen);
  }
}

describe('credential text loader security contract', () => {
  test.each<Format>(['json', 'yaml'])('%s produces independent deeply frozen normalized candidates', format => {
    const text = format === 'json' ? JSON.stringify(candidate()) : yaml;
    const first = parseUpstreamCredentialBindings(text, format);
    const second = parseUpstreamCredentialBindings(text, format);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.sites[0]).not.toBe(second.sites[0]);
    deeplyFrozen(first);
    expect(first.sites[0].credential).toEqual({ mode: 'inherit' });
    expect(first.sites[0].endpoints.map(endpoint => endpoint.credential)).toEqual([
      { mode: 'inherit' }, { mode: 'none' }, { mode: 'reference', credentialId: 'token' },
    ]);
    expect(() => Object.assign(first.metadata, { revision: 'changed' })).toThrow();
  });
  test('block YAML and JSON normalize to the same candidate', () => {
    expect(parseUpstreamCredentialBindings(yaml, 'yaml')).toEqual(
      parseUpstreamCredentialBindings(JSON.stringify(candidate()), 'json'));
  });
  test.each([
    ['json', '{"metadata":{},"metadata":{}}'],
    ['json', '{"nested":{"key":1,"key":2}}'],
    ['json', '{"key":1,"\\u006bey":2}'],
    ['yaml', 'metadata: {}\nmetadata: {}'],
    ['yaml', 'nested:\n  key: 1\n  key: 2'],
    ['yaml', '{key: 1, key: 2}'],
  ] as [Format, string][])('%s rejects duplicate keys: %s', (format, text) => {
    rejected(text, format, 'INVALID_TEXT_SYNTAX');
  });
  test.each(['{}\n---\n{}', '---\n{}\n...\n---\n{}', '---\n{}\n---\n'])('rejects YAML multi-document input %s', text => {
    rejected(text, 'yaml', 'INVALID_TEXT_SYNTAX');
  });
  test.each([
    'key: !custom value', 'key: !!str value', 'key: &anchor value',
    'key: *missing', 'key: &self [*self]',
    'base: &base {key: value}\ncopy: {<<: *base}',
    '%YAML 1.2\n---\n{}', '%TAG !e! tag:example.invalid,2026:\n---\n{}',
  ])('rejects tag/anchor/alias/directive before construction: %s', text => {
    rejected(text, 'yaml', 'UNSUPPORTED_YAML_SYNTAX');
  });
  test('rejects merge key without aliases', () => {
    rejected('copy: {<<: {key: value}}', 'yaml', 'UNSAFE_OBJECT');
  });
  test.each<Format>(['json', 'yaml'])('%s rejects dangerous keys at every tested nesting level', format => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      for (const text of [`{"${key}":{}}`, `{"nested":{"${key}":{}}}`]) {
        rejected(text, format, 'UNSAFE_OBJECT');
      }
    }
    expect(Object.prototype).not.toHaveProperty(marker);
  });
  test('accepts exactly the UTF-8 byte budget including JSON whitespace', () => {
    const text = JSON.stringify(candidate());
    const padded = text + ' '.repeat(UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxUtf8Bytes - Buffer.byteLength(text));
    expect(Buffer.byteLength(padded)).toBe(1048576);
    expect(parseUpstreamCredentialBindings(padded, 'json').metadata.revision).toBe('r1');
  });
  test.each<Format>(['json', 'yaml'])('%s rejects input one byte over the budget', format => {
    rejected(' '.repeat(1048577), format, 'INPUT_LIMIT_EXCEEDED');
  });
  test.each<Format>(['json', 'yaml'])('%s budgets UTF-8 bytes rather than UTF-16 length', format => {
    const text = '"' + '\u00e9'.repeat(524288) + '"';
    expect(text.length).toBeLessThan(1048576);
    rejected(text, format, 'INPUT_LIMIT_EXCEEDED');
  });
  test.each(['\ud800', '\udfff', '\ud800x', '\ud800\ud800'])('rejects unpaired UTF-16 %j', value => {
    for (const format of ['json', 'yaml'] as const) {
      rejected('"' + value + '"', format, 'INVALID_TEXT_INPUT');
    }
  });
  test.each<Format>(['json', 'yaml'])('%s rejects excessive parse nesting', format => {
    rejected('['.repeat(100) + '0' + ']'.repeat(100), format, 'INPUT_LIMIT_EXCEEDED');
  });
  test.each<Format>(['json', 'yaml'])('%s rejects excessive parse node count within byte budget', format => {
    const text = '[' + Array(UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxParseNodes + 1).fill('0').join(',') + ']';
    expect(Buffer.byteLength(text)).toBeLessThan(1048576);
    rejected(text, format, 'INPUT_LIMIT_EXCEEDED');
  });
  test.each(['!', '&', '*'])('conservative YAML rejects literal %s while JSON accepts it', character => {
    const input = candidate();
    input.sites[0].match.basePath = '/' + character;
    const text = JSON.stringify(input);
    rejected(text, 'yaml', 'UNSUPPORTED_YAML_SYNTAX');
    expect(parseUpstreamCredentialBindings(text, 'json').sites[0].match.basePath).toBe('/' + character);
    rejected(yaml + '# literal ' + character + '\n', 'yaml', 'UNSUPPORTED_YAML_SYNTAX');
  });
  test.each([
    ['json', '{"' + marker + '":'],
    ['yaml', 'key: ["' + marker + '"'],
    ['yaml', 'key: !' + marker + ' value'],
    ['json', JSON.stringify({ ...candidate(), unexpected: marker })],
  ] as [Format, string][])('%s errors do not expose source or original exception', (format, text) => {
    rejected(text, format);
  });
  test.each(['{} trailing', '{unquoted: 1}', '{"x":1,}', '{}\n{}'])('JSON refuses YAML-only or trailing syntax %s', text => {
    rejected(text, 'json', 'INVALID_TEXT_SYNTAX');
  });
  test('rejects nonstring input without invoking coercion', () => {
    const toString = jest.fn(() => { throw new Error(marker); });
    rejected({ toString } as unknown as string, 'json', 'INVALID_TEXT_INPUT');
    expect(toString).not.toHaveBeenCalled();
  });
  test('requires explicit supported format', () => {
    rejected('{}', undefined as unknown as Format, 'INVALID_TEXT_FORMAT');
    rejected('{}', 'toml' as Format, 'INVALID_TEXT_FORMAT');
  });
  test('reference-only schema policy remains enforced for both formats', () => {
    const input = candidate();
    input.reload.rejectPlaintextSecrets = false;
    for (const format of ['json', 'yaml'] as const) {
      rejected(JSON.stringify(input), format, 'PLAINTEXT_NOT_ALLOWED');
    }
  });
  test('loading references does not resolve providers or perform file/network I/O', () => {
    const providerFactory = jest.fn(() => { throw new Error('UNEXPECTED_PROVIDER_IO'); });
    jest.doMock('./secret-provider', () => ({ createUpstreamSecretProvider: providerFactory }));
    try {
      jest.isolateModules(() => {
        const isolated = require('./loader') as typeof import('./loader');
        const targets: [string, string[]][] = [
          ['node:fs', ['readFile', 'readFileSync', 'open', 'openSync', 'stat', 'statSync']],
          ['node:fs/promises', ['readFile', 'open', 'stat']],
          ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
          ['node:net', ['connect', 'createConnection']], ['node:dns', ['lookup', 'resolve']],
        ];
        const spies: jest.SpyInstance[] = [];
        try {
          for (const [moduleName, methods] of targets) {
            const module = require(moduleName);
            for (const method of methods) {
              spies.push(jest.spyOn(module, method).mockImplementation(() => {
                throw new Error('UNEXPECTED_LOADER_IO');
              }));
            }
          }
          spies.push(jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('UNEXPECTED_LOADER_IO');
          }));
          const input = candidate();
          Object.assign(input.secretProviders, { disk: { type: 'file', root: '/not-accessed', requireOwnerOnly: true } });
          input.credentials.token.secretRef = 'disk:service/token';
          for (const format of ['json', 'yaml'] as const) {
            expect(isolated.parseUpstreamCredentialBindings(JSON.stringify(input), format).credentials.token)
              .toMatchObject({ secretRef: 'disk:service/token' });
          }
          expect(providerFactory).not.toHaveBeenCalled();
          spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
        } finally {
          spies.forEach(spy => spy.mockRestore());
        }
      });
    } finally {
      jest.dontMock('./secret-provider');
    }
  });
});
