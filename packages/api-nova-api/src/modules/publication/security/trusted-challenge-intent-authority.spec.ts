import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { User, UserStatus } from '../../../database/entities/user.entity';
import { createTrustedChallengeIntentAuthority } from './trusted-challenge-intent-authority';
const ids = { sourceServiceAssetId: 'source', endpointDefinitionId: 'endpoint' };
describe('host-only authenticated challenge intent gate', () => {
  let server: http.Server, url: string, hits: number, transportCalls: number;
  let user: User, options: any, session: object, ownershipRevision: string, foreign: boolean, now: number;
  let sessions: WeakMap<object, { actorId: string; authenticationEpoch: string }>;
  beforeEach(async () => {
    hits = transportCalls = 0; foreign = false; ownershipRevision = 'ownership-1'; now = Date.now();
    user = Object.assign(new User(), { id: 'actor', status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles: [{ id: 'role', name: 'operator', enabled: true, permissions: [{ id: 'permission', name: 'upstream:challenge', enabled: true }] }] });
    sessions = new WeakMap(); session = Object.freeze({}); sessions.set(session, { actorId: 'actor', authenticationEpoch: 'session-1' });
    options = { sessions: { resolve: jest.fn(async value => sessions.get(value)) }, users: { findUserById: jest.fn(async () => user) },
      ownership: { resolve: jest.fn(async (actor, target) => !foreign && actor === 'actor' && target.sourceServiceAssetId === 'source' && target.endpointDefinitionId === 'endpoint' ? { revision: ownershipRevision } : undefined) },
      audit: { record: jest.fn(async () => undefined) }, now: () => now };
    server = http.createServer((_req, res) => { hits++; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/test`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  async function consume(authority: ReturnType<typeof createTrustedChallengeIntentAuthority>, intent: unknown) {
    const claim = await authority.resolve(intent); transportCalls++;
    await new Promise<void>((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject)); return claim;
  }
  function zero() { expect(transportCalls).toBe(0); expect(hits).toBe(0); }
  it('rechecks fresh user permissions/ownership and produces a C3e-compatible single-use claim', async () => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids);
    expect(JSON.stringify(intent)).toBe('{}'); expect(await consume(authority, intent)).toEqual({ ...ids, actorId: 'actor', intentId: expect.any(String) });
    expect(options.users.findUserById).toHaveBeenCalledTimes(4); expect(options.ownership.resolve).toHaveBeenCalledTimes(4);
    await authority.complete(intent, 'passed'); expect(options.audit.record.mock.calls.map(call => call[0].event)).toEqual(['issued', 'consumed', 'passed']); expect(hits).toBe(1);
  });
  it.each(['unauthenticated', 'plain-user', 'locked', 'inactive', 'unverified-email', 'disabled-role', 'disabled-permission', 'missing-permission', 'conditional-permission', 'foreign-tenant', 'missing-ownership'])('rejects %s before transport', async reason => {
    let capability: any = session;
    if (reason === 'unauthenticated') capability = {};
    if (reason === 'plain-user') capability = user;
    if (reason === 'locked') user.lockedUntil = new Date(Date.now() + 60000);
    if (reason === 'inactive') user.status = UserStatus.INACTIVE;
    if (reason === 'unverified-email') user.emailVerified = false;
    if (reason === 'disabled-role') user.roles[0].enabled = false;
    if (reason === 'disabled-permission') user.roles[0].permissions[0].enabled = false;
    if (reason === 'missing-permission') user.roles[0].permissions[0].name = 'server:manage';
    if (reason === 'conditional-permission') user.roles[0].permissions[0].conditions = { customCondition: 'unimplemented' } as any;
    if (reason === 'foreign-tenant') foreign = true;
    if (reason === 'missing-ownership') options.ownership = undefined;
    const authority = createTrustedChallengeIntentAuthority(options);
    await expect((async () => consume(authority, await authority.issue(capability, ids)))()).rejects.toThrow('CHALLENGE_INTENT_DENIED'); zero();
  });
  it('does not grant implicit permission to super_admin or editable ownership labels', async () => {
    user.roles[0].name = 'super_admin'; user.roles[0].permissions = []; (user as any).owner = 'source'; (user as any).metadata = { tenant: 'approved' };
    await expect(createTrustedChallengeIntentAuthority(options).issue(session, ids)).rejects.toThrow(); zero();
  });
  it.each(['permission', 'ownership', 'session', 'expiry'])('rejects stale %s at intent consumption', async changed => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids);
    if (changed === 'permission') user.roles[0].permissions[0].enabled = false;
    if (changed === 'ownership') ownershipRevision = 'ownership-2';
    if (changed === 'session') sessions.set(session, { actorId: 'actor', authenticationEpoch: 'session-2' });
    if (changed === 'expiry') now += 6000;
    await expect(consume(authority, intent)).rejects.toThrow('CHALLENGE_INTENT_DENIED'); zero();
  });
  it('rejects forged/JSON intents and request-supplied target fields', async () => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids);
    await expect(consume(authority, JSON.parse(JSON.stringify(intent)))).rejects.toThrow();
    await expect(authority.issue(session, { ...ids, url, state: 'Verified' } as any)).rejects.toThrow(); zero();
  });
  it('prevents same-entity concurrency even with reversed ID property order', async () => {
    const authority = createTrustedChallengeIntentAuthority(options); await authority.issue(session, ids);
    await expect(authority.issue(session, { endpointDefinitionId: 'endpoint', sourceServiceAssetId: 'source' })).rejects.toThrow(); zero();
  });
  it('rejects replay before a second transport and releases only after completion audit', async () => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids); await authority.resolve(intent);
    await expect(consume(authority, intent)).rejects.toThrow(); await expect(authority.issue(session, ids)).rejects.toThrow(); zero();
    await authority.complete(intent, 'failed'); await expect(authority.issue(session, ids)).resolves.toBeDefined();
  });
  it.each(['issued', 'consumed'])('audit failure at %s cannot authorize transport', async event => {
    options.audit.record.mockImplementation(async entry => { if (entry.event === event) throw Error('private-audit-path'); });
    const authority = createTrustedChallengeIntentAuthority(options);
    await expect((async () => consume(authority, await authority.issue(session, ids)))()).rejects.toThrow('CHALLENGE_INTENT_DENIED'); zero();
    expect(JSON.stringify(options.audit.record.mock.calls)).not.toMatch(/private-audit-path|authenticationEpoch|permissions|token/);
  });
  it('failed completion audit cannot release a consumed lease', async () => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids); await authority.resolve(intent);
    options.audit.record.mockImplementation(async entry => { if (entry.event === 'passed') throw Error('private-audit-path'); });
    await expect(authority.complete(intent, 'passed')).rejects.toThrow('CHALLENGE_INTENT_DENIED'); await expect(authority.issue(session, ids)).rejects.toThrow(); zero();
  });
  it('permission revoked during consume audit is rejected by final recheck', async () => {
    const authority = createTrustedChallengeIntentAuthority(options), intent = await authority.issue(session, ids);
    options.audit.record.mockImplementation(async entry => { if (entry.event === 'consumed') user.roles[0].enabled = false; });
    await expect(consume(authority, intent)).rejects.toThrow(); zero();
  });
});
