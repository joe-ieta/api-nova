import fs = require('node:fs/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntimeCall, flushRuntimeAudit, getRuntimeAuditHealth, RuntimeCallRecord } from './runtime-call-audit';

const record = (sourceSequence: number, fields: Partial<RuntimeCallRecord> = {}): RuntimeCallRecord => ({
  schemaVersion: 2, sourceSequence, sequence: sourceSequence, sourceInstanceId: 'source', processId: 'process',
  invocationId: `invocation-${sourceSequence}`, eventId: `event-${sourceSequence}`, requestId: `request-${sourceSequence}`,
  transport: 'gateway', serverType: 'gateway', identitySource: 'anonymous', spanKind: 'gateway_request',
  phase: 'finished', recordVersion: 2, kind: 'admission', startedAt: '2026-10-08T00:00:00.000Z', ...fields,
});

describe('bounded runtime audit writer', () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  beforeEach(async () => {
    environment = { ...process.env };
    directory = await fs.mkdtemp(join(tmpdir(), 'api-nova-writer-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
    delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
    jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    await flushRuntimeAudit();
    jest.restoreAllMocks();
    process.env = environment;
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function rows() {
    const files = (await fs.readdir(directory)).filter(name => name.startsWith('calls-v2-'));
    return (await Promise.all(files.map(file => fs.readFile(join(directory, file), 'utf8'))))
      .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  it('coalesces 3000 real-file records without gaps, preserving manifest-before-data and caller snapshots', async () => {
    const before = getRuntimeAuditHealth();
    const originalAppend = fs.appendFile;
    const append = jest.spyOn(fs, 'appendFile').mockImplementation(async (...args: Parameters<typeof fs.appendFile>) => {
      const manifest = JSON.parse(await fs.readFile(join(directory, `source-v2-${before.processId}.json`), 'utf8'));
      expect(manifest.sourceInstanceId).toBe(before.processId);
      return originalAppend(...args);
    });
    const pending = Array.from({ length: 3000 }, (_, index) => {
      const item = record(index + 1, { identitySource: 'authenticated', callerId: `caller-${index + 1}` });
      const result = writeRuntimeCall(item);
      item.callerId = 'mutated-after-enqueue';
      return result;
    });
    await flushRuntimeAudit();
    await Promise.all(pending);
    expect((await rows()).map(row => row.sourceSequence)).toEqual(Array.from({ length: 3000 }, (_, index) => index + 1));
    const callers = (await fs.readFile(join(directory, `callers-${before.processId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(callers.map(row => row.callerId)).toEqual(Array.from({ length: 3000 }, (_, index) => `caller-${index + 1}`));
    expect(append).toHaveBeenCalledTimes(48);
    const after = getRuntimeAuditHealth();
    expect(after.writtenRecords - before.writtenRecords).toBe(3000);
    expect(after.writtenBatches - before.writtenBatches).toBe(24);
    expect(after).toMatchObject({ pendingWrites: 0, pendingWriteBytes: 0 });
    expect(after.droppedRecords).toBe(before.droppedRecords);
  });
  it('enforces both the 128 record and 256 KiB batch targets without splitting JSON lines', async () => {
    const append = jest.spyOn(fs, 'appendFile');
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeRuntimeCall(record(index + 1, { path: 'x'.repeat(4000) }))));
    for (const call of append.mock.calls) {
      const text = String(call[1]);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
      const batch = text.trim().split('\n').map(line => JSON.parse(line));
      expect(batch.length).toBeLessThanOrEqual(128);
    }
    expect((await rows()).length).toBe(300);
  });
  it('allows one budgeted large record above the batch target and then continues the next batch', async () => {
    const append = jest.spyOn(fs, 'appendFile');
    await Promise.all([writeRuntimeCall(record(1, { path: 'x'.repeat(300000) })), writeRuntimeCall(record(2))]);
    expect(append).toHaveBeenCalledTimes(2);
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 2]);
  });
  it('keeps the 4096 queue bound and reports queue drops separately', async () => {
    const before = getRuntimeAuditHealth();
    const pending = Array.from({ length: 4097 }, (_, index) => writeRuntimeCall(record(index + 1)));
    expect(getRuntimeAuditHealth().pendingWrites).toBe(4096);
    await Promise.all(pending);
    const after = getRuntimeAuditHealth();
    expect(after.queueDroppedRecords - before.queueDroppedRecords).toBe(1);
    expect(after.budgetDroppedRecords).toBe(before.budgetDroppedRecords);
    expect(after.pendingWritesHighWater).toBe(4096);
    expect((await rows()).length).toBe(4096);
  });
  it('reports budget and serialization failures separately and retains bounded body omission', async () => {
    const before = getRuntimeAuditHealth();
    process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES = '1024';
    await writeRuntimeCall(record(1, { path: 'x'.repeat(1000) }));
    const cyclic: any = {}; cyclic.self = cyclic;
    await writeRuntimeCall(record(2, { requestHeaders: cyclic }));
    process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES = '16384';
    await writeRuntimeCall(record(3, { response: { contentType: 'text/plain', data: 'x'.repeat(10000),
      totalBytes: 10000, capturedBytes: 10000, sha256: 'digest', state: 'complete', redacted: false } }));
    const after = getRuntimeAuditHealth();
    expect(after.budgetDroppedRecords - before.budgetDroppedRecords).toBe(1);
    expect(after.serializationDroppedRecords - before.serializationDroppedRecords).toBe(1);
    expect(after.droppedRecords - before.droppedRecords).toBe(2);
    expect(await rows()).toEqual([expect.objectContaining({ sourceSequence: 3,
      response: expect.objectContaining({ state: 'omitted', reason: 'capture_budget', totalBytes: 10000, capturedBytes: 0 }) })]);
  });
  it('counts failed record batches without replaying an unknown append prefix and recovers next batch', async () => {
    const before = getRuntimeAuditHealth();
    const originalAppend = fs.appendFile;
    jest.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args: Parameters<typeof fs.appendFile>) => {
      await originalAppend(args[0], String(args[1]).split('\n')[0] + '\n', args[2]);
      throw Object.assign(new Error('injected partial append'), { code: 'EIO' });
    });
    await Promise.all([writeRuntimeCall(record(1)), writeRuntimeCall(record(2))]);
    await writeRuntimeCall(record(3));
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 3]);
    const after = getRuntimeAuditHealth();
    expect(after.ioFailedRecords - before.ioFailedRecords).toBe(2);
    expect(after.writeFailures - before.writeFailures).toBe(2);
    expect(after.writtenRecords - before.writtenRecords).toBe(1);
    expect(after).toMatchObject({ pendingWrites: 0, pendingWriteBytes: 0 });
  });
  it('reports caller I/O independently while retaining calls and resumes without duplicating old calls', async () => {
    const before = getRuntimeAuditHealth();
    const callerPath = join(directory, `callers-${before.processId}.jsonl`);
    await fs.mkdir(callerPath);
    await writeRuntimeCall(record(1, { identitySource: 'authenticated', callerId: 'caller-1' }));
    await fs.rmdir(callerPath);
    await writeRuntimeCall(record(2, { identitySource: 'authenticated', callerId: 'caller-2' }));
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 2]);
    expect(JSON.parse((await fs.readFile(callerPath, 'utf8')).trim()).callerId).toBe('caller-2');
    const after = getRuntimeAuditHealth();
    expect(after.callerWriteFailures - before.callerWriteFailures).toBe(1);
    expect(after.ioFailedRecords).toBe(before.ioFailedRecords);
    expect(after.writtenRecords - before.writtenRecords).toBe(2);
  });
  it('retains fail-open manifest failure evidence and retries publication on a later batch', async () => {
    const before = getRuntimeAuditHealth();
    const manifestPath = join(directory, `source-v2-${before.processId}.json`);
    await fs.writeFile(manifestPath, '{}');
    await writeRuntimeCall(record(1));
    await fs.unlink(manifestPath);
    await writeRuntimeCall(record(2));
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 2]);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).sourceInstanceId).toBe(before.processId);
    expect(getRuntimeAuditHealth().sourceManifestFailures - before.sourceManifestFailures).toBe(1);
  });
  it('does not strand records enqueued by completion callbacks or allow flush to overtake them', async () => {
    const pending = writeRuntimeCall(record(1)).then(() => writeRuntimeCall(record(2)))
      .then(() => writeRuntimeCall(record(3)));
    await flushRuntimeAudit();
    await pending;
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 2, 3]);
    expect(getRuntimeAuditHealth()).toMatchObject({ pendingWrites: 0, pendingWriteBytes: 0 });
  });
  it('keeps directory changes ordered and republishes each destination before its calls', async () => {
    const alternate = join(directory, 'alternate');
    const append = jest.spyOn(fs, 'appendFile');
    const first = writeRuntimeCall(record(1));
    process.env.API_NOVA_AUDIT_DIR = alternate;
    const second = writeRuntimeCall(record(2));
    process.env.API_NOVA_AUDIT_DIR = directory;
    const third = writeRuntimeCall(record(3));
    await Promise.all([first, second, third]);
    expect(append.mock.calls.map(call => JSON.parse(String(call[1]).trim()).sourceSequence)).toEqual([1, 2, 3]);
    expect((await rows()).map(row => row.sourceSequence)).toEqual([1, 3]);
    const manifest = join(alternate, 'source-v2-' + getRuntimeAuditHealth().processId + '.json');
    expect(JSON.parse(await fs.readFile(manifest, 'utf8')).sourceInstanceId).toBe(getRuntimeAuditHealth().processId);
  });
  it('invalidates the directory cache on filesystem failure and recreates it for subsequent evidence', async () => {
    const before = getRuntimeAuditHealth();
    await writeRuntimeCall(record(1));
    await fs.rm(directory, { recursive: true });
    await writeRuntimeCall(record(2));
    await writeRuntimeCall(record(3));
    expect((await rows()).map(row => row.sourceSequence)).toEqual([3]);
    expect(getRuntimeAuditHealth().ioFailedRecords - before.ioFailedRecords).toBe(1);
  });
});
