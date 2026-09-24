import { assertGatewayHeaderMigrationTransition as transition, newGatewayHeaderPolicyDraft, normalizeGatewayHeaderMigration as normalize } from './gateway-header-migration';
const now = Date.parse('2026-09-24T00:00:00Z');
const context = { routeId: 'route-1', registryConfigured: false, now };
const exception = () => ({ version: 1, mode: 'legacy', routeId: 'route-1', owner: 'operator', reason: 'documented cookie migration', issuedAt: '2026-09-23T00:00:00Z', expiresAt: '2026-10-23T00:00:00Z', rollbackEvidence: 'review:123' });
describe('persisted Gateway Header migration contract (not wired to activation)', () => {
  it('creates only an explicitly requested new draft with persisted v1 provenance', () => {
    const draft = newGatewayHeaderPolicyDraft({ cache: { ttlMs: 1000 } });
    expect(draft).toMatchObject({ headerPolicy: { version: 1 }, headerPolicyMigration: { version: 1, mode: 'v1', source: 'inline' } });
    expect(() => transition(undefined, draft, context)).not.toThrow();
    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
  });
  it('never backfills or mutates old unmarked metadata and refuses user-supplied draft policy', () => {
    const old = { cache: { ttlMs: 1000 } }, serialized = JSON.stringify(old);
    transition(old, old, context); expect(JSON.stringify(old)).toBe(serialized); expect('headerPolicy' in old).toBe(false);
    for (const invalid of [{ headerPolicy: null }, { headerPolicy: { version: 1 } }, { headerPolicyMigration: {} }]) expect(() => newGatewayHeaderPolicyDraft(invalid)).toThrow('NOT_READY');
  });
  it('round-trips a named UTC legacy exception at exactly 30 days', () => {
    const raw = exception(); const parsed = normalize(JSON.parse(JSON.stringify(raw)), 'route-1', now);
    expect(parsed).toEqual(raw); expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => transition({}, { headerPolicyMigration: raw }, context)).not.toThrow();
  });
  it.each([
    { owner: '' }, { reason: '' }, { rollbackEvidence: '' }, { routeId: 'other' }, { mode: 'other' }, { version: 2 }, { unexpected: true },
    { expiresAt: '2026-10-23T00:00:00.001Z' }, { expiresAt: '2026-09-24T00:00:00Z' }, { issuedAt: '2026-09-25T00:00:00Z' },
    { expiresAt: '2026-10-01T08:00:00+08:00' }, { expiresAt: '2026-02-30T00:00:00Z' },
  ])('rejects malformed, wrong-route, expired or overlong exception: %p', patch => {
    expect(() => normalize({ ...exception(), ...patch }, 'route-1', now)).toThrow('MIGRATION_INVALID');
  });
  it('does not execute configuration accessors', () => {
    const getter = jest.fn(() => 'legacy'); const raw = { ...exception() };
    Object.defineProperty(raw, 'mode', { enumerable: true, get: getter });
    expect(() => normalize(raw, 'route-1', now)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { headerPolicy: null }, { headerPolicy: { version: 2 } }, { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } }, { headerPolicyMigration: exception() }])('rejects deleting or downgrading persisted v1: %p', next => {
    expect(() => transition(newGatewayHeaderPolicyDraft(), next, context)).toThrow();
  });
  it('rejects provider shutdown and source changes for persisted Registry provenance', () => {
    const registered = { headerPolicyMigration: { version: 1, mode: 'v1', source: 'registry' } };
    expect(() => transition(registered, registered, context)).toThrow();
    expect(() => transition(registered, registered, { ...context, registryConfigured: true })).not.toThrow();
    expect(() => transition(registered, newGatewayHeaderPolicyDraft(), context)).toThrow();
    expect(() => transition(registered, {}, { ...context, registryConfigured: true })).toThrow();
  });
  it('rejects deletion even for a historical explicit v1 policy lacking provenance', () => {
    expect(() => transition({ headerPolicy: { version: 1 } }, {}, context)).toThrow();
  });
});
