import * as publicApi from '../index';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createParserHostNetworkBridge } from './parser-host-network-bridge';
import { createNetworkPolicyCompiler } from './network-policy';
import { createHostCredentialGenerationStore } from '../credentials/host-credential-generations';
import { createRegistryProviderEvidence } from '../credentials/registry-provider-evidence';
import { UpstreamCredentialRegistry } from '../credentials/registry';
import { transformToMCPTools } from '../transformer';

describe('explicit host safe-read through actual Transformer tools', () => {
  let directory: string, ca: string, key: string;
  const cleanup: (() => Promise<void> | void)[] = [];
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-safe-read-'));
    const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(directory, 'key'), '-out', path.join(directory, 'cert')], { stdio: 'ignore', windowsHide: true });
    key = fs.readFileSync(path.join(directory, 'key'), 'utf8'); ca = fs.readFileSync(path.join(directory, 'cert'), 'utf8');
  }, 30000);
  afterAll(() => { if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true }); });
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function setup(tls = false, safe = true, activate = true) {
    const visits: { path: string; method: string; headers: http.IncomingHttpHeaders }[] = [];
    let next = '/1', during: (() => void) | undefined;
    const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
      visits.push({ path: req.url!, method: req.method!, headers: { ...req.headers } });
      if (req.url === '/0') { res.writeHead(302, { location: next }); during?.(); }
      res.end('ok');
    };
    const server = tls ? https.createServer({ key, cert: ca }, serve) : http.createServer(serve);
    const sockets = new Set<net.Socket>(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => { sockets.forEach(s => s.destroy()); return new Promise<void>(resolve => server.close(() => resolve())); });
    const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const store = createHostCredentialGenerationStore();
    const generation = store.activate(store.stage({ providers: { memory: { TOKEN: 'fixed-secret' } }, expiresAt: Date.now() + 60000 }), null);
    const evidence = createRegistryProviderEvidence(store); cleanup.push(() => { evidence.close(); store.close(); });
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerEvidence: evidence });
    const snapshot = await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' },
      reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { memory: { type: 'env' } }, credentials: { token: { type: 'bearer', secretRef: 'memory:TOKEN' } },
      sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: tls ? 'https' : 'http', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'token', endpoints: [{ endpointDefinitionId: 'start' }, { endpointDefinitionId: 'next', credential: 'none' }] }] });
    const compiler = createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'test-only' });
    const policy = compiler.compile({ version: 1, id: 'policy', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, mode: 'private-exception', connection: 'direct', privateException: {
      id: 'test', revision: '1', sourceServiceAssetId: 'asset', siteId: 'site', origin, addresses: ['127.0.0.1'], purpose: 'isolated host test', owner: 'test', approvalRef: 'test', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() } });
    const targets = ['GET', 'HEAD'].map(method => ({ siteId: 'site', method: method as 'GET' | 'HEAD', path: '/1', endpointDefinitionId: 'next', policy, headers: { 'X-Target': 'host', Authorization: 'strip' } }));
    const input = { registry, sourceServiceAssetId: 'asset', compiler, ca, servers: ['127.0.0.1:9'], registrations: [{ snapshot, sourceServiceAssetId: 'asset', siteId: 'site', policy }],
      providerEvidence: safe ? evidence : { consume: evidence.consume.bind(evidence), readEpoch: evidence.readEpoch.bind(evidence) }, ...(safe ? { redirect: { mode: 'safe-read' as const, targets } } : {}) };
    const bridge = createParserHostNetworkBridge(input); cleanup.push(() => bridge.close());
    if (activate) bridge.activateCurrent(evidence.issue(snapshot, 'asset'));
    const tool = (method = 'GET', overrides = {}) => transformToMCPTools({ openapi: '3.0.3', info: { title: 'test', version: '1' }, servers: [{ url: origin }], 'x-redirect': { mode: 'safe-read' }, paths: { '/0': { [method.toLowerCase()]: { operationId: 'start', responses: { '200': { description: 'ok' } } } } } } as any,
      { includeFieldAnnotations: false, trustedOperationBindings: [{ sourceServiceAssetId: 'asset', endpointDefinitionId: 'start', method, path: '/0' }], upstreamCredentialPolicy: bridge.credentialPolicy, upstreamNetworkExecution: bridge.execution, ...overrides })[0];
    return { visits, tool, bridge, input, evidence, store, generation, snapshot, setNext: (value: string) => { next = value; }, setDuring: (value: () => void) => { during = value; } };
  }
  it.each([false, true])('real tool follows host target and strips credentials TLS=%s', async tls => {
    const f = await setup(tls); await f.tool().handler({}); expect(f.visits.map(v => v.path)).toEqual(['/0', '/1']);
    expect(f.visits[0].headers.authorization).toBe('Bearer fixed-secret'); expect(f.visits[1].headers.authorization).toBeUndefined(); expect(f.visits[1].headers['x-target']).toBe('host');
  });
  it('HEAD stays HEAD', async () => { const f = await setup(); await f.tool('HEAD').handler({}); expect(f.visits.map(v => v.method)).toEqual(['HEAD', 'HEAD']); });
  it('POST remains single-hop', async () => { const f = await setup(); await f.tool('POST').handler({}); expect(f.visits).toHaveLength(1); });
  it('unconfigured trusted network branch ignores tool and OpenAPI switches', async () => { const f = await setup(false, false); await f.tool().handler({ redirect: { mode: 'safe-read' }, targets: ['/1'], template: { authorization: 'forged' } }); expect(f.visits).toHaveLength(1); });
  it('tool args cannot extend the target directory', async () => { const f = await setup(); f.setNext('/forged'); await f.tool().handler({ targets: ['/forged'] }); expect(f.visits).toHaveLength(1); });
  it('missing or forged explicit proof sends nothing', async () => { const f = await setup(false, true, false); await f.tool().handler({ proof: {}, activate: true }); expect(f.visits).toHaveLength(0); expect(() => f.bridge.activateCurrent({})).toThrow(); });
  it('safe-read rejects cloned and structural issuers', async () => { const f = await setup(); for (const providerEvidence of [{ ...f.evidence }, { consume: f.evidence.consume, readEpoch: f.evidence.readEpoch }]) expect(() => createParserHostNetworkBridge({ ...f.input, providerEvidence })).toThrow(); });
  it('revocation before next hop stops tool', async () => { const f = await setup(); f.setDuring(() => f.store.revoke(f.generation)); await f.tool().handler({}); expect(f.visits).toHaveLength(1); });
  it('execution copy or mismatched policy cannot be supplied to Transformer', async () => { const f = await setup(); expect(() => f.tool('GET', { upstreamNetworkExecution: { ...f.bridge.execution } })).toThrow(); expect(() => f.tool('GET', { upstreamCredentialPolicy: { ...f.bridge.credentialPolicy } })).toThrow(); });
  it('expired proof and a proof from a different issuer cannot activate', async () => {
    const f = await setup(false, true, false);
    const proof = f.evidence.issue(f.snapshot, 'asset', 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(() => f.bridge.activateCurrent(proof)).toThrow();
    await f.tool().handler({}); expect(f.visits).toHaveLength(0);
    const other = await setup(false, true, false);
    expect(() => other.bridge.activateCurrent(f.evidence.issue(f.snapshot, 'asset'))).toThrow();
    await other.tool().handler({}); expect(other.visits).toHaveLength(0);
  });
  it('consumed proof cannot be replayed to reactivate', async () => {
    const f = await setup(false, true, false), proof = f.evidence.issue(f.snapshot, 'asset');
    f.bridge.activateCurrent(proof); f.bridge.revoke();
    expect(() => f.bridge.activateCurrent(proof)).toThrow(); await f.tool().handler({}); expect(f.visits).toHaveLength(0);
  });
  it('host template is copied and tool headers cannot replace it', async () => {
    const f = await setup(); f.input.redirect!.targets[0].headers['X-Target'] = 'mutated';
    await f.tool().handler({ headers: { 'X-Target': 'tool', authorization: 'forged' } });
    expect(f.visits[1].headers['x-target']).toBe('host'); expect(f.visits[1].headers.authorization).toBeUndefined();
  });

  it('root entry exposes genuine host factories without internal Snapshot association helpers', () => {
    const store = publicApi.createHostCredentialGenerationStore(), issuer = publicApi.createRegistryProviderEvidence(store);
    try {
      expect(() => publicApi.assertRegistryProviderEvidence(issuer)).not.toThrow();
      expect(() => publicApi.assertRegistryProviderEvidence({ ...issuer })).toThrow();
      for (const name of ['associateRegistryProviderGeneration', 'captureRegistryProviderGeneration', 'capturedRegistrySecretProvider'])
        expect(Object.prototype.hasOwnProperty.call(publicApi, name)).toBe(false);
    } finally { issuer.close(); store.close(); }
  });

});
