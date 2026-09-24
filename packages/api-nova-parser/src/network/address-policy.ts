import { isIP } from 'node:net';

/** Conservative snapshot: IANA IPv4/IPv6 Special-Purpose registries, 2025-10-09.
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 * All special-purpose allocations (including globally reachable anycast) are denied.
 * IPv6 outside ordinary 2000::/3 is denied unless explicitly private/loopback.
 * Updating this table requires reviewing both IANA registry deltas and rerunning boundary tests.
 * Classification is not a BGP, DNS, reachability, or deployment isolation claim.
 */
export const NETWORK_ADDRESS_TABLE_VERSION = 'iana-2025-10-09-conservative-v1';
export type NetworkAddressClass = 'public' | 'private' | 'loopback' | 'unspecified' | 'link-local' | 'shared' | 'multicast' | 'broadcast' | 'documentation' | 'benchmark' | 'transition' | 'reserved';
export class NetworkPolicyError extends Error { constructor() { super('NETWORK_POLICY_REJECTED'); this.name = 'NetworkPolicyError'; } }
export const rejectNetworkPolicy = (): never => { throw new NetworkPolicyError(); };
interface Address { family: 4 | 6; bits: number; value: bigint; canonical: string; mapped: boolean }
export interface NetworkCidr extends Address { prefix: number; last: bigint }
function v6Text(value: bigint): string {
  const parts = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(16 * (7 - i))) & 65535n).toString(16));
  let best = -1, length = 1;
  for (let i = 0; i < 8;) { if (parts[i] !== '0') { i++; continue; } let end = i; while (end < 8 && parts[end] === '0') end++; if (end - i > length) { best = i; length = end - i; } i = end; }
  return best < 0 ? parts.join(':') : parts.slice(0, best).join(':') + '::' + parts.slice(best + length).join(':');
}
export function parseNetworkAddress(raw: unknown): Readonly<Address> {
  if (typeof raw !== 'string' || raw.length > 45 || !raw || raw.includes('%') || raw.trim() !== raw) return rejectNetworkPolicy();
  const family = isIP(raw);
  if (family === 4) {
    const octets = raw.split('.'); if (octets.some(x => !/^(0|[1-9][0-9]{0,2})$/.test(x))) return rejectNetworkPolicy();
    const value = octets.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
    return Object.freeze({ family: 4, bits: 32, value, canonical: octets.join('.'), mapped: false });
  }
  if (family !== 6) return rejectNetworkPolicy();
  let input = raw.toLowerCase();
  if (input.includes('.')) {
    const start = input.lastIndexOf(':') + 1, v4 = parseNetworkAddress(input.slice(start));
    input = input.slice(0, start) + (v4.value >> 16n).toString(16) + ':' + (v4.value & 65535n).toString(16);
  }
  const halves = input.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = parts.reduce((n, x) => (n << 16n) | BigInt('0x' + x), 0n);
  if (value >> 32n === 65535n) {
    const inner = value & 0xffffffffn;
    return Object.freeze({ family: 4, bits: 32, value: inner, canonical: [24, 16, 8, 0].map(shift => Number((inner >> BigInt(shift)) & 255n)).join('.'), mapped: true });
  }
  return Object.freeze({ family: 6, bits: 128, value, canonical: v6Text(value), mapped: false });
}
export function parseNetworkCidr(raw: unknown): Readonly<NetworkCidr> {
  if (typeof raw !== 'string' || raw.length > 50) return rejectNetworkPolicy();
  const pieces = raw.split('/'); if (pieces.length > 2 || (pieces.length === 2 && !/^(0|[1-9][0-9]{0,2})$/.test(pieces[1]))) return rejectNetworkPolicy();
  const address = parseNetworkAddress(pieces[0]);
  let prefix = pieces.length === 1 ? address.bits : Number(pieces[1]);
  if (address.mapped && pieces.length === 2) prefix -= 96;
  if (prefix < 0 || prefix > address.bits) return rejectNetworkPolicy();
  const mask = (1n << BigInt(address.bits - prefix)) - 1n;
  if ((address.value & mask) !== 0n) return rejectNetworkPolicy();
  return Object.freeze({ ...address, prefix, last: address.value | mask, canonical: address.canonical + '/' + prefix });
}
export const NETWORK_SPECIAL_RANGES: ReadonlyArray<readonly [string, NetworkAddressClass]> = Object.freeze([
  ['0.0.0.0/8', 'unspecified'], ['10.0.0.0/8', 'private'], ['100.64.0.0/10', 'shared'], ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'], ['172.16.0.0/12', 'private'], ['192.0.0.0/24', 'reserved'], ['192.0.2.0/24', 'documentation'],
  ['192.31.196.0/24', 'reserved'], ['192.52.193.0/24', 'reserved'], ['192.88.99.0/24', 'transition'], ['192.168.0.0/16', 'private'],
  ['192.175.48.0/24', 'reserved'], ['198.18.0.0/15', 'benchmark'], ['198.51.100.0/24', 'documentation'], ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'], ['255.255.255.255/32', 'broadcast'], ['240.0.0.0/4', 'reserved'],
  ['::/128', 'unspecified'], ['::1/128', 'loopback'], ['64:ff9b::/96', 'transition'], ['64:ff9b:1::/48', 'transition'],
  ['100::/64', 'reserved'], ['100:0:0:1::/64', 'reserved'], ['2001::/32', 'transition'], ['2001:2::/48', 'benchmark'],
  ['2001::/23', 'reserved'], ['2001:db8::/32', 'documentation'], ['2002::/16', 'transition'], ['2620:4f:8000::/48', 'reserved'],
  ['3fff::/20', 'documentation'], ['5f00::/16', 'reserved'], ['fc00::/7', 'private'], ['fe80::/10', 'link-local'], ['ff00::/8', 'multicast'],
].map(row => Object.freeze(row as [string, NetworkAddressClass])));
const ranges = NETWORK_SPECIAL_RANGES.map(([cidr, category]) => ({ ...parseNetworkCidr(cidr), category }));
export function cidrContains(range: Readonly<NetworkCidr>, address: Readonly<Address>): boolean { return range.family === address.family && address.value >= range.value && address.value <= range.last; }
export function cidrsOverlap(a: Readonly<NetworkCidr>, b: Readonly<NetworkCidr>): boolean { return a.family === b.family && a.value <= b.last && b.value <= a.last; }
export function classifyNetworkAddress(raw: unknown): Readonly<{ address: string; family: 4 | 6; mapped: boolean; category: NetworkAddressClass; tableVersion: string }> {
  const address = parseNetworkAddress(raw);
  const isatap = address.family === 6 && ((address.value >> 32n) & 0xffffffffn) === 0x5efen || address.family === 6 && ((address.value >> 32n) & 0xffffffffn) === 0x2005efen;
  const category: NetworkAddressClass = isatap ? 'transition' : ranges.find(range => cidrContains(range, address))?.category
    ?? (address.family === 4 || (address.value >> 125n) === 1n ? 'public' : 'reserved');
  return Object.freeze({ address: address.canonical, family: address.family, mapped: address.mapped, category, tableVersion: NETWORK_ADDRESS_TABLE_VERSION });
}
/** Exceptions may not span a different category, special-use island, or broad loopback range. */
export function normalizeExceptionCidr(raw: unknown): string {
  const range = parseNetworkCidr(raw), category = classifyNetworkAddress(range.canonical.split('/')[0]).category;
  if (range.prefix === 0 || !['public', 'private', 'loopback'].includes(category) || category === 'loopback' && range.prefix !== range.bits) return rejectNetworkPolicy();
  if (ranges.some(other => cidrsOverlap(range, other) && other.category !== category)) return rejectNetworkPolicy();
  if (category !== 'public' && !ranges.some(other => other.category === category && other.family === range.family && other.value <= range.value && other.last >= range.last)) return rejectNetworkPolicy();
  if (range.family === 6 && category === 'public' && ((range.value >> 125n) !== 1n || (range.last >> 125n) !== 1n)) return rejectNetworkPolicy();
  return range.canonical;
}
