import 'reflect-metadata';
import { 
  MANAGED_AUTHORIZATION_DECISIONS,
  ManagedAuthorizationEvent,
  parseManagedChildMessage,
  parseManagedParentMessage,
} from '../../../../../api-nova-server/src/managed/handoff';
import { ManagedAuthorizationGate, ManagedAuthorizationGateError } from '../../../../../api-nova-server/src/managed/authorization';

const LAUNCH = 'launch-events';
function event(overrides: Record<string, unknown> = {}): ManagedAuthorizationEvent {
  return { type: 'authorization', version: 1, launchId: LAUNCH, sequence: 1, permitId: 'permit-1', decision: 'allow', ...overrides } as ManagedAuthorizationEvent;
}

describe('managed authorization wire protocol (SEC-F1-02E3b)', () => {
  it('accepts exactly one bounded authorization shape and rejects malformed events', () => {
    expect(MANAGED_AUTHORIZATION_DECISIONS).toEqual(['allow', 'deny', 'revoke']);
    expect(parseManagedParentMessage(event())).toEqual(event());
    for (const malformed of [event({ secret: 'synthetic' }), event({ version: 2 }), event({ decision: 'grant' }),
      event({ sequence: 0 }), event({ sequence: 1.5 }), event({ sequence: 2147483648 }), event({ permitId: '' })]) {
      expect(() => parseManagedParentMessage(malformed)).toThrow('INVALID_MANAGED_HANDOFF');
    }
    expect(() => parseManagedChildMessage({ type: 'authorizationAck', launchId: 'other-launch', sequence: 1,
      permitId: 'permit-1', decision: 'allow', status: 'applied' }, LAUNCH)).toThrow('INVALID_MANAGED_HANDOFF');
    expect(parseManagedChildMessage({ type: 'authorizationAck', launchId: LAUNCH, sequence: 1,
      permitId: 'permit-1', decision: 'allow', status: 'applied' }, LAUNCH)).toEqual({ type: 'authorizationAck',
      launchId: LAUNCH, sequence: 1, permitId: 'permit-1', decision: 'allow', status: 'applied' });
    expect(() => parseManagedChildMessage({ type: 'authorizationAck', launchId: LAUNCH, sequence: 1,
      permitId: 'permit-1', decision: 'allow', status: 'applied', extra: true }, LAUNCH)).toThrow('INVALID_MANAGED_HANDOFF');
  });

  it('is default-open until the parent opts in, then honors allow, deny, revoke and duplicates', () => {
    const gate = new ManagedAuthorizationGate();
    expect(gate.enforcing).toBe(false);
    expect(() => gate.assertAllowed('items')).not.toThrow();

    expect(gate.apply(event())).toMatchObject({ status: 'applied', decision: 'allow' });
    expect(gate.enforcing).toBe(true);
    expect(gate.decision).toBe('allow');
    expect(() => gate.assertAllowed('items')).not.toThrow();

    expect(gate.apply(event({ sequence: 2, permitId: 'permit-2', decision: 'deny' }))).toMatchObject({ status: 'applied' });
    expect(() => gate.assertAllowed('items')).toThrow(ManagedAuthorizationGateError);
    expect(gate.apply(event({ sequence: 2, permitId: 'permit-2', decision: 'deny' }))).toMatchObject({ status: 'duplicate' });
    expect(gate.decision).toBe('deny');

    expect(gate.apply(event({ sequence: 3, permitId: 'permit-3', decision: 'revoke' }))).toMatchObject({ status: 'applied' });
    expect(gate.decision).toBe('revoked');
    expect(() => gate.assertAllowed('items')).toThrow(ManagedAuthorizationGateError);
  });

  it('fails closed on conflicting or stale replays and never revives a revoked gate', () => {
    const gate = new ManagedAuthorizationGate();
    gate.apply(event());
    expect(() => gate.apply(event({ decision: 'deny' }))).toThrow('MANAGED_AUTHORIZATION_REPLAYED');
    expect(() => gate.apply(event({ sequence: 3, permitId: 'permit-3' }))).not.toThrow();
    expect(() => gate.apply(event({ sequence: 2, permitId: 'permit-2' }))).toThrow('MANAGED_AUTHORIZATION_REPLAYED');

    const revoked = new ManagedAuthorizationGate();
    revoked.apply(event({ decision: 'revoke' }));
    expect(() => revoked.apply(event({ sequence: 2, permitId: 'permit-2', decision: 'allow' }))).toThrow('MANAGED_AUTHORIZATION_REPLAYED');
    expect(revoked.apply(event({ decision: 'revoke' }))).toMatchObject({ status: 'duplicate' });
  });
});
