import { attestPublicationHostAuthorityPlan, inspectPublicationHostAuthorityPlan } from './publication-host-authority-plan';

describe('host-only publication plan attestation', () => {
  const options = () => ({
    sessions: { resolve: async () => undefined },
    ownership: { resolve: async () => undefined, resolveMembership: async () => undefined },
    bindings: { read: async () => undefined },
    captureSnapshot: () => { throw Error('not configured'); },
    audit: { record: async () => undefined },
  });
  it('retains host method identities and rejects serialized/reconstructed plan objects', () => {
    const input = options(), plan = attestPublicationHostAuthorityPlan(input);
    expect(JSON.stringify(plan)).toBe('{}');
    expect(Object.isFrozen(inspectPublicationHostAuthorityPlan(plan))).toBe(true);
    expect(() => inspectPublicationHostAuthorityPlan(JSON.parse(JSON.stringify(plan)))).toThrow('publication_host_authority_plan_invalid');
    expect(() => inspectPublicationHostAuthorityPlan({} as any)).toThrow('publication_host_authority_plan_invalid');
    input.sessions.resolve = async () => ({ actorId: 'injected', authenticationEpoch: 'injected' }) as any;
    return expect(inspectPublicationHostAuthorityPlan(plan).sessions.resolve({})).resolves.toBeUndefined();
  });
  it.each([0, -1, 60001, NaN, Infinity, 1.5])('rejects invalid proof lifetime %s', ttlMs => {
    expect(() => attestPublicationHostAuthorityPlan({ ...options(), ttlMs })).toThrow('publication_host_authority_plan_invalid');
  });
  it('rejects missing membership ownership, proxies, extension fields and accessors without executing them', () => {
    const getter = jest.fn();
    expect(() => attestPublicationHostAuthorityPlan({ ...options(), ownership: { resolve: async () => undefined } } as any)).toThrow();
    expect(() => attestPublicationHostAuthorityPlan(new Proxy(options(), {}))).toThrow();
    expect(() => attestPublicationHostAuthorityPlan({ ...options(), canPublish: true } as any)).toThrow();
    expect(() => attestPublicationHostAuthorityPlan(Object.defineProperty(options(), 'sessions', { get: getter }))).toThrow();
    expect(() => attestPublicationHostAuthorityPlan({ ...options(), sessions: Object.defineProperty({}, 'resolve', { get: getter }) } as any)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
