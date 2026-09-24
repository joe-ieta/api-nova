import { classifyNetworkAddress, NETWORK_SPECIAL_RANGES, normalizeExceptionCidr, parseNetworkAddress, parseNetworkCidr } from './address-policy';
import { createNetworkPolicyCompiler, normalizeNetworkUrl } from './network-policy';
const now = Date.parse('2026-09-24T00:00:00Z');
const host = () => createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' });
const config = () => ({ version: 1, id: 'policy', revision: 'r1', sourceServiceAssetId: 'source', siteId: 'site', origin: 'https://example.test', mode: 'public', connection: 'direct' });
const exception = (addresses = ['10.0.0.0/8']) => ({ ...config(), mode: 'private-exception', privateException: { id: 'exception', revision: 'e1', sourceServiceAssetId: 'source', siteId: 'site', origin: 'https://example.test', addresses, purpose: 'test', owner: 'owner', approvalRef: 'review-1', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z' } });
const request = (address = '8.8.8.8') => ({ sourceServiceAssetId: 'source', siteId: 'site', url: 'https://example.test/path', address });
describe('network address table', () => {
  it.each(NETWORK_SPECIAL_RANGES)('%s first-address category', (cidr, category) => {
    // The broader 2001::/23 also contains the more-specific Teredo allocation.
    expect(classifyNetworkAddress(cidr.split('/')[0]).category).toBe(cidr === '2001::/23' ? 'transition' : category);
  });
  it.each(NETWORK_SPECIAL_RANGES)('%s last-address category', (cidr, category) => {
    const range = parseNetworkCidr(cidr);
    const address = range.family === 4
      ? [24, 16, 8, 0].map(shift => Number((range.last >> BigInt(shift)) & 255n)).join('.')
      : Array.from({ length: 8 }, (_, i) => ((range.last >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':');
    expect(classifyNetworkAddress(address).category).toBe(cidr === '240.0.0.0/4' ? 'broadcast' : category);
  });
  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '2001:4860::8888'])('ordinary unicast %s', address => expect(classifyNetworkAddress(address).category).toBe('public'));
  it.each(['100.127.255.255', '172.31.255.255', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:1::1', '2001:30::1', 'fec0::1', '4000::1', '2001:4860::5efe:808:808', 'fd01::200:5efe:808:808'])('special %s never public', address => expect(classifyNetworkAddress(address).category).not.toBe('public'));
  it.each(['127.1', '2130706433', '0x7f000001', '0177.0.0.1', 'fe80::1%eth0', ' 8.8.8.8', '8.8.8.8\n'])('rejects ambiguous %s', address => expect(() => parseNetworkAddress(address)).toThrow());
  it('normalizes mapped addresses before classification and CIDR checks', () => {
    expect(parseNetworkAddress('::ffff:c0a8:101').canonical).toBe('192.168.1.1');
    expect(classifyNetworkAddress('::ffff:127.0.0.1').category).toBe('loopback');
    expect(parseNetworkCidr('::ffff:10.0.0.0/104').canonical).toBe('10.0.0.0/8');
    expect(normalizeExceptionCidr('::ffff:127.0.0.1/128')).toBe('127.0.0.1/32');
  });
  it.each(['0.0.0.0/0', '::/0', '8.0.0.0/6', '10.1.0.0/8', '127.0.0.0/8', '100.64.0.0/10', '2000::/3', '2002::/16', '169.254.169.254', '::ffff:0:0/80'])('rejects unsafe CIDR %s', cidr => expect(() => normalizeExceptionCidr(cidr)).toThrow());
  it.each(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fd01::/64', '127.0.0.1/32', '::1/128', '8.8.8.8/32'])('canonical exception %s', cidr => expect(normalizeExceptionCidr(cidr)).toBe(cidr));
});
describe('strict URL', () => {
  it('normalizes IDNA, effective ports and mapped literals', () => {
    expect(normalizeNetworkUrl('HTTPS://BÜCHER.example/a').origin).toBe('https://xn--bcher-kva.example:443');
    expect(normalizeNetworkUrl('http://[::ffff:127.0.0.1]/').origin).toBe('http://127.0.0.1:80');
  });
  it.each(['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://example.test./', 'http://example.test。/', 'http://u:p@example.test/', 'http://example.test/#', 'http://example.test:0/', 'http://example.test:080/', 'http://example.test:/', 'http://example.test:65536/', 'http://[fe80::1%25eth0]/', 'http://%31%32%37.0.0.1/', 'http://example.test/%2e', 'http://example.test/%2f', 'http://example.test/%5c', 'http://example.test/\n', 'file:///tmp/a', 'http://[127.0.0.1]/'])('rejects %s', url => expect(() => normalizeNetworkUrl(url)).toThrow());
  it.each(['https://example.test/a/..', 'https://example.test/?', 'https://example.test/path'])('requires exact origin %s', origin => expect(() => host().compile({ ...config(), origin }, now)).toThrow());
});
describe('host network policy', () => {
  it.each([{ version: 2 }, { connection: 'proxy' }, { mode: 'allow-all' }, { wildcard: true }, { origin: 'https://*.test' }, { privateException: undefined }])('rejects unsupported %j', patch => expect(() => host().compile({ ...config(), ...patch }, now)).toThrow());
  it('rejects getters and inherited config without invoking getter', () => {
    const getter = jest.fn(); const raw = config(); Object.defineProperty(raw, 'revision', { get: getter });
    expect(() => host().compile(raw, now)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => host().compile(Object.assign(Object.create({}), config()), now)).toThrow();
  });
  it('immutable exact source/site/origin and instance capability', () => {
    const compiler = host(), raw = config(), policy = compiler.compile(raw, now); raw.origin = 'https://evil.test';
    expect(Object.isFrozen(policy)).toBe(true); expect(compiler.allows(policy, request(), now)).toBe(true);
    for (const patch of [{ sourceServiceAssetId: 'other' }, { siteId: 'other' }, { url: 'http://example.test/path' }, { url: 'https://other.test/path' }, { address: '10.0.0.1' }]) expect(compiler.allows(policy, { ...request(), ...patch }, now)).toBe(false);
    expect(compiler.allows(JSON.parse(JSON.stringify(policy)), request(), now)).toBe(false);
    expect(host().allows(policy, request(), now)).toBe(false);
  });
  it('literal URL candidate must match; endpoint constraints only narrow', () => {
    const compiler = host(), literal = compiler.compile({ ...config(), origin: 'https://8.8.8.8' }, now), policy = compiler.compile(config(), now);
    expect(compiler.allows(literal, { ...request('1.1.1.1'), url: 'https://8.8.8.8/' }, now)).toBe(false);
    expect(compiler.allows(policy, { ...request(), endpointAddresses: ['1.1.1.1'] }, now)).toBe(false);
    expect(compiler.allows(policy, { ...request('10.0.0.1'), endpointAddresses: ['10.0.0.0/8'] }, now)).toBe(false);
    expect(compiler.allows(policy, { ...request(), endpointAddresses: ['8.8.8.8'] }, now)).toBe(true);
  });
  it('live expiry, immutable CIDRs, no implicit public union', () => {
    const compiler = host(), raw = exception(), policy = compiler.compile(raw, now); raw.privateException.addresses.push('8.8.8.8');
    expect(Object.isFrozen(policy.exception!.addresses)).toBe(true);
    expect(compiler.allows(policy, request('10.1.2.3'), now)).toBe(true);
    expect(compiler.allows(policy, request(), now)).toBe(false);
    expect(compiler.allows(policy, request('10.1.2.3'), policy.exception!.expiresAt)).toBe(false);
    expect(compiler.allows(policy, request('10.1.2.3'), now - 1)).toBe(false);
  });
  it.each([{ expiresAt: '2026-10-24T00:00:00.001Z' }, { issuedAt: '2026-09-24T00:00:01Z' }, { expiresAt: '2026-09-24T00:00:00Z' }, { expiresAt: '2026-10-24T08:00:00+08:00' }, { issuedAt: '2026-02-30T00:00:00Z' }, { owner: '' }, { approvalRef: '' }, { siteId: 'other' }, { origin: 'https://other.test' }, { addresses: [] }])('rejects exception %j', patch => { const raw = exception(); expect(() => host().compile({ ...raw, privateException: { ...raw.privateException, ...patch } }, now)).toThrow(); });
  it('exact loopback only in explicit test mode', () => {
    expect(() => host().compile(exception(['127.0.0.1']), now)).toThrow();
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' }), policy = compiler.compile(exception(['127.0.0.1']), now);
    expect(compiler.allows(policy, request('::ffff:127.0.0.1'), now)).toBe(true);
    expect(compiler.allows(policy, request('127.0.0.2'), now)).toBe(false);
  });
  it.each(['fd00:ec2::254', 'fc00::/7', '169.254.169.254', '100.100.100.200'])('permanent metadata/control denial %s', address => expect(() => host().compile(exception([address]), now)).toThrow());
  it('never admits ISATAP inside an otherwise allowed ULA prefix', () => {
    const compiler = host(), policy = compiler.compile(exception(['fd01::/64']), now);
    expect(compiler.allows(policy, request('fd01::1234'), now)).toBe(true);
    expect(compiler.allows(policy, request('fd01::5efe:808:808'), now)).toBe(false);
  });
  it('does not execute coercion hooks on unsupported config values', () => {
    const toString = jest.fn(() => 'public');
    expect(() => host().compile({ ...config(), mode: { toString } }, now)).toThrow();
    expect(toString).not.toHaveBeenCalled();
  });
  it('host exact-port deny wins and changes compiled identity', () => {
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [{ address: '8.8.8.8', ports: [443] }], loopback: 'deny' }), policy = compiler.compile(config(), now);
    expect(compiler.allows(policy, request(), now)).toBe(false);
    expect(compiler.allows(policy, request('1.1.1.1'), now)).toBe(true);
    expect(() => compiler.compile(exception(['8.8.8.8']), now)).toThrow();
    expect(policy.identity).not.toBe(host().compile(config(), now).identity);
  });
});
