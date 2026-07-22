import { RuntimeResponseAssertionService } from './runtime-response-assertion.service';

describe('RuntimeResponseAssertionService', () => {
  const service = new RuntimeResponseAssertionService();

  it('uses schema mode by default and reports the precise missing path', () => {
    const result = service.assert({ responsePayload: { id: 1, customer: { name: 'A' } } } as any, {
      id: 9,
      customer: {},
      extra: true,
    });
    expect(result).toEqual({
      passed: false,
      mode: 'schema',
      mismatches: [{ path: '$.customer.name', expected: 'string', actual: 'missing' }],
    });
  });

  it('supports exact mode with ignored dynamic paths', () => {
    const result = service.assert({
      responsePayload: { id: 1, state: 'ready' },
      metadata: { responseAssertion: { mode: 'exact', ignoredPaths: ['$.id'] } },
    } as any, { id: 99, state: 'ready' });
    expect(result.passed).toBe(true);
  });

  it('can explicitly keep status-only behavior', () => {
    const result = service.assert({
      responsePayload: { expected: true },
      metadata: { responseAssertion: { mode: 'status' } },
    } as any, { different: true });
    expect(result).toEqual({ passed: true, mode: 'status', mismatches: [] });
  });
});
