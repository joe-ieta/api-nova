import { classifyNetworkFailure, createNetworkFailure, networkFailureDisposition, NetworkFailureKind } from './network-failure-contract';

describe('pure trusted network failure contract', () => {
  it.each<[NetworkFailureKind, number, string]>([
    ['denied', 502, 'upstream_network_policy_denied'], ['unavailable', 503, 'upstream_network_policy_unavailable'], ['timeout', 504, 'ETIMEDOUT'],
  ])('maps trusted %s without copying raw messages', (kind, statusCode, code) => {
    const result = networkFailureDisposition(createNetworkFailure(kind));
    expect(result).toEqual({ kind, code, gateway: { action: 'respond', statusCode }, tool: { action: 'error' } });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.gateway)).toBe(true); expect(Object.isFrozen(result.tool)).toBe(true);
  });
  it('cancels without a second error response', () => {
    expect(networkFailureDisposition(createNetworkFailure('cancelled'))).toEqual({ kind: 'cancelled', code: 'ABORT_ERR', gateway: { action: 'destroy' }, tool: { action: 'cancelled' } });
  });
  it.each<NetworkFailureKind>(['denied', 'unavailable', 'timeout', 'cancelled'])('never responds after headers for %s', kind => {
    const failure = createNetworkFailure(kind);
    expect(networkFailureDisposition(failure, 'started').gateway).toEqual({ action: 'destroy' });
    expect(networkFailureDisposition(failure, 'closed').gateway).toEqual({ action: 'none' });
    expect(networkFailureDisposition(failure, 'forged' as any).gateway).toEqual({ action: 'destroy' });
  });
  it('does not trust cloned, serialized or wrapped capability objects', () => {
    const original = createNetworkFailure('denied');
    for (const value of [{ ...original }, JSON.parse(JSON.stringify(original)), Object.create(original), new Proxy(original, {}), 'denied', new Error('ETIMEDOUT')]) {
      expect(classifyNetworkFailure(value)).toBe('unavailable');
    }
    expect(classifyNetworkFailure(original)).toBe('denied');
  });
  it('does not inspect hostile error properties, prototypes or serialization', () => {
    const touched = jest.fn(() => { throw new Error('sensitive'); });
    const error = Object.create(null, Object.fromEntries(['code', 'name', 'message', 'toJSON', 'kind'].map(key => [key, { get: touched }])));
    const proxy = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [error, proxy, revoked.proxy, null, undefined, Symbol('secret'), () => 'secret']) {
      expect(networkFailureDisposition(value).code).toBe('upstream_network_policy_unavailable');
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it('normalizes unknown factory values without coercion', () => {
    const value = { toString: jest.fn(() => { throw new Error('secret'); }) };
    expect(classifyNetworkFailure(createNetworkFailure(value as any))).toBe('unavailable');
    expect(value.toString).not.toHaveBeenCalled();
  });
});