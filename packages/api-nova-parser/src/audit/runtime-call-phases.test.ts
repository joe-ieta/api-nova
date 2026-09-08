import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginRuntimeCall, createAuditBodyTracker, captureAuditBody, flushRuntimeAudit,
  getRuntimeAuditHealth, withRuntimeCallContext } from './runtime-call-audit';
import { normalizeRuntimeAuditRecord, summarizeInvocations } from './runtime-observability-contract';

describe('runtime audit v2 producer', () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  beforeEach(async () => {
    environment = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), 'api-nova-v2-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
    delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
    delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
  });
  afterEach(async () => {
    await flushRuntimeAudit();
    process.env = environment;
    await rm(directory, { recursive: true, force: true });
  });
  async function records() {
    await flushRuntimeAudit();
    const files = (await readdir(directory)).filter(name => name.startsWith('calls-v2-'));
    return (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8'))))
      .flatMap(body => body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  it('persists start, progress and exactly one completion with distinct event IDs', async () => {
    const call = beginRuntimeCall({ transport: 'gateway', requestId: 'req-1', identitySource: 'anonymous' }, 'admission');
    await call.progress();
    await call.finish({ outcome: 'success' });
    await call.finish({ outcome: 'error' });
    const rows = await records();
    expect(rows.map(row => row.phase)).toEqual(['started', 'progress', 'finished']);
    expect(new Set(rows.map(row => row.invocationId)).size).toBe(1);
    expect(new Set(rows.map(row => row.eventId)).size).toBe(3);
    expect(rows.map(row => row.recordVersion)).toEqual([1, 2, 3]);
    expect(rows[2].sourceSequence).toBeGreaterThan(rows[1].sourceSequence);
    const summary = summarizeInvocations(rows.map(row => normalizeRuntimeAuditRecord(row)), 'business');
    expect(summary).toMatchObject({ totalStarted: 1, knownCompleted: 1, failures: 0 });
  });
  it('does not permit finish fields to replace immutable IDs or forge a source phase', async () => {
    const call = beginRuntimeCall({ transport: 'mcp', requestId: 'req-2', identitySource: 'anonymous' }, 'tool');
    const id = call.record.invocationId;
    await call.finish({ invocationId: 'forged', requestId: 'forged', phase: 'started', outcome: 'success' });
    const rows = await records();
    expect(rows[1]).toMatchObject({ invocationId: id, requestId: 'req-2', phase: 'finished', spanKind: 'mcp_tool' });
  });
  it('propagates the explicit root and parent while deriving the child boundary from its kind', async () => {
    const root = beginRuntimeCall({ transport: 'mcp', requestId: 'root', identitySource: 'anonymous' }, 'tool');
    await withRuntimeCallContext({ ...root.record, parentInvocationId: root.record.invocationId }, async () => {
      const child = beginRuntimeCall({ ...root.record, parentInvocationId: root.record.invocationId }, 'api');
      expect(child.record.spanKind).toBe('upstream_api');
      expect(child.record.traceId).toBe(root.record.traceId);
      await child.finish({ outcome: 'success' });
    });
    await root.finish({ outcome: 'success' });
    const finished = (await records()).filter(row => row.phase === 'finished');
    expect(finished[0].parentInvocationId).toBe(finished[1].invocationId);
  });
  it('budgets concurrent capture and keeps observed byte counts when content is omitted', () => {
    process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES = '1024';
    const a = createAuditBodyTracker('text/plain');
    const b = createAuditBodyTracker('text/plain');
    a.observe('a'.repeat(200));
    b.observe('b'.repeat(200));
    expect(b.finish()).toMatchObject({ state: 'omitted', reason: 'capture_budget', totalBytes: 200 });
    expect(a.finish().data).toBe('a'.repeat(200));
    expect(getRuntimeAuditHealth().captureMemoryBytes).toBe(0);
  });
  it('copies observed mutable buffers so later reuse cannot corrupt evidence', () => {
    const data = Buffer.from('original');
    const tracker = createAuditBodyTracker('text/plain');
    tracker.observe(data);
    data.fill(120);
    expect(tracker.finish().data).toBe('original');
  });
  it('tracks bytes even when the explicit metadata-only policy omits the body', () => {
    process.env.API_NOVA_AUDIT_CAPTURE_BODY = 'metadata';
    expect(captureAuditBody('private-body', 'text/plain')).toMatchObject({
      state: 'omitted', reason: 'policy', totalBytes: 12, capturedBytes: 0,
    });
  });
  it('does not let circular diagnostic values break the business call', () => {
    const value: any = {}; value.self = value;
    expect(captureAuditBody(value)).toMatchObject({ state: 'omitted', reason: 'capture_error' });
    expect(getRuntimeAuditHealth().captureMemoryBytes).toBe(0);
  });
});
