import { auditNetworkFailure, createNetworkDenialAuditRecord, NetworkDenialAuditContext } from './network-denial-audit';
import { createNetworkFailure } from './network-failure-contract';
const context = (): NetworkDenialAuditContext => ({ operationId: 'op-1', sourceServiceAssetId: 'asset-1', siteId: 'site-1', endpointDefinitionId: 'endpoint-1',
  policyId: 'policy-1', revision: 'r1', revocationEpoch: '1', redirectHopIndex: 0, attemptIndex: 1, stage: 'dns' });
const denied = createNetworkFailure('denied');

describe('pure network refusal audit whitelist', () => {
  it('emits only fixed scalar fields, copied and frozen independently of its host context', () => {
    const input = context(), record = createNetworkDenialAuditRecord(denied, input)!;
    expect(record).toEqual({ ...input, schemaVersion: 1, eventName: 'upstream.network_failure', reason: 'upstream_network_policy_denied' });
    expect(Object.isFrozen(record)).toBe(true); expect(Object.getPrototypeOf(record)).toBeNull();
    (input as any).revision = 'changed'; expect(record.revision).toBe('r1');
    expect(createNetworkDenialAuditRecord(denied, Object.assign(Object.create(null), context()))).toEqual(record);
  });
  it.each(['url', 'location', 'headers', 'body', 'error', 'message', 'toJSON', '__proto__'])('rejects extra %s without accessing its value', key => {
    const getter = jest.fn(() => 'private-secret');
    const input = Object.defineProperty(context(), key, { get: getter, enumerable: true });
    expect(createNetworkDenialAuditRecord(denied, input)).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['operationId', 'revision', 'redirectHopIndex', 'stage'])('rejects getter in allowed field %s without invoking it', key => {
    const getter = jest.fn(() => { throw new Error('private'); });
    expect(createNetworkDenialAuditRecord(denied, Object.defineProperty(context(), key, { get: getter }))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects inherited fields, class instances, symbol keys, missing fields and revoked proxies', () => {
    const revoked = Proxy.revocable(context(), {}); revoked.revoke();
    const missing = { ...context() }; delete (missing as any).operationId;
    for (const value of [Object.create(context()), Object.assign(new Date(), context()), { ...context(), [Symbol('secret')]: 'secret' }, missing, revoked.proxy, null]) {
      expect(createNetworkDenialAuditRecord(denied, value)).toBeUndefined();
    }
  });
  it.each([
    ['operationId', 'https://internal.invalid/path?token=secret'], ['revision', 'Authorization: secret'], ['siteId', 'secret\nvalue'],
    ['stage', 'raw-private-error'], ['revocationEpoch', '01'], ['revocationEpoch', -1], ['attemptIndex', 0], ['attemptIndex', 1.5],
    ['redirectHopIndex', -1], ['redirectHopIndex', 6], ['redirectHopIndex', Number.NaN], ['attemptIndex', Number.MAX_SAFE_INTEGER],
  ])('rejects invalid %s=%s without recording it', (key, value) => {
    expect(createNetworkDenialAuditRecord(denied, { ...context(), [key as string]: value })).toBeUndefined();
  });
  it('accepts the initial and fifth hop and does not invent physical-send evidence', () => {
    for (const redirectHopIndex of [0, 5]) {
      const record = createNetworkDenialAuditRecord(denied, { ...context(), redirectHopIndex, stage: 'target' })!;
      expect(record.redirectHopIndex).toBe(redirectHopIndex); expect(record).not.toHaveProperty('sent'); expect(record).not.toHaveProperty('url');
    }
  });
  it('never includes error properties or arbitrary serialization output', () => {
    const secret = 'raw-secret-value', toJSON = jest.fn(() => ({ headers: secret }));
    const result = createNetworkDenialAuditRecord({ code: 'denied', message: secret, url: secret, toJSON }, context());
    expect(result?.reason).toBe('upstream_network_policy_unavailable'); expect(JSON.stringify(result)).not.toContain(secret); expect(toJSON).not.toHaveBeenCalled();
  });
  it('keeps refusal when no valid context exists without calling the sink', () => {
    const sink = jest.fn();
    expect(auditNetworkFailure(denied, undefined, sink).gateway).toEqual({ action: 'respond', statusCode: 502 });
    expect(sink).not.toHaveBeenCalled();
  });
  it('contains synchronous, rejected and hostile-thenable sink failures', async () => {
    const rejected = jest.fn(() => Promise.reject(new Error('secret')));
    const sinks = [() => { throw new Error('secret'); }, rejected, () => Object.defineProperty({}, 'then', { get() { throw new Error('secret'); } })];
    for (const sink of sinks) expect(auditNetworkFailure(denied, context(), sink).gateway).toEqual({ action: 'respond', statusCode: 502 });
    await new Promise(resolve => setImmediate(resolve)); expect(rejected).toHaveBeenCalledTimes(1);
  });
  it('does not await an unresponsive audit sink or permit it to mutate refusal', () => {
    const sink = jest.fn(record => { expect(Object.isFrozen(record)).toBe(true); expect(Object.getPrototypeOf(record)).toBeNull(); return new Promise(() => {}); });
    expect(auditNetworkFailure(denied, context(), sink, 'started').gateway).toEqual({ action: 'destroy' });
    expect(sink).toHaveBeenCalledTimes(1);
  });
});