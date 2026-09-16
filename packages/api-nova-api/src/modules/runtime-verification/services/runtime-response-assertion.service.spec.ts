import {
  BINARY_RESPONSE_ASSERTION_UNSUPPORTED,
  RuntimeResponseAssertionService,
} from './runtime-response-assertion.service';

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

  const binaryDescriptor = {
    kind: 'binary', schemaVersion: 1, mediaType: 'application/pdf',
    measurement: 'decoded_response_body', observedBytes: 4,
    isComplete: true, sha256: 'a'.repeat(64), captureState: 'stored',
    opaqueObjectId: '11111111-1111-4111-8111-111111111111',
  };

  it.each([undefined, 'schema', 'exact', 'binary-exact', 'unknown'])(
    'blocks binary descriptor comparison in %s mode before replay',
    mode => {
      const sample = {
        responsePayload: binaryDescriptor,
        metadata: mode ? { responseAssertion: { mode, ignoredPaths: ['$'] } } : {},
      } as any;
      expect(service.preflight(sample)).toEqual({
        code: BINARY_RESPONSE_ASSERTION_UNSUPPORTED,
        message: expect.stringContaining('status-only'),
      });
      const result = service.assert(sample, { ...binaryDescriptor });
      expect(result).toEqual(expect.objectContaining({
        passed: false, mode: 'unsupported',
        blockerCode: BINARY_RESPONSE_ASSERTION_UNSUPPORTED,
        mismatches: [],
      }));
    },
  );

  it.each([undefined, 0, 2, '1'])(
    'blocks unknown binary descriptor version %s even under status-only',
    schemaVersion => {
      const sample = {
        responsePayload: { ...binaryDescriptor, schemaVersion },
        metadata: { responseAssertion: { mode: 'status' } },
      } as any;
      expect(service.preflight(sample)).toEqual(expect.objectContaining({
        code: BINARY_RESPONSE_ASSERTION_UNSUPPORTED,
      }));
      expect(service.assert(sample, { ...sample.responsePayload })).toEqual(
        expect.objectContaining({
          passed: false, mode: 'unsupported',
          blockerCode: BINARY_RESPONSE_ASSERTION_UNSUPPORTED,
        }),
      );
    },
  );

  it('allows only explicit status-only binary policy to skip content comparison', () => {
    const sample = {
      responsePayload: binaryDescriptor,
      metadata: { responseAssertion: { mode: 'status' } },
    } as any;
    expect(service.preflight(sample)).toBeUndefined();
    expect(service.assert(sample, { completely: 'different' })).toEqual({
      passed: true, mode: 'status', mismatches: [],
    });
  });

  it('can explicitly keep status-only behavior', () => {
    const result = service.assert({
      responsePayload: { expected: true },
      metadata: { responseAssertion: { mode: 'status' } },
    } as any, { different: true });
    expect(result).toEqual({ passed: true, mode: 'status', mismatches: [] });
  });
});
