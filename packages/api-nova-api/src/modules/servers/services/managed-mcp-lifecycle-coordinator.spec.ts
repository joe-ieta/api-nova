import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RuntimePipelineStateEntity } from '../../../database/entities/runtime-call-observability.entity';
import {
  MANAGED_MCP_LIFECYCLE_PREFIX,
  ManagedMcpLifecycleError,
  managedLifecycleSnapshotDigest,
  parseManagedLifecycleDecision,
  parseManagedLifecycleRecord,
  trustedLifecycleText,
} from './managed-mcp-lifecycle.contract';
import {
  DataSourceManagedMcpLifecycleStore,
  InMemoryManagedMcpLifecycleStore,
} from './managed-mcp-lifecycle.store';
import {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  createConfigManagedLifecycleApprovalProvider,
} from './managed-mcp-lifecycle-approval';
import {
  ManagedLifecycleChannelInput,
  ManagedLifecycleChannelHandle,
  ManagedMcpLifecycleCoordinator,
  readManagedMcpLifecycleStatus,
} from './managed-mcp-lifecycle-coordinator.service';

const SERVER = '00000000-0000-0000-0000-000000000001';
const ASSET = '00000000-0000-0000-0000-000000000002';
const OTHER_ASSET = '00000000-0000-0000-0000-000000000003';
const POLICY_ID = 'policy-one';

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

let pidSequence = 5000;
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

function fakeChannel(options: { ready?: 'now' | 'pending' | 'fail' } = {}) {
  const invocations: ChannelInput[] = [];
  const handles: FakeHandle[] = [];
  const channel = async (input: ManagedLifecycleChannelInput) => {
    const record = { ...input, revision: input.payload.registrySource.expectedRevision, digest: input.payload.registrySource.expectedContentDigest } as ChannelInput;
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

function coordinator(store: any, overrides: Partial<ConstructorParameters<typeof ManagedMcpLifecycleCoordinator>[0]> = {}) {
  const channel = fakeChannel({ ready: 'now' });
  const instance = new ManagedMcpLifecycleCoordinator({
    store,
    capture: captureSequence().capture,
    approval: createConfigManagedLifecycleApprovalProvider(config()),
    channel: channel.channel,
    now: () => new Date(),
    ...overrides,
  });
  return { instance, channel };
}

describe('managed lifecycle contract', () => {
  it('rejects a persisted current record without valid start decision evidence', () => {
    const snapshot = { runtimeAssetId: ASSET, candidateRevision: 'candidate-one', verificationRunId: 'run-one',
      behaviorFingerprint: 'a'.repeat(64), registryRevision: 'r1', registryContentDigest: 'b'.repeat(64), inboundAuthMode: 'private_api_key' as const };
    const valid = {
      version: 1, serverId: SERVER, runtimeAssetId: ASSET, generation: 1, state: 'current', launchId: 'launch-1',
      pid: 10, snapshot, startDecision: null, stopDecision: null, terminal: null, currentVerified: true, decisions: [],
      updatedAt: new Date().toISOString(),
    };
    expect(parseManagedLifecycleRecord(valid)).toBeNull();
    const decision = parseManagedLifecycleDecision({
      version: 1, decisionId: randomUUID(), action: 'start', approvalMode: 'auto',
      approvedBy: `auto:${POLICY_ID}`, policyId: POLICY_ID, policyDigest: 'c'.repeat(64), approvedAt: new Date().toISOString(),
      generation: 1, snapshotDigest: managedLifecycleSnapshotDigest(snapshot),
    });
    expect(decision).not.toBeNull();
    expect(parseManagedLifecycleRecord({ ...valid, startDecision: decision, decisions: [decision] })).not.toBeNull();
    expect(parseManagedLifecycleRecord({ ...valid, startDecision: { ...decision, generation: 2 }, decisions: [decision] })).toBeNull();
  });

  it('parses approval policy config strictly and fails closed for missing or invalid entries', async () => {
    const provider = createConfigManagedLifecycleApprovalProvider(config(), { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const decision = await provider(request());
    expect(decision).toMatchObject({ action: 'start', approvalMode: 'auto', policyId: POLICY_ID,
      approvedBy: `auto:${POLICY_ID}`, generation: 1 });
    expect(decision!.snapshotDigest).toBe(managedLifecycleSnapshotDigest(request().snapshot!));
    expect(await provider({ ...request(), serverId: '00000000-0000-0000-0000-000000000099' })).toBeNull();
    expect(await provider({ ...request(), action: 'stop', snapshot: null })).toBeNull();
    expect(await provider({ ...request(), runtimeAssetId: OTHER_ASSET })).toBeNull();
  });

  function request() {
    const snapshot = { runtimeAssetId: ASSET, candidateRevision: 'candidate-one', verificationRunId: 'run-one',
      behaviorFingerprint: 'a'.repeat(64), registryRevision: 'r1', registryContentDigest: 'b'.repeat(64),
      inboundAuthMode: 'private_api_key' as const };
    return { action: 'start' as const, serverId: SERVER, runtimeAssetId: ASSET, generation: 1, snapshot };
  }
});

describe('managed lifecycle store (real SQL.js)', () => {
  let dataSource: DataSource;
  const open = async (database?: Uint8Array) => {
    dataSource = await new DataSource({ type: 'sqljs', database, synchronize: database === undefined,
      entities: [RuntimePipelineStateEntity] }).initialize();
    return new DataSourceManagedMcpLifecycleStore(dataSource);
  };
  afterEach(async () => { if (dataSource?.isInitialized) await dataSource.destroy(); });

  it('compare-and-swap rejects stale writers and survives a database reopen', async () => {
    const store = await open();
    const { instance, channel } = coordinator(store);
    const started = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);
    const firstRead = await store.read(SERVER);
    expect(firstRead.status).toBe('valid');
    expect((firstRead as any).record.state).toBe('current');
    expect((firstRead as any).record.snapshot.runtimeAssetId).toBe(ASSET);
    expect((firstRead as any).record.decisions).toHaveLength(1);
    expect((firstRead as any).record.startDecision.snapshotDigest).toBe(managedLifecycleSnapshotDigest((firstRead as any).record.snapshot));

    const stale = await store.compareAndSwap(SERVER, 'stale-token', (firstRead as any).record);
    expect(stale).toEqual({ status: 'conflict' });

    const bytes = (dataSource.driver as any).export();
    await dataSource.destroy();
    const reopened = await open(bytes);
    const reopenedCoordinator = new ManagedMcpLifecycleCoordinator({ store: reopened,
      capture: captureSequence([payloadFor('launch-2')]).capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel });
    const status = await reopenedCoordinator.status(SERVER);
    expect(status).toMatchObject({ status: 'observed', view: { generation: 1, state: 'current', current: false } });
    await expect(reopenedCoordinator.reconcile(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'abandoned', current: false, generation: 1 } });
    const restarted = await reopenedCoordinator.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(restarted.generation).toBe(2);
    expect(await reopenedCoordinator.status(SERVER)).toMatchObject({ view: { state: 'current', current: true, generation: 2 } });
  });

  it('treats a corrupted persisted record as invalid rather than current', async () => {
    const store = await open();
    await store.compareAndSwap(SERVER, null, { version: 1 } as any);
    const read = await store.read(SERVER);
    expect(read.status).toBe('invalid');
    const { instance } = coordinator(store);
    await expect(instance.status(SERVER)).resolves.toEqual({ status: 'invalid', serverId: SERVER, current: false });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_INVALID_RECORD' });
  });
});

describe('managed lifecycle coordinator', () => {
  it('keeps generation monotonic across coordinator restarts and never treats a discovered child as current', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const first = coordinator(store);
    const started = await first.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);
    await expect(first.instance.stop(SERVER)).resolves.toEqual({ status: 'stopped', generation: 1 });
    expect(first.channel.handles[0].closedCalls).toBe(1);

    const second = coordinator(store, { capture: captureSequence([payloadFor('launch-2')]).capture });
    const restarted = await second.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(restarted.generation).toBe(2);
    await expect(second.instance.stop(SERVER)).resolves.toEqual({ status: 'stopped', generation: 2 });

    const third = coordinator(store, { capture: captureSequence([payloadFor('launch-3')]).capture });
    const thirdStart = await third.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(thirdStart.generation).toBe(3);

    const discovered = coordinator(store, { capture: captureSequence([payloadFor('launch-4')]).capture });
    await expect(discovered.instance.status(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'current', current: false, generation: 3 } });
    await expect(discovered.instance.reconcile(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'abandoned', current: false, generation: 3 } });
    const afterDiscovery = await discovered.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(afterDiscovery.generation).toBe(4);
  });

  it('captures a fresh snapshot per start and persists the matching approval decision', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const sequence = captureSequence([payloadFor('launch-1', 'r1', 'b'.repeat(64)), payloadFor('launch-2', 'r2', 'd'.repeat(64))]);
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: sequence.capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: fakeChannel({ ready: 'now' }).channel });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.stop(SERVER);
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(sequence.calls()).toBe(2);
    const read = await instance.status(SERVER);
    expect(read).toMatchObject({ status: 'observed', view: { generation: 2, state: 'current', current: true } });
    const stored = await store.read(SERVER);
    expect((stored as any).record.snapshot.registryRevision).toBe('r2');
    expect((stored as any).record.startDecision.generation).toBe(2);
    expect((stored as any).record.stopDecision).toBeNull();
    expect((stored as any).record.decisions.map((decision: any) => decision.action)).toEqual(['start', 'stop', 'start']);
    expect((stored as any).record.decisions.filter((decision: any) => decision.action === 'stop')[0].generation).toBe(1);
    expect((stored as any).record.decisions).toHaveLength(3);
    for (const decision of (stored as any).record.decisions) {
      expect(trustedLifecycleText(decision.policyId, 160)).toBe(true);
      expect(decision.snapshotDigest).toHaveLength(64);
    }
  });

  it('rejects stale generation events from a superseded child', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence([payloadFor('launch-1'), payloadFor('launch-2')]).capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: fakeChannel({ ready: 'now' }).channel });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.event(SERVER, { generation: 1, type: 'closed', code: 'MANAGED_CHILD_EXITED' });
    expect(await instance.status(SERVER)).toMatchObject({ view: { state: 'failed', current: false, generation: 1 } });
    const second = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(second.generation).toBe(2);
    await expect(instance.event(SERVER, { generation: 1, type: 'closed', code: 'STOPPED' })).resolves.toEqual({ status: 'stale' });
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { generation: 2, state: 'current', current: true } });
    await expect(instance.event(SERVER, { generation: 9, type: 'failed' })).resolves.toEqual({ status: 'stale' });
  });

  it('fails closed before capture or spawn when approval evidence is missing or invalid', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const noPolicy = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: async () => null, channel: fakeChannel({ ready: 'now' }).channel });
    await expect(noPolicy.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_APPROVAL_REJECTED' });
    await expect(noPolicy.stop(SERVER)).resolves.toEqual({ status: 'already-stopped', generation: 0 });

    const channel = fakeChannel({ ready: 'now' });
    const wrongGeneration = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: async request => {
        const good = (await createConfigManagedLifecycleApprovalProvider(config())(request))!;
        return { ...good, generation: good.generation + 1 };
      }, channel: channel.channel });
    await expect(wrongGeneration.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_APPROVAL_REJECTED' });
    expect(channel.invocations).toHaveLength(0);
    expect((await store.read(SERVER)).status).toBe('absent');
  });

  it('stop is idempotent and terminal generations are not confused with the next start', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const { instance, channel } = coordinator(store);
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await expect(instance.stop(SERVER)).resolves.toEqual({ status: 'stopped', generation: 1 });
    await expect(instance.stop(SERVER)).resolves.toEqual({ status: 'already-stopped', generation: 1 });
    expect(channel.handles[0].closedCalls).toBe(1);
    const read = await instance.status(SERVER);
    expect(read).toMatchObject({ view: { state: 'stopped', current: false, generation: 1 } });
    const stored = (await store.read(SERVER) as any).record;
    expect(stored.decisions.map((decision: any) => decision.action)).toEqual(['start', 'stop']);
    const restart = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(restart.generation).toBe(2);
    await instance.stop(SERVER);
    await expect(instance.stop(SERVER)).resolves.toEqual({ status: 'already-stopped', generation: 2 });
  });

  it('leaves no false current when the parent crashes mid-transition', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const crash = fakeChannel({ ready: 'pending' });
    const crashing = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence([payloadFor('launch-crash')]).capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: crash.channel });
    const inFlight = crashing.start({ serverId: SERVER, runtimeAssetId: ASSET });
    inFlight.catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt++) {
      const read = await store.read(SERVER);
      if (read.status === 'valid' && read.record.state === 'starting') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await expect(crashing.status(SERVER)).resolves.toMatchObject({ view: { state: 'starting', current: false, generation: 1 } });

    const resumed = coordinator(store, { capture: captureSequence([payloadFor('launch-next')]).capture });
    await expect(resumed.instance.reconcile(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'abandoned', current: false, generation: 1 } });
    const recovered = await resumed.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(recovered.generation).toBe(2);
    expect(crash.invocations).toHaveLength(1);
  });

  it('concurrent start attempts produce a single winner', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const channel = fakeChannel({ ready: 'now' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let captures = 0;
    const capture = async (_runtimeAssetId: string, _serverId: string) => {
      captures++;
      if (captures === 2) release();
      await gate;
      return { payload: payloadFor(`launch-${captures}`), approvedEnvironmentNames: [], environmentValues: {} };
    };
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel });
    const results = await Promise.allSettled([
      instance.start({ serverId: SERVER, runtimeAssetId: ASSET }),
      instance.start({ serverId: SERVER, runtimeAssetId: ASSET }),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ManagedMcpLifecycleError);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('MANAGED_LIFECYCLE_CONFLICT');
    expect(channel.invocations).toHaveLength(1);
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { generation: 1, state: 'current', current: true } });
  });

  it('records a runtime failure without marking the generation current when READY fails', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const channel = fakeChannel({ ready: 'fail' });
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_CHANNEL_FAILED' });
    await expect(instance.status(SERVER)).resolves.toMatchObject({ view: { state: 'failed', current: false, generation: 1 } });
    expect((await store.read(SERVER) as any).record.terminal.reason).toBe('runtime_failed');
  });

  it('rejects invalid rows and mismatched runtime assets without spawning', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    store.putInvalidForTest(SERVER, { version: 1, state: 'current' });
    const channel = fakeChannel({ ready: 'now' });
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence().capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel });
    await expect(instance.reconcile(SERVER)).resolves.toEqual({ status: 'invalid', serverId: SERVER, current: false });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_INVALID_RECORD' });
    expect(channel.invocations).toHaveLength(0);
  });

  it('redacts nothing into public status: no environment values or openapi payload fields leak', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const { instance } = coordinator(store);
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const status = await instance.status(SERVER);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('openApiData');
    expect(serialized).not.toContain('environmentValues');
    expect(serialized).not.toContain(MANAGED_MCP_LIFECYCLE_PREFIX);
  });
});

describe('cross-process coordination over a shared store', () => {
  it('fails closed for a foreign current generation and projects its registry identity and approval', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const owner = coordinator(store);
    const started = await owner.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);

    const foreign = coordinator(store, { capture: captureSequence([payloadFor('foreign')]).capture });
    await expect(foreign.instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_FOREIGN_CURRENT' });
    await expect(foreign.instance.stop(SERVER))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_FOREIGN_CURRENT' });
    expect(foreign.channel.invocations).toHaveLength(0);

    const observed = await readManagedMcpLifecycleStatus(store, SERVER);
    expect(observed).toMatchObject({ status: 'observed', view: { generation: 1, state: 'current', current: false,
      currentVerified: true, snapshotDigest: managedLifecycleSnapshotDigest(started.snapshot),
      snapshot: { registryRevision: 'r1', registryContentDigest: 'b'.repeat(64) },
      startDecision: { action: 'start', generation: 1 } } });
    await expect(owner.instance.status(SERVER)).resolves.toMatchObject({ view: { current: true, currentVerified: true } });
    await owner.instance.stop(SERVER);
  });

  it('does not claim a foreign in-flight start and rejects its lifecycle events', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const pending = fakeChannel({ ready: 'pending' });
    const owner = new ManagedMcpLifecycleCoordinator({ store, capture: captureSequence([payloadFor('launch-pending')]).capture,
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: pending.channel });
    const inFlight = owner.start({ serverId: SERVER, runtimeAssetId: ASSET });
    inFlight.catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt++) {
      const read = await store.read(SERVER);
      if (read.status === 'valid' && read.record.state === 'starting') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const foreign = coordinator(store, { capture: captureSequence([payloadFor('foreign')]).capture });
    await expect(foreign.instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_FOREIGN_CURRENT' });
    await expect(foreign.instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' }))
      .resolves.toEqual({ status: 'rejected' });
    expect(foreign.channel.invocations).toHaveLength(0);
    await expect(foreign.instance.status(SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { state: 'starting', currentVerified: false, current: false } });
    pending.handles[0].settleReady();
    await expect(inFlight).resolves.toMatchObject({ generation: 1 });
    await owner.stop(SERVER);
  });

  it('rejects a foreign failure event for an owned current generation', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const owner = coordinator(store);
    await owner.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const foreign = coordinator(store);
    await expect(foreign.instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' }))
      .resolves.toEqual({ status: 'rejected' });
    await expect(owner.instance.status(SERVER)).resolves.toMatchObject({ view: { state: 'current', current: true } });
    await owner.instance.stop(SERVER);
  });

  it('reads the persisted coordination record from a process that owns no child', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const owner = coordinator(store);
    await owner.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await owner.instance.event(SERVER, { generation: 1, type: 'failed', code: 'MANAGED_RUNTIME_FAILED' });
    await expect(readManagedMcpLifecycleStatus(store, SERVER)).resolves.toMatchObject({ status: 'observed',
      view: { generation: 1, state: 'failed', current: false, currentVerified: false,
        snapshot: { registryRevision: 'r1' }, terminal: { reason: 'runtime_failed', code: 'MANAGED_RUNTIME_FAILED' },
        startDecision: { action: 'start', generation: 1 } } });
    await expect(readManagedMcpLifecycleStatus(store, OTHER_ASSET)).resolves.toEqual({ status: 'absent',
      serverId: OTHER_ASSET, current: false });
    await expect(readManagedMcpLifecycleStatus(store, 'not a valid id')).rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_REJECTED' });
  });
});
