import 'reflect-metadata';
import {
  parseManagedChildMessage,
  parseManagedParentMessage,
} from '../../../../../api-nova-server/src/managed/handoff';
import {
  MANAGED_EXECUTION_PERMIT_DENIED_CODE,
  ManagedAuthorizationGateError,
  ManagedExecutionPermitGate,
} from '../../../../../api-nova-server/src/managed/authorization';

const LAUNCH = 'launch-permit-protocol';
const mode = (overrides: Record<string, unknown> = {}) =>
  ({ type: 'permitMode', version: 1, launchId: LAUNCH, sequence: 1, permitId: 'permit-one', ...overrides });
const decision = (overrides: Record<string, unknown> = {}) =>
  ({ type: 'permitDecision', version: 1, launchId: LAUNCH, requestId: 'permit-request-1', permitId: 'permit-one', decision: 'allow', ...overrides });
const request = (overrides: Record<string, unknown> = {}) =>
  ({ type: 'permitRequest', version: 1, launchId: LAUNCH, requestId: 'permit-request-1', tool: 'items',
    method: 'GET', path: '/items', sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one', ...overrides });
const binding = { tool: 'items', method: 'GET', path: '/items', sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' };

describe('managed execution permit wire protocol (SEC-F1-02C3G6)', () => {
  it('accepts exactly the bounded permit shapes and rejects malformed/extra fields', () => {
    expect(parseManagedParentMessage(mode())).toEqual(mode());
    expect(parseManagedParentMessage(decision())).toEqual(decision());
    for (const malformed of [mode({ version: 2 }), mode({ sequence: 0 }), mode({ permitId: '' }),
      mode({ secret: 'synthetic-extra' }), decision({ decision: 'revoke' }), decision({ requestId: '' }),
      decision({ extra: true }), decision({ requestId: 'x'.repeat(241) })]) {
      expect(() => parseManagedParentMessage(malformed)).toThrow('INVALID_MANAGED_HANDOFF');
    }
    expect(parseManagedChildMessage(request(), LAUNCH)).toEqual(request());
    expect(parseManagedChildMessage({ type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'applied' }, LAUNCH))
      .toEqual({ type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'applied' });
    for (const malformed of [request({ method: 'BREW' }), request({ path: 'items' }), request({ path: '/items\u0001' }),
      request({ tool: '' }), request({ sourceServiceAssetId: '' }), request({ endpointDefinitionId: 'x'.repeat(241) }),
      request({ extra: true }), { ...request(), launchId: 'other-launch' },
      { type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'granted' }]) {
      expect(() => parseManagedChildMessage(malformed, LAUNCH)).toThrow('INVALID_MANAGED_HANDOFF');
    }
  });

  it('keeps the child default-open until permit mode, then requires a fresh allowed decision per execution', async () => {
    const requests: any[] = [];
    const gate = new ManagedExecutionPermitGate(async value => { requests.push(value); return 'allow'; });
    expect(gate.enforcing).toBe(false);
    await expect(gate.assertAllowed(binding)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);

    expect(gate.applyMode(mode() as any)).toMatchObject({ status: 'applied' });
    expect(gate.enforcing).toBe(true);
    await expect(gate.assertAllowed(binding)).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(binding);
    expect(gate.applyMode(mode() as any)).toMatchObject({ status: 'duplicate' });

    const denied = new ManagedExecutionPermitGate(async () => 'deny');
    denied.applyMode(mode() as any);
    await expect(denied.assertAllowed(binding)).rejects.toMatchObject({ code: MANAGED_EXECUTION_PERMIT_DENIED_CODE });

    const failing = new ManagedExecutionPermitGate(async () => { throw new Error('transport'); });
    failing.applyMode(mode() as any);
    await expect(failing.assertAllowed(binding)).rejects.toMatchObject({ code: MANAGED_EXECUTION_PERMIT_DENIED_CODE });

    const missing = new ManagedExecutionPermitGate(undefined);
    missing.applyMode(mode() as any);
    await expect(missing.assertAllowed(binding)).rejects.toMatchObject({ code: MANAGED_EXECUTION_PERMIT_DENIED_CODE });
  });

  it('fails closed on replay, revocation and never carries proof material', async () => {
    const gate = new ManagedExecutionPermitGate(async () => 'allow');
    gate.applyMode(mode() as any);
    expect(() => gate.applyMode(mode({ permitId: 'other-permit' }) as any)).toThrow('MANAGED_AUTHORIZATION_REPLAYED');
    expect(() => gate.applyMode(mode({ sequence: 0 }) as any)).toThrow('MANAGED_AUTHORIZATION_REPLAYED');
    expect(gate.applyMode(mode({ sequence: 2, permitId: 'permit-two' }) as any)).toMatchObject({ status: 'applied' });
    expect(gate.permitId).toBe('permit-two');
    expect(() => gate.applyMode(mode({ sequence: 1, permitId: 'permit-one' }) as any)).toThrow(ManagedAuthorizationGateError);

    gate.revoke();
    await expect(gate.assertAllowed(binding)).rejects.toMatchObject({ code: MANAGED_EXECUTION_PERMIT_DENIED_CODE });
    expect(() => gate.applyMode(mode({ sequence: 3, permitId: 'permit-three' }) as any)).toThrow('MANAGED_AUTHORIZATION_REPLAYED');

    const wire = JSON.stringify(gate);
    expect(wire).not.toContain('synthetic');
    expect(wire).not.toContain('proof');
    expect(wire).not.toContain('token');
    expect(Object.keys(gate).sort()).toEqual(['last', 'mode', 'request']);
  });
});
