import { createRedirectChainState } from './redirect-chain-state';
const initial = { url: 'https://example.test/start', method: 'GET', hasBody: false };
const safe = () => createRedirectChainState({ ...initial, mode: 'safe-read' });
const denied = 'upstream_network_policy_denied';

describe('pure redirect chain state (no network authority)', () => {
  it('defaults to single-hop and never interprets a Location as a target', () => {
    const chain = createRedirectChainState(initial);
    expect(chain.inspect({ statusCode: 302, location: 'not a valid URL' })).toEqual({ kind: 'return', hop: 0 });
    expect(() => chain.inspect({ statusCode: 200 })).toThrow(denied);
  });
  it.each(['GET', 'HEAD'])('preserves safe-read %s and resolves relative locations', method => {
    const chain = createRedirectChainState({ ...initial, method, mode: 'safe-read' });
    const decision = chain.inspect({ statusCode: 303, location: '/next?q=1' });
    expect(decision).toEqual({ kind: 'follow', hop: 1, method, url: 'https://example.test:443/next?q=1' });
    expect(Object.isFrozen(decision)).toBe(true);
    chain.advance(decision);
    expect(chain.inspect({ statusCode: 200 })).toEqual({ kind: 'return', hop: 1 });
  });
  it.each([301, 302, 303, 307, 308])('follows eligible %s only after explicit advance', statusCode => {
    const chain = safe(); const decision = chain.inspect({ statusCode, location: '/next' });
    expect(decision.kind).toBe('follow'); chain.advance(decision);
    expect(chain.inspect({ statusCode: 204 })).toEqual({ kind: 'return', hop: 1 });
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'])('returns original redirect for %s without method conversion', method => {
    const chain = createRedirectChainState({ ...initial, method, mode: 'safe-read' });
    expect(chain.inspect({ statusCode: 303 })).toEqual({ kind: 'return', hop: 0 });
  });
  it.each(['GET', 'HEAD'])('never replays a present body for %s', method => {
    const chain = createRedirectChainState({ ...initial, method, hasBody: true, mode: 'safe-read' });
    expect(chain.inspect({ statusCode: 307 })).toEqual({ kind: 'return', hop: 0 });
  });
  it.each([200, 204, 300, 304, 305, 404, 500])('returns non-follow status %s', statusCode => {
    expect(safe().inspect({ statusCode, location: '/unused' })).toEqual({ kind: 'return', hop: 0 });
  });
  it('permits five follows and rejects the sixth terminally', () => {
    const chain = safe();
    for (let hop = 1; hop <= 5; hop++) {
      const decision = chain.inspect({ statusCode: 302, location: `/hop-${hop}` });
      expect(decision).toMatchObject({ kind: 'follow', hop }); chain.advance(decision);
    }
    expect(() => chain.inspect({ statusCode: 302, location: '/hop-6' })).toThrow(denied);
    expect(() => chain.inspect({ statusCode: 200 })).toThrow(denied);
  });
  it.each(['/start', 'https://EXAMPLE.test:443/start', '/a/../start', '/%73tart'])('rejects normalized cycle %s', location => {
    expect(() => safe().inspect({ statusCode: 302, location })).toThrow(denied);
  });
  it('treats IDNA Unicode and ASCII host spellings as the same loop target', () => {
    const chain = createRedirectChainState({ ...initial, url: 'https://xn--bcher-kva.test/start', mode: 'safe-read' });
    expect(() => chain.inspect({ statusCode: 302, location: 'https://b¨¹cher.test/start' })).toThrow(denied);
  });
  it('normalizes percent hex case for loop identity without changing authorization URL', () => {
    const chain = createRedirectChainState({ ...initial, url: 'https://example.test/a%3Fb', mode: 'safe-read' });
    expect(() => chain.inspect({ statusCode: 302, location: '/a%3fb' })).toThrow(denied);
  });
  it('explicit single-hop HEAD preserves 303 as a returned response', () => {
    const chain = createRedirectChainState({ ...initial, method: 'HEAD', mode: 'single-hop' });
    expect(chain.inspect({ statusCode: 303, location: '/next' })).toEqual({ kind: 'return', hop: 0 });
  });
  it('detects non-adjacent cycles', () => {
    const chain = safe(); const first = chain.inspect({ statusCode: 302, location: '/one' }); chain.advance(first);
    const second = chain.inspect({ statusCode: 302, location: '/two' }); chain.advance(second);
    expect(() => chain.inspect({ statusCode: 302, location: '/one' })).toThrow(denied);
  });
  it.each([undefined, '', ' /next', '/next#fragment', '/%2e/secret', '/%2fsecret', '/%5csecret', 'http://example.test/plain',
    '/%ZZ', '/%FF', '/%E0%A4', 'https://user:secret@example.test/', 'https://2130706433/', '//0177.0.0.1/', 'file:///local'])('rejects invalid Location evidence %#', location => {
    expect(() => safe().inspect({ statusCode: 302, location })).toThrow(denied);
  });
  it('does not equate a pure cross-origin decision with permission to send', () => {
    const decision = safe().inspect({ statusCode: 302, location: 'https://other.test/path' });
    expect(decision).toMatchObject({ kind: 'follow', url: 'https://other.test:443/path' });
    expect(Object.keys(decision).sort()).toEqual(['hop', 'kind', 'method', 'url']);
  });
  it.each(['clone', 'foreign', 'replay'])('rejects %s decision and prevents recovery', kind => {
    const chain = safe(), decision = chain.inspect({ statusCode: 302, location: '/next' });
    const other = safe().inspect({ statusCode: 302, location: '/next' });
    if (kind === 'replay') chain.advance(decision);
    expect(() => chain.advance(kind === 'clone' ? { ...decision } : kind === 'foreign' ? other : decision)).toThrow(denied);
    expect(() => chain.inspect({ statusCode: 200 })).toThrow(denied);
  });
  it('rejects concurrent inspect while a decision is pending', () => {
    const chain = safe(), pending = chain.inspect({ statusCode: 302, location: '/next' });
    expect(() => chain.inspect({ statusCode: 302, location: '/raced' })).toThrow(denied);
    expect(() => chain.advance(pending)).toThrow(denied);
  });
  it('close is idempotent and abandons a pending decision', () => {
    const chain = safe(), pending = chain.inspect({ statusCode: 302, location: '/next' });
    chain.close(); chain.close(); expect(() => chain.advance(pending)).toThrow(denied);
  });
  it('does not invoke getters or include their values in errors', () => {
    const getter = jest.fn(() => 'private');
    const evidence = Object.defineProperty({ statusCode: 302 }, 'location', { get: getter });
    expect(() => safe().inspect(evidence)).toThrow(denied); expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ mode: 'automatic' }, { hasBody: undefined }, { method: 'get' }, { extra: true }])('rejects invalid configuration %#', value => {
    expect(() => createRedirectChainState({ ...initial, ...value } as any)).toThrow(denied);
  });
  it.each([0, 99, 600, 302.5, NaN])('rejects invalid status %#', statusCode => {
    expect(() => safe().inspect({ statusCode })).toThrow(denied);
  });
});
