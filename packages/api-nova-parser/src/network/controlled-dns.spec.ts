import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { createControlledDns } from './controlled-dns';
import { createNetworkPolicyCompiler } from './network-policy';
import { parseNetworkAddress } from './address-policy';

type Answer = { addresses?: string[]; cname?: string; rcode?: number; silent?: boolean; delay?: number; malformed?: boolean };
function name(value: string): Buffer { return Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]); }
function record(owner: Buffer, type: number, data: Buffer): Buffer {
  const meta = Buffer.alloc(10); meta.writeUInt16BE(type, 0); meta.writeUInt16BE(1, 2); meta.writeUInt32BE(0, 4); meta.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, meta, data]);
}
describe('controlled DNS with real isolated UDP answers', () => {
  let udp: dgram.Socket, trap: net.Server, dnsPort: number, targetPort: number;
  let queries: Array<{ host: string; type: number }>, connections: number, timers: ReturnType<typeof setTimeout>[];
  let respond: (host: string, type: number) => Answer;
  const compiler = () => createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
  const target = () => ({ sourceServiceAssetId: 'asset', siteId: 'site', url: `http://fixture.test:${targetPort}/secret-path?hidden=secret` });
  function policy(c: ReturnType<typeof compiler>, addresses?: string[], expiresAt = Date.now() + 30000) {
    const base = { version: 1, id: 'network', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin: `http://fixture.test:${targetPort}`, mode: addresses ? 'private-exception' : 'public', connection: 'direct' };
    return c.compile(addresses ? { ...base, privateException: { id: 'review', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin: base.origin, addresses, purpose: 'isolated test', owner: 'test', approvalRef: 'test-review', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(expiresAt).toISOString() } } : base);
  }
  const adapter = (c: ReturnType<typeof compiler>) => createControlledDns({ compiler: c, servers: [`127.0.0.1:${dnsPort}`] });
  beforeEach(async () => {
    queries = []; connections = 0; timers = [];
    respond = (_, type) => ({ addresses: type === 1 ? ['8.8.8.8'] : [] });
    trap = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve)); targetPort = (trap.address() as net.AddressInfo).port;
    udp = dgram.createSocket('udp4');
    udp.on('message', (query, peer) => {
      let at = 12; const labels: string[] = [];
      while (query[at]) { const length = query[at++]; labels.push(query.subarray(at, at + length).toString()); at += length; }
      at++; const type = query.readUInt16BE(at), end = at + 4, host = labels.join('.'); queries.push({ host, type });
      const answer = respond(host, type); if (answer.silent) return;
      const records: Buffer[] = []; let owner: Buffer = Buffer.from([0xc0, 0x0c]);
      if (answer.cname) { records.push(record(owner, 5, name(answer.cname))); owner = name(answer.cname); }
      for (const address of answer.addresses ?? []) {
        const parsed = parseNetworkAddress(address);
        const data = type === 1 ? Buffer.from(address.split('.').map(Number)) : Buffer.from(parsed.value.toString(16).padStart(32, '0'), 'hex');
        records.push(record(owner, type, answer.malformed ? Buffer.from([1, 2, 3]) : data));
      }
      const header = Buffer.alloc(12); query.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180 | (answer.rcode ?? 0), 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(records.length, 6);
      const packet = Buffer.concat([header, query.subarray(12, end), ...records]);
      const send = () => udp.send(packet, peer.port, peer.address);
      if (answer.delay) timers.push(setTimeout(send, answer.delay)); else send();
    });
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve)); dnsPort = udp.address().port;
  });
  afterEach(async () => {
    timers.forEach(clearTimeout);
    await new Promise<void>(resolve => udp.close(() => resolve()));
    await new Promise<void>(resolve => trap.close(() => resolve()));
    expect(connections).toBe(0);
  });
  it('authorizes complete A/AAAA results without opening any target connection', async () => {
    respond = (_, type) => ({ addresses: type === 1 ? ['8.8.8.8', '1.1.1.1'] : ['2001:4860::8888'] });
    const c = compiler(), dns = adapter(c), result = await dns.resolve({ policy: policy(c), target: target(), deadline: Date.now() + 2000 });
    expect(result.addresses.map(value => value.address)).toEqual(['8.8.8.8', '1.1.1.1', '2001:4860::8888']);
    expect(queries.map(value => value.type).sort()).toEqual([1, 28]);
    expect(dns.revalidate(result)).toBe(true); expect(Object.isFrozen(result.addresses)).toBe(true);
    expect(dns.revalidate(JSON.parse(JSON.stringify(result)))).toBe(false); expect(adapter(c).revalidate(result)).toBe(false);
  });
  it.each(['mixed4', 'mixed6', 'cname-private'])('rejects the entire final set: %s', async mode => {
    respond = (_, type) => ({ cname: mode.startsWith('cname') ? 'final.test' : undefined, addresses: type === 1 ? mode === 'mixed4' || mode === 'cname-private' ? ['8.8.8.8', '127.0.0.1'] : ['8.8.8.8'] : mode === 'mixed6' ? ['::1'] : [] });
    const c = compiler(); await expect(adapter(c).resolve({ policy: policy(c), target: target(), deadline: Date.now() + 2000 })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
    expect(queries).toHaveLength(2);
  });
  it('accepts CNAME final address records, not the alias as an IP authorization', async () => {
    respond = (_, type) => ({ cname: 'final.test', addresses: type === 1 ? ['8.8.8.8'] : ['2001:4860::8888'] });
    const c = compiler(), result = await adapter(c).resolve({ policy: policy(c), target: target(), deadline: Date.now() + 2000 });
    expect(result.host).toBe('fixture.test'); expect(result.addresses).toHaveLength(2);
  });
  it.each(['empty', 'nxdomain', 'servfail', 'partial-error', 'malformed'])('fails closed on %s', async mode => {
    respond = (_, type) => mode === 'empty' ? {} : mode === 'malformed' ? { addresses: type === 1 ? ['8.8.8.8'] : [], malformed: true } : mode === 'partial-error' && type === 1 ? { addresses: ['8.8.8.8'] } : { rcode: mode === 'nxdomain' ? 3 : 2 };
    const c = compiler(); await expect(adapter(c).resolve({ policy: policy(c), target: target(), deadline: Date.now() + 250 })).rejects.toBeInstanceOf(Error);
  });
  it.each(['foreign-source', 'foreign-site', 'foreign-origin', 'forged', 'foreign-compiler', 'expired', 'invalid-cidr'])('denies before DNS: %s', async mode => {
    const c = compiler(), p = policy(c, mode === 'expired' ? ['127.0.0.1'] : undefined, Date.now() + 20);
    if (mode === 'expired') await new Promise(resolve => setTimeout(resolve, 30));
    const input = { policy: mode === 'forged' ? JSON.parse(JSON.stringify(p)) : mode === 'foreign-compiler' ? policy(compiler()) : p,
      target: { ...target(), ...(mode === 'foreign-source' ? { sourceServiceAssetId: 'other' } : mode === 'foreign-site' ? { siteId: 'other' } : mode === 'foreign-origin' ? { url: 'http://other.test/' } : mode === 'invalid-cidr' ? { endpointAddresses: ['bad'] } : {}) }, deadline: Date.now() + 1000 };
    await expect(adapter(c).resolve(input)).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(queries).toHaveLength(0);
  });
  it('honors absolute deadline and suppresses late answers; next attempt freshly resolves', async () => {
    respond = (_, type) => ({ addresses: type === 1 ? ['8.8.8.8'] : [], delay: 100 });
    const c = compiler(), dns = adapter(c), p = policy(c);
    await expect(dns.resolve({ policy: p, target: target(), deadline: Date.now() + 25 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    respond = (_, type) => ({ addresses: type === 1 ? ['1.1.1.1'] : [] });
    const result = await dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000 });
    expect(result.addresses[0].address).toBe('1.1.1.1'); expect(queries).toHaveLength(4);
  });
  it('cancels only its independent Resolver, preserving concurrent attempts', async () => {
    respond = (host, type) => ({ addresses: type === 1 ? ['8.8.8.8'] : [], delay: 50 });
    const c = compiler(), dns = adapter(c), p = policy(c), abort = new AbortController();
    const first = dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000, signal: abort.signal });
    const rejected = expect(first).rejects.toMatchObject({ code: 'ABORT_ERR' });
    const second = dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000 });
    setTimeout(() => abort.abort(), 10); await rejected;
    expect((await second).addresses[0].address).toBe('8.8.8.8');
  });
  it('revalidates expiry, cancellation and deadline after resolution', async () => {
    const c = compiler(), dns = adapter(c), abort = new AbortController();
    const result = await dns.resolve({ policy: policy(c), target: target(), deadline: Date.now() + 1000, signal: abort.signal });
    abort.abort(); expect(dns.revalidate(result)).toBe(false);
    const short = await dns.resolve({ policy: policy(c), target: target(), deadline: Date.now() + 50 });
    await new Promise(resolve => setTimeout(resolve, 60)); expect(dns.revalidate(short)).toBe(false);
    respond = (_, type) => ({ addresses: type === 1 ? ['127.0.0.1'] : [] });
    const expiring = await dns.resolve({ policy: policy(c, ['127.0.0.1'], Date.now() + 100), target: target(), deadline: Date.now() + 1000 });
    await new Promise(resolve => setTimeout(resolve, 110)); expect(dns.revalidate(expiring)).toBe(false);
  });
  it('rejects DNS rebinding on the next attempt rather than reusing an approved answer', async () => {
    const c = compiler(), dns = adapter(c), p = policy(c);
    await dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000 });
    respond = (_, type) => ({ addresses: type === 1 ? ['127.0.0.1'] : [] });
    await expect(dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000 })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' }); expect(queries).toHaveLength(4);
  });
  it('normalizes direct mapped IP without DNS and requires exact exception', async () => {
    const c = compiler(); const p = c.compile({ version: 1, id: 'literal', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin: 'http://8.8.8.8', mode: 'public', connection: 'direct' });
    const result = await adapter(c).resolve({ policy: p, target: { ...target(), url: 'http://[::ffff:8.8.8.8]/' }, deadline: Date.now() + 1000 });
    expect(result.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]); expect(queries).toHaveLength(0);
  });
  it('caps silent DNS at five seconds even with a longer operation deadline', async () => {
    respond = () => ({ silent: true }); const c = compiler(), start = Date.now();
    await expect(adapter(c).resolve({ policy: policy(c), target: target(), deadline: start + 20000 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(4800); expect(Date.now() - start).toBeLessThan(8000);
  }, 10000);
  it('pre-aborted and elapsed-deadline requests emit zero DNS packets', async () => {
    const c = compiler(), dns = adapter(c), p = policy(c), abort = new AbortController(); abort.abort();
    await expect(dns.resolve({ policy: p, target: target(), deadline: Date.now() + 1000, signal: abort.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await expect(dns.resolve({ policy: p, target: target(), deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(queries).toHaveLength(0);
  });
  it('does not authorize a result when the exception expires while DNS is pending', async () => {
    respond = (_, type) => ({ addresses: type === 1 ? ['127.0.0.1'] : [], delay: 100 });
    const c = compiler(); await expect(adapter(c).resolve({ policy: policy(c, ['127.0.0.1'], Date.now() + 50), target: target(), deadline: Date.now() + 1000 })).rejects.toMatchObject({ code: 'upstream_network_policy_denied' });
  });
  it('scrubs DNS/native errors and rejects externally supplied lookup/transport configuration', async () => {
    respond = () => ({ rcode: 2 }); const c = compiler();
    try { await adapter(c).resolve({ policy: policy(c), target: target(), deadline: Date.now() + 1000 }); throw new Error('expected denial'); }
    catch (error) { expect(String(error)).not.toMatch(/fixture|secret|127\./); expect((error as Error & { cause?: unknown }).cause).toBeUndefined(); }
    expect(() => createControlledDns({ compiler: c, servers: ['resolver.test'] })).toThrow();
    expect(() => createControlledDns({ compiler: c, servers: [] })).toThrow();
    expect(() => createControlledDns({ compiler: c, servers: [`127.0.0.1:${dnsPort}`], lookup: () => [] } as any)).toThrow();
  });
});
