import { normalizeRuntimeAuditRecord, normalizeInvocationBody, summarizeInvocations,
  InvalidRuntimeAuditRecord } from './runtime-observability-contract';

const start = '2026-09-08T10:00:00.000Z';
const end = '2026-09-08T10:00:01.000Z';
function source(fields: Record<string, unknown> = {}) {
  return { schemaVersion: 2, invocationId: 'inv-1', eventId: 'evt-1', processId: 'process-1',
    recordVersion: 1, sequence: 1, phase: 'finished', spanKind: 'mcp_tool', kind: 'tool',
    transport: 'mcp', protocolTransport: 'streamable', requestId: 'req-1',
    startedAt: start, completedAt: end, durationMs: 1000, outcome: 'success',
    identitySource: 'authenticated', callerId: 'caller-1', ...fields };
}

describe('runtime observability source contract', () => {
  it('counts one tool and three upstream attempts without inflating business usage', () => {
    const rows = [normalizeRuntimeAuditRecord(source())];
    for (let attempt = 1; attempt <= 3; attempt++) rows.push(normalizeRuntimeAuditRecord(source({
      invocationId: 'api-' + attempt, eventId: 'api-event-' + attempt, kind: 'api',
      spanKind: 'upstream_api', parentInvocationId: 'inv-1', traceId: 'inv-1',
      upstreamOperationId: 'operation-1', attemptIndex: attempt,
      outcome: attempt === 3 ? 'success' : 'error', statusCode: attempt === 3 ? 200 : 503,
    })));
    expect(summarizeInvocations(rows, 'business').totalStarted).toBe(1);
    expect(summarizeInvocations(rows, 'upstream')).toMatchObject({
      totalStarted: 3, failures: 2, retryAttempts: 2, uniqueCallers: 1,
    });
  });


  it('maps cache evidence to successful ingress without an upstream attempt', () => {
    const row = normalizeRuntimeAuditRecord(source({ spanKind: 'gateway_request', kind: 'admission',
      transport: 'gateway', outcome: 'cache_hit' }));
    expect(row).toMatchObject({ spanKind: 'gateway_request', outcome: 'success', cacheHit: true });
    expect(summarizeInvocations([row], 'upstream').totalStarted).toBe(0);
  });

  it('keeps a tool error when its HTTP status was 200', () => {
    const row = normalizeRuntimeAuditRecord(source({ statusCode: 200, toolIsError: true }));
    expect(row.outcome).toBe('error');
  });

  it('keeps authentication failures out of trusted caller counts', () => {
    const row = normalizeRuntimeAuditRecord(source({ spanKind: 'mcp_protocol', kind: 'admission',
      statusCode: 401, identitySource: 'anonymous', callerId: 'forged-subject',
      authState: 'authentication_failed' }));
    expect(row).toMatchObject({ callerId: null, authState: 'authentication_failed', outcome: 'rejected' });
    expect(summarizeInvocations([row], 'protocol').uniqueCallers).toBe(0);
  });

  it('distinguishes not-read evidence from an actually empty body', () => {
    expect(normalizeInvocationBody({ state: 'omitted', totalBytes: 0,
      reason: 'body_not_consumed_at_admission' }).observedBytes).toBeNull();
    expect(normalizeInvocationBody({ state: 'empty', totalBytes: 0, data: '', capturedBytes: 0 }))
      .toMatchObject({ state: 'captured', observedBytes: 0 });
    expect(normalizeInvocationBody(undefined).state).toBe('unavailable');
  });

  it('does not retain fragments in omitted evidence or hide incomplete byte coverage', () => {
    expect(normalizeInvocationBody({ state: 'omitted', totalBytes: 9000, data: 'secret-fragment',
      reason: 'size_limit' })).toMatchObject({ data: undefined, capturedBytes: 0, observedBytes: 9000 });
    expect(normalizeInvocationBody({ state: 'incomplete', totalBytes: 15, capturedBytes: 0 }))
      .toMatchObject({ state: 'incomplete', digestScope: 'partial' });
  });

  it('keeps started invocations active and applies a late terminal revision once', () => {
    const first = normalizeRuntimeAuditRecord(source({ phase: 'started', completedAt: undefined }));
    const inferred = normalizeRuntimeAuditRecord(source({ recordVersion: 2, completionSource: 'reconciled' }));
    const final = normalizeRuntimeAuditRecord(source({ recordVersion: 3 }));
    expect(summarizeInvocations([first], 'tool')).toMatchObject({ inFlight: 1, knownCompleted: 0 });
    expect(summarizeInvocations([first, inferred, final, inferred, final], 'tool'))
      .toMatchObject({ totalStarted: 1, knownCompleted: 1, failures: 0, inFlight: 0 });
  });

  it('keeps test and probe calls out of the default external scope', () => {
    const row = normalizeRuntimeAuditRecord(source({ origin: 'probe', spanKind: 'upstream_api', kind: 'api' }));
    expect(summarizeInvocations([row], 'upstream').totalStarted).toBe(0);
    expect(summarizeInvocations([row], 'upstream', 'probe').totalStarted).toBe(1);
  });

  it('separates STDIO protocol activity from HTTP ingress and returns null empty ratios', () => {
    const row = normalizeRuntimeAuditRecord(source({ spanKind: 'mcp_protocol', protocolTransport: 'stdio' }));
    expect(summarizeInvocations([row], 'http_ingress')).toMatchObject({
      totalStarted: 0, successRate: null, errorRate: null,
    });
  });

  it('does not count redirect hops as multiple retry rounds', () => {
    const rows = [0, 1, 2].map(hop => normalizeRuntimeAuditRecord(source({
      invocationId: 'hop-' + hop, spanKind: 'upstream_api', kind: 'api',
      upstreamOperationId: 'op-1', attemptIndex: 2, redirectHopIndex: hop,
    })));
    expect(summarizeInvocations(rows, 'upstream')).toMatchObject({ totalStarted: 3, retryAttempts: 1 });
  });

  it('preserves unresolved parents instead of inventing a shared trace', () => {
    const row = normalizeRuntimeAuditRecord(source({ parentInvocationId: 'missing-parent' }));
    expect(row.traceId).toBeNull();
    expect(row.missingFields).toContain('traceId');
  });


  it('does not combine HTTP bytes with logical tool bytes in a business summary', () => {
    const body = { state: 'complete', data: '{}', totalBytes: 2, capturedBytes: 2 };
    const rows = [
      normalizeRuntimeAuditRecord(source({ invocationId: 'gateway', spanKind: 'gateway_request',
        transport: 'gateway', byteMeasurement: 'observed_body', request: body, response: body })),
      normalizeRuntimeAuditRecord(source({ invocationId: 'tool', byteMeasurement: 'serialized_payload',
        request: body, response: body })),
    ];
    expect(summarizeInvocations(rows, 'business')).toMatchObject({ totalStarted: 2,
      requestBytes: null, responseBytes: null });
    expect(summarizeInvocations(rows, 'business').byteTotals).toHaveLength(2);
  });

  it.each([
    { schemaVersion: 1 }, { schemaVersion: 99 }, { eventId: undefined }, { phase: 'invented' }, { spanKind: 'network' },
    { origin: 'telemetry' }, { startedAt: 'not-a-date' }, { recordVersion: 0 },
    { completedAt: undefined }, { statusCode: 700 }, { invocationId: '' },
  ])('quarantines invalid source fields rather than silently accepting them: %p', fields => {
    expect(() => normalizeRuntimeAuditRecord(source(fields))).toThrow(InvalidRuntimeAuditRecord);
  });
});
