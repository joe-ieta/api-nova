import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import {
  beginRuntimeCall, flushRuntimeAudit, getRuntimeAuditHealth, getRuntimeCallContext, withRuntimeCallContext,
} from './runtime-call-audit';
import { getRuntimeUpstreamAuditHealth, runRuntimeUpstreamAttempt, RuntimeUpstreamAttempt, RuntimeUpstreamObserver } from './runtime-upstream-attempt';

describe('single physical upstream attempt audit adapter', () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  beforeEach(async () => {
    environment = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), 'api-nova-upstream-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
    delete process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES;
    delete process.env.API_NOVA_AUDIT_CAPTURE_BODY;
    delete process.env.API_NOVA_AUDIT_MAX_BODY_BYTES;
  });
  afterEach(async () => {
    await flushRuntimeAudit();
    process.env = environment;
    jest.restoreAllMocks();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('api-nova-upstream-')) {
      throw new Error('Refusing to remove a non-owned test directory');
    }
    await rm(target, { recursive: true, force: true });
  });
  const input = (overrides: Partial<RuntimeUpstreamAttempt> = {}): RuntimeUpstreamAttempt => ({
    context: { transport: 'gateway', requestId: 'request-fixture', identitySource: 'anonymous', runtimeAssetId: 'runtime-a' },
    method: 'POST', url: 'https://upstream.example.invalid/resource', attemptIndex: 1, ...overrides,
  });
  async function records() {
    await flushRuntimeAudit();
    const files = (await readdir(directory)).filter(name => /^calls-v2-.*\.jsonl$/.test(name));
    return (await Promise.all(files.map(name => readFile(join(directory,name),'utf8'))))
      .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  it('records one physical attempt and preserves the exact business return value', async () => {
    const result = { business: 'unchanged' };
    const execute = jest.fn(async (observer: RuntimeUpstreamObserver) => {
      observer.requestChunk(Buffer.from('{"x":1}')); observer.requestComplete();
      observer.responseStarted(200, { 'content-type': 'application/json' });
      observer.responseChunk(Buffer.from('{"ok":true}')); observer.responseComplete();
      return result;
    });
    expect(await runRuntimeUpstreamAttempt(input({ requestContentType:'application/json' }),execute)).toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
    const rows = await records();
    expect(rows.map(row=>row.phase)).toEqual(['started','finished']);
    expect(rows[1]).toMatchObject({ spanKind:'upstream_api',outcome:'success',attemptIndex:1,redirectHopIndex:0,
      byteMeasurement:'observed_body',measurementStage:'upstream_http',statusCode:200 });
    expect(rows[1].request.totalBytes).toBe(7);
    expect(rows[1].response.totalBytes).toBe(11);
  });
  it('isolates simultaneous parent chains across asynchronous callbacks', async () => {
    await Promise.all(['a','b','c'].map(async id => {
      const root = beginRuntimeCall({ transport:'mcp',requestId:id,identitySource:'anonymous' },'tool');
      await withRuntimeCallContext({ ...root.record,parentInvocationId:root.record.invocationId },async()=>{
        await runRuntimeUpstreamAttempt(input({ context:{ transport:'mcp',requestId:id,identitySource:'anonymous' } }),async observer=>{
          await new Promise(resolve=>setTimeout(resolve,1));
          expect(getRuntimeCallContext()?.requestId).toBe(id);
          expect(getRuntimeCallContext()?.parentInvocationId).not.toBe(root.record.invocationId);
          observer.requestComplete(); observer.responseStarted(204); observer.responseComplete();
        });
      });
      await root.finish({outcome:'success'});
    }));
    const rows = (await records()).filter(row=>row.phase==='finished');
    for (const child of rows.filter(row=>row.spanKind==='upstream_api')) {
      const parent = rows.find(row=>row.invocationId===child.parentInvocationId);
      expect(parent.requestId).toBe(child.requestId);
      expect(parent.traceId).toBe(child.traceId);
      expect(parent.rootInvocationId).toBe(child.rootInvocationId);
    }
    expect(getRuntimeCallContext()).toBeUndefined();
  });
  it('represents retry and redirect indices without performing retries itself', async () => {
    let callbacks=0;
    for (const [attemptIndex,redirectHopIndex,status] of [[1,0,302],[1,1,503],[2,0,200]]) {
      await runRuntimeUpstreamAttempt(input({attemptIndex,redirectHopIndex}),async observer=>{
        callbacks++; observer.requestComplete(); observer.responseStarted(status); observer.responseComplete();
      });
    }
    const rows=(await records()).filter(row=>row.phase==='finished');
    expect(callbacks).toBe(3);
    expect(rows.map(row=>[row.attemptIndex,row.redirectHopIndex,row.statusCode])).toEqual([[1,0,302],[1,1,503],[2,0,200]]);
    expect(new Set(rows.map(row=>row.invocationId)).size).toBe(3);
    expect(rows[1].outcome).toBe('error');
  });
  it('redacts URL credentials, vendor headers and recursively structured payload secrets', async () => {
    await runRuntimeUpstreamAttempt(input({
      url:'https://username:never-store-url@upstream.example.invalid/a?api_key=never-store-query&keep=1',
      requestHeaders:{'x-vendor-key':'never-store-header','content-type':'application/json'},
      credentialHeaderNames:['x-vendor-key'],
    }),async observer=>{
      observer.requestChunk('{"password":"never-store-body","child":{"access_token":"never-store-child"}}');
      observer.requestComplete();
      observer.responseStarted(200,{'content-type':'application/json','set-cookie':'never-store-cookie'});
      observer.responseChunk('{"token":"never-store-response"}'); observer.responseComplete();
    });
    const rows=await records();
    expect(JSON.stringify(rows)).not.toContain('never-store');
    expect(rows[1].request.capturedBytes).toBeGreaterThan(0);
    expect(rows[1].request.data).toContain('[REDACTED]');
    expect(rows[0].requestHeaders['x-vendor-key']).toBe('[REDACTED]');
  });
  it('distinguishes observed empty bodies from unobserved bodies', async () => {
    await runRuntimeUpstreamAttempt(input(),async observer=>{
      observer.requestComplete(); observer.responseStarted(204); observer.responseComplete();
    });
    await runRuntimeUpstreamAttempt(input(),async()=>undefined);
    const rows=(await records()).filter(row=>row.phase==='finished');
    expect(rows[0].request.state).toBe('empty');
    expect(rows[0].response.state).toBe('empty');
    expect(rows[1].request).toBeUndefined();
    expect(rows[1].response).toBeUndefined();
    expect(rows[1].outcome).toBe('unknown');
  });
  it('preserves interrupted byte counts without storing unsafe JSON fragments', async () => {
    const error=Object.assign(new Error('private-error-message'),{code:'ECONNRESET'});
    await expect(runRuntimeUpstreamAttempt(input(),async observer=>{
      observer.requestComplete(); observer.responseStarted(200,{'content-type':'application/json'});
      observer.responseChunk('{"password":"never-store');
      throw error;
    })).rejects.toBe(error);
    const row=(await records()).find(row=>row.phase==='finished');
    expect(row).toMatchObject({outcome:'error',errorCategory:'connection',failureStage:'response'});
    expect(row.response).toMatchObject({state:'incomplete',reason:'stream_interrupted',capturedBytes:0});
    expect(row.response.totalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toMatch(/never-store|private-error-message/);
  });
  it.each([
    ['ETIMEDOUT','timeout','timeout'],['ABORT_ERR','cancelled','cancelled'],
    ['ENOTFOUND','error','dns'],['CERT_HAS_EXPIRED','error','tls'],['ECONNREFUSED','error','connection'],
  ])('classifies %s while rethrowing the same business error',async(code,outcome,errorCategory)=>{
    const error=Object.assign(new Error('do-not-log-error-message'),{code});
    const execute=jest.fn(async()=>{throw error;});
    await expect(runRuntimeUpstreamAttempt(input(),execute)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    const row=(await records()).find(row=>row.phase==='finished');
    expect(row).toMatchObject({outcome,errorCategory,failureStage:'connect'});
    expect(JSON.stringify(row)).not.toContain('do-not-log-error-message');
  });
  it('a resolved callback without a response end remains incomplete',async()=>{
    await runRuntimeUpstreamAttempt(input(),async observer=>{
      observer.responseStarted(200,{'content-type':'text/plain'}); observer.responseChunk('partial');
    });
    const row=(await records()).find(row=>row.phase==='finished');
    expect(row.outcome).toBe('incomplete');
    expect(row.response.state).toBe('incomplete');
    expect(row.response.data).toBeUndefined();
  });
  it('releases capture memory and keeps byte totals when the capture budget is exceeded',async()=>{
    process.env.API_NOVA_AUDIT_MEMORY_BUDGET_BYTES='8192';
    await runRuntimeUpstreamAttempt(input({requestContentType:'text/plain'}),async observer=>{
      observer.requestChunk('x'.repeat(10000)); observer.requestComplete();
      observer.responseStarted(204); observer.responseComplete();
    });
    const row=(await records()).find(row=>row.phase==='finished');
    expect(row.request).toMatchObject({state:'omitted',reason:'capture_budget',totalBytes:10000});
    expect(getRuntimeAuditHealth().captureMemoryBytes).toBe(0);
    expect(getRuntimeAuditHealth().pendingWriteBytes).toBe(0);
  });
  it('does not let filesystem failure change the business result or print secrets to stdout',async()=>{
    const blocked=join(directory,'not-a-directory'); await writeFile(blocked,'owned fixture');
    process.env.API_NOVA_AUDIT_DIR=blocked;
    const stdout=jest.spyOn(process.stdout,'write').mockReturnValue(true);
    const stderr=jest.spyOn(process.stderr,'write').mockReturnValue(true);
    const before=getRuntimeAuditHealth().writeFailures;
    const result={ok:true};
    const execute=jest.fn(async (observer: RuntimeUpstreamObserver)=>{
      observer.requestChunk('password=never-print'); observer.requestComplete();
      observer.responseStarted(204); observer.responseComplete();
      return result;
    });
    expect(await runRuntimeUpstreamAttempt(input(),execute)).toBe(result);
    await flushRuntimeAudit();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getRuntimeAuditHealth().writeFailures).toBeGreaterThan(before);
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('never-print');
    expect(getRuntimeAuditHealth().activeCalls).toBe(0);
  });
  it('capture instrumentation errors cannot prevent the physical callback from running',async()=>{
    const before=getRuntimeUpstreamAuditHealth().instrumentationFailures;
    const circular:any={}; circular.self=circular;
    const execute=jest.fn(async()=>({ok:true}));
    await expect(runRuntimeUpstreamAttempt(input({requestHeaders:circular}),execute)).resolves.toEqual({ok:true});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getRuntimeUpstreamAuditHealth().instrumentationFailures).toBeGreaterThan(before);
    expect(getRuntimeAuditHealth().activeCalls).toBe(0);
  });
  it('ignores late stream observations after completion without leaking capture memory',async()=>{
    let late:any;
    await runRuntimeUpstreamAttempt(input(),async observer=>{
      late=observer; observer.requestComplete(); observer.responseStarted(204); observer.responseComplete();
    });
    late.requestChunk('late-secret'); late.responseChunk('late-secret'); late.responseComplete();
    const rows=await records();
    expect(JSON.stringify(rows)).not.toContain('late-secret');
    expect(rows.filter(row=>row.phase==='finished')).toHaveLength(1);
    expect(getRuntimeAuditHealth().captureMemoryBytes).toBe(0);
  });
});
