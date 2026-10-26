import 'reflect-metadata';
import {
  ManagedLifecycleChannelHandle,
  ManagedLifecycleChannelInput,
  ManagedLifecycleStateChange,
  ManagedMcpLifecycleCoordinator,
} from './managed-mcp-lifecycle-coordinator.service';
import { InMemoryManagedMcpLifecycleStore } from './managed-mcp-lifecycle.store';
import {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  ManagedLifecycleApprovalRequest,
  createConfigManagedLifecycleApprovalProvider,
} from './managed-mcp-lifecycle-approval';

const SERVER = '00000000-0000-0000-0000-000000000001';
const ASSET = '00000000-0000-0000-0000-000000000002';
const POLICY_ID = 'recovery-policy';

function config(overrides: Record<string, unknown> = {}) {
  const policy = { version: 1, mode: 'auto', policyId: POLICY_ID, allowedActions: ['start', 'stop'],
    allowedServerIds: [SERVER] };
  const sources = { [ASSET]: policy, ...overrides };
  return { get: (key: string) => key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY ? sources : undefined } as any;
}

function payloadFor(launchId: string, revision = 'r1', digest = 'b'.repeat(64)) {
  return { version: 1, launchId, managedServerId: SERVER, runtimeAssetId: ASSET, inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate-one', verificationRunId: 'run-one', behaviorFingerprint: 'a'.repeat(64),
    transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' },
    openApiData: { openapi: '3.0.3', paths: {} }, trustedOperationBindings: [],
    registrySource: { configId: 'registry', path: 'C:/fixture/registry.json', format: 'json', environment: 'test',
      expectedRevision: revision, expectedContentDigest: digest } } as any;
}

class Deferred<T> {
  promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (error: Error) => void;
  constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject; }); }
  resolve(value: T) { this.resolveFn(value); }
  reject(error: Error) { this.rejectFn(error); }
}

let pidSequence = 7000;
class FakeHandle implements ManagedLifecycleChannelHandle {
  pid = ++pidSequence;
  state: 'handoffAccepted' | 'runtimeReady' = 'handoffAccepted';
  private readonly readyDeferred = new Deferred<any>();
  private readonly closedDeferred = new Deferred<{ code: string }>();
  readonly ready = this.readyDeferred.promise;
  readonly closed = this.closedDeferred.promise;
  closedCalls = 0;
  closedSettled = false;
  constructor(readonly launchId: string, readonly input: ChannelInput) {}
  settleReady(revisions: any = { candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: 'a'.repeat(64), registryRevision: this.input.revision, registryContentDigest: this.input.digest,
    authMode: 'api_key', credentialMode: 'single-hop' }) { this.state = 'runtimeReady'; this.readyDeferred.resolve(revisions); }
  exit(code = 'MANAGED_CHILD_EXITED') { if (!this.closedSettled) { this.closedSettled = true; this.closedDeferred.resolve({ code }); } }
  failReady() { this.readyDeferred.reject(new Error('READY_FAILED')); }
  async close() { this.closedCalls++; this.exit('STOPPED'); }
}

interface ChannelInput extends ManagedLifecycleChannelInput { revision: string; digest: string }

function fakeChannel(options: { ready?: 'now' | 'fail' } = {}) {
  const invocations: ChannelInput[] = [];
  const handles: FakeHandle[] = [];
  const channel = async (input: ManagedLifecycleChannelInput) => {
    const record = { ...input, revision: input.payload.registrySource.expectedRevision,
      digest: input.payload.registrySource.expectedContentDigest } as ChannelInput;
    invocations.push(record);
    const handle = new FakeHandle(input.launchId, record);
    handles.push(handle);
    if (options.ready === 'now') handle.settleReady();
    if (options.ready === 'fail') handle.failReady();
    return handle;
  };
  return { channel, invocations, handles };
}

function captureSequence(payloads = [payloadFor('launch-1')]) {
  let calls = 0;
  const capture = async (_runtimeAssetId: string, _serverId: string) => {
    const payload = payloads[Math.min(calls, payloads.length - 1)];
    calls++;
    return { payload, approvedEnvironmentNames: [], environmentValues: {} };
  };
  return { capture, calls: () => calls };
}

function coordinator(
  store: any,
  overrides: Partial<ConstructorParameters<typeof ManagedMcpLifecycleCoordinator>[0]> = {},
) {
  const channel = fakeChannel({ ready: 'now' });
  const instance = new ManagedMcpLifecycleCoordinator({
    store,
    capture: captureSequence().capture,
    approval: createConfigManagedLifecycleApprovalProvider(config()),
    channel: channel.channel,
    ...overrides,
  });
  return { instance, channel };
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not observed in time');
}

describe('managed lifecycle failure projection and recovery', () => {
  it('projects an unexpected child exit as failed and never leaves a false current', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const changes: ManagedLifecycleStateChange[] = [];
    const { instance, channel } = coordinator(store, { onStateChange: change => changes.push(change) });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(channel.handles).toHaveLength(1);

    channel.handles[0].exit('MANAGED_CHILD_EXITED');
    await waitFor(async () => (await store.read(SERVER)).status === 'valid'
      && (await store.read(SERVER) as any).record.state === 'failed');

    expect(changes).toEqual([{ serverId: SERVER, runtimeAssetId: ASSET, generation: 1,
      state: 'failed', reason: 'runtime_failed', code: 'MANAGED_CHILD_EXITED' }]);
    await expect(instance.status(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'failed', current: false, generation: 1 } });
    expect(instance.ownedGeneration(SERVER)).toBeNull();
    expect(JSON.stringify(await instance.status(SERVER))).not.toContain('running');
  });

  it('restart after failure re-captures a fresh package and requires per-transition approval', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const sequence = captureSequence([payloadFor('launch-1'), payloadFor('launch-2', 'r2', 'd'.repeat(64))]);
    const channel = fakeChannel({ ready: 'now' });
    const approvals: Array<{ action: string; generation: number }> = [];
    const provider = createConfigManagedLifecycleApprovalProvider(config());
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: sequence.capture,
      approval: async (request: ManagedLifecycleApprovalRequest) => {
        approvals.push({ action: request.action, generation: request.generation });
        return provider(request);
      }, channel: channel.channel });

    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await expect(instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' }))
      .resolves.toEqual({ status: 'applied' });
    const restarted = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });

    expect(restarted.generation).toBe(2);
    expect(sequence.calls()).toBe(2);
    expect(channel.invocations[1].launchId).toBe('launch-2');
    expect(channel.invocations[1].payload.launchId).toBe('launch-2');
    expect(channel.invocations[1].payload.registrySource.expectedRevision).toBe('r2');
    expect(approvals.filter(entry => entry.action === 'start').map(entry => entry.generation)).toEqual([1, 2]);
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { generation: 2, state: 'current', current: true } });
    await instance.stop(SERVER);
  });

  it('a denied restart approval never spawns and leaves the failed generation terminal', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const channel = fakeChannel({ ready: 'now' });
    const provider = createConfigManagedLifecycleApprovalProvider(config());
    let calls = 0;
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: async (request: ManagedLifecycleApprovalRequest) => {
        calls++;
        if (request.action === 'start' && calls > 1) return null;
        return provider(request);
      }, channel: channel.channel });

    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_APPROVAL_REJECTED' });
    expect(channel.invocations).toHaveLength(1);
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { state: 'failed', generation: 1, current: false } });
  });

  it('cleans up the spawned handle and reports failure when READY never arrives', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const changes: ManagedLifecycleStateChange[] = [];
    const channel = fakeChannel({ ready: 'fail' });
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel,
      onStateChange: change => changes.push(change) });

    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_CHANNEL_FAILED' });
    expect(channel.handles[0].closedCalls).toBeGreaterThanOrEqual(1);
    expect(instance.ownedGeneration(SERVER)).toBeNull();
    expect(changes).toEqual([{ serverId: SERVER, runtimeAssetId: ASSET, generation: 1,
      state: 'failed', reason: 'runtime_failed', code: 'MANAGED_LIFECYCLE_CHANNEL_FAILED' }]);
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { state: 'failed', current: false } });
    const stored = await store.read(SERVER);
    expect((stored as any).record.terminal).toMatchObject({ reason: 'runtime_failed', code: 'MANAGED_LIFECYCLE_CHANNEL_FAILED' });
  });

  it('rejects stale generation events after a failure/restart and keeps the newest snapshot', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const sequence = captureSequence([payloadFor('launch-1', 'r1', 'b'.repeat(64)), payloadFor('launch-2', 'r2', 'd'.repeat(64))]);
    const { instance, channel } = coordinator(store, { capture: sequence.capture });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });

    await expect(instance.event(SERVER, { generation: 1, type: 'closed', code: 'MANAGED_CHILD_EXITED' }))
      .resolves.toEqual({ status: 'stale' });
    await expect(instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' }))
      .resolves.toEqual({ status: 'stale' });
    expect(channel.invocations).toHaveLength(2);
    const stored = await store.read(SERVER);
    expect((stored as any).record.launchId).toBe('launch-2');
    expect((stored as any).record.snapshot.registryRevision).toBe('r2');
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { generation: 2, state: 'current', current: true } });
  });

  it('marks a parent-crash generation abandoned on reconcile and re-prepares on the next start', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const first = coordinator(store);
    const started = await first.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);
    await first.instance.onModuleDestroy();

    const changes: ManagedLifecycleStateChange[] = [];
    const resumed = coordinator(store, { capture: captureSequence([payloadFor('launch-2')]).capture,
      onStateChange: change => changes.push(change) });
    await expect(resumed.instance.status(SERVER)).resolves.toMatchObject({ view: { state: 'current', current: false } });
    await expect(resumed.instance.reconcile(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'abandoned', current: false, generation: 1 } });
    expect(changes).toEqual([{ serverId: SERVER, runtimeAssetId: ASSET, generation: 1,
      state: 'abandoned', reason: 'unverified_discovered_child', code: null }]);
    const recovered = await resumed.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(recovered.generation).toBe(2);
    expect(resumed.channel.invocations[0].launchId).toBe('launch-2');
    await expect(resumed.instance.status(SERVER)).resolves.toMatchObject({ view: { generation: 2, current: true } });
  });

  it('never serializes handoff payloads, environment values or legacy credentials on failure or restart', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const changes: ManagedLifecycleStateChange[] = [];
    const channel = fakeChannel({ ready: 'now' });
    const capture = async () => ({
      payload: { ...payloadFor('launch-1'), openApiData: { openapi: '3.0.3', marker: 'synthetic-openapi-marker' },
        legacy: { customHeaders: { Authorization: 'Bearer synthetic-legacy-header' } } },
      approvedEnvironmentNames: ['SYNTHETIC_TOKEN'],
      environmentValues: { SYNTHETIC_TOKEN: 'synthetic-env-marker' },
    });
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel,
      onStateChange: change => changes.push(change) });

    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.stop(SERVER);

    const read = await store.read(SERVER);
    const status = await instance.status(SERVER);
    const serialized = JSON.stringify({ changes, read, status });
    for (const marker of ['synthetic-openapi-marker', 'synthetic-env-marker', 'synthetic-legacy-header',
      'openApiData', 'environmentValues']) {
      expect(serialized).not.toContain(marker);
    }
  });
});
