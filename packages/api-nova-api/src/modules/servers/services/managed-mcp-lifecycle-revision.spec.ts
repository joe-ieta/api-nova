import 'reflect-metadata';
import {
  MANAGED_MCP_LIFECYCLE_REVOKED_CODE,
  MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE,
  ManagedLifecycleChannelHandle,
  ManagedLifecycleChannelInput,
  ManagedMcpLifecycleCoordinator,
} from './managed-mcp-lifecycle-coordinator.service';
import { ManagedLifecycleCapturedHandoff } from './managed-mcp-lifecycle-coordinator.service';
import { InMemoryManagedMcpLifecycleStore } from './managed-mcp-lifecycle.store';
import {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  createConfigManagedLifecycleApprovalProvider,
} from './managed-mcp-lifecycle-approval';
import { managedLifecycleSnapshotDigest } from './managed-mcp-lifecycle.contract';

const SERVER = '00000000-0000-0000-0000-000000000001';
const ASSET = '00000000-0000-0000-0000-000000000002';
const POLICY_ID = 'policy-one';

function approvalState(overrides: { allowedActions?: readonly string[]; enabled?: boolean } = {}) {
  const state = {
    sources: {
      [ASSET]: { version: 1, mode: 'auto', policyId: POLICY_ID,
        allowedActions: overrides.allowedActions ?? ['start', 'stop'], allowedServerIds: [SERVER] },
    } as Record<string, unknown> | undefined,
  };
  if (overrides.enabled === false) state.sources = undefined;
  const config = { get: (key: string) => key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY ? state.sources : undefined } as any;
  return { state, config };
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
  constructor(readonly launchId: string, readonly input: ChannelInput) {
    this.state = 'runtimeReady';
    this.readyDeferred.resolve({ candidateRevision: 'candidate-one', verificationRunId: 'run-one',
      behaviorFingerprint: 'a'.repeat(64), registryRevision: input.revision, registryContentDigest: input.digest,
      authMode: 'api_key', credentialMode: 'single-hop' });
  }
  async close() {
    this.closedCalls++;
    if (!this.closedSettled) { this.closedSettled = true; this.closedDeferred.resolve({ code: 'STOPPED' }); }
  }
}

interface ChannelInput extends ManagedLifecycleChannelInput { revision: string; digest: string }

function fakeChannel() {
  const invocations: ChannelInput[] = [];
  const handles: FakeHandle[] = [];
  const channel = async (input: ManagedLifecycleChannelInput) => {
    const record = { ...input, revision: input.payload.registrySource.expectedRevision,
      digest: input.payload.registrySource.expectedContentDigest } as ChannelInput;
    invocations.push(record);
    const handle = new FakeHandle(input.launchId, record);
    handles.push(handle);
    return handle;
  };
  return { channel, invocations, handles };
}

function captureSequence(entries: Array<any | Error | (() => never)>) {
  let calls = 0;
  const capture = async (): Promise<ManagedLifecycleCapturedHandoff> => {
    const entry = entries[Math.min(calls, entries.length - 1)];
    calls++;
    if (entry instanceof Error) throw entry;
    return { payload: entry, approvedEnvironmentNames: [], environmentValues: {} };
  };
  return { capture, calls: () => calls };
}

function fixture(overrides: {
  entries?: Array<any | Error>;
  approval?: ReturnType<typeof approvalState>;
  store?: InMemoryManagedMcpLifecycleStore;
} = {}) {
  const store = overrides.store ?? new InMemoryManagedMcpLifecycleStore();
  const channel = fakeChannel();
  const approvals = overrides.approval ?? approvalState();
  const sequence = captureSequence(overrides.entries ?? [payloadFor('launch-1')]);
  const instance = new ManagedMcpLifecycleCoordinator({
    store,
    capture: sequence.capture,
    approval: createConfigManagedLifecycleApprovalProvider(approvals.config),
    channel: channel.channel,
  });
  return { store, channel, approvals, sequence, instance };
}

describe('managed lifecycle running-version check (SEC-E1-04)', () => {
  it('leaves an unchanged current generation running and reports its snapshot digest', async () => {
    const { store, channel, instance } = fixture({ entries: [payloadFor('launch-1', 'r1')] });
    const started = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const result = await instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(result).toEqual({ status: 'unchanged', serverId: SERVER, generation: 1,
      snapshotDigest: managedLifecycleSnapshotDigest(started.snapshot) });
    expect(channel.invocations).toHaveLength(1);
    expect(channel.handles[0].closedCalls).toBe(0);
    expect((await instance.status(SERVER))).toMatchObject({ view: { state: 'current', current: true, generation: 1 } });
    expect((await store.read(SERVER) as any).record.snapshot.registryRevision).toBe('r1');
  });

  it('terminates the old child before re-preparing a new generation when the trusted snapshot moved on', async () => {
    const { store, channel, instance } = fixture({
      entries: [payloadFor('launch-1', 'r1', 'b'.repeat(64)), payloadFor('launch-2', 'r2', 'd'.repeat(64))],
    });
    const started = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);

    const result = await instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(result).toMatchObject({ status: 'restarted', serverId: SERVER, previousGeneration: 1, generation: 2,
      snapshot: { registryRevision: 'r2', registryContentDigest: 'd'.repeat(64) } });
    expect(channel.handles[0].closedCalls).toBe(1);
    expect(channel.invocations).toHaveLength(2);
    expect(channel.invocations[1].revision).toBe('r2');
    const record = (await store.read(SERVER) as any).record;
    expect(record.state).toBe('current');
    expect(record.generation).toBe(2);
    expect(record.snapshot.registryRevision).toBe('r2');
    expect(record.decisions.map((decision: any) => decision.action)).toEqual(['start', 'stop', 'start']);
    expect((await instance.status(SERVER))).toMatchObject({ view: { state: 'current', current: true, generation: 2 } });
  });

  it('terminates the owned child when the trusted snapshot can no longer be captured and blocks stale restart', async () => {
    const { store, channel, instance } = fixture({
      entries: [payloadFor('launch-1', 'r1'), new Error('MANAGED_MCP_PREPARATION_REJECTED')],
    });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });

    const result = await instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(result).toEqual({ status: 'terminated', serverId: SERVER, generation: 1, code: MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE });
    expect(channel.handles[0].closedCalls).toBe(1);
    const record = (await store.read(SERVER) as any).record;
    expect(record.state).toBe('stopped');
    expect(record.currentVerified).toBe(false);
    expect(record.terminal).toMatchObject({ reason: 'security_revoked', code: MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE });
    expect(record.snapshot.registryRevision).toBe('r1');
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_CAPTURE_FAILED' });
    expect(channel.invocations).toHaveLength(1);
  });

  it('terminates (not restarts) when the snapshot changed but stop approval was revoked', async () => {
    const { channel, instance } = fixture({
      entries: [payloadFor('launch-1', 'r1'), payloadFor('launch-2', 'r2')],
      approval: approvalState({ allowedActions: ['start'] }),
    });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const result = await instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(result).toMatchObject({ status: 'terminated', code: MANAGED_MCP_LIFECYCLE_STATE_INVALIDATED_CODE });
    expect(channel.handles[0].closedCalls).toBe(1);
    expect(channel.invocations).toHaveLength(1);
    expect((await instance.status(SERVER))).toMatchObject({ view: { state: 'stopped', current: false, generation: 1 } });
  });

  it('revokes a current generation without depending on the approval policy and keeps the restart fail-closed', async () => {
    const approval = approvalState();
    const { store, channel, instance } = fixture({ entries: [payloadFor('launch-1', 'r1')], approval });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    approval.state.sources = undefined;

    const revoked = await instance.revoke(SERVER);
    expect(revoked).toEqual({ status: 'revoked', serverId: SERVER, generation: 1, code: MANAGED_MCP_LIFECYCLE_REVOKED_CODE });
    expect(channel.handles[0].closedCalls).toBe(1);
    const record = (await store.read(SERVER) as any).record;
    expect(record.state).toBe('stopped');
    expect(record.terminal).toMatchObject({ reason: 'security_revoked', verifiedByParent: true, code: MANAGED_MCP_LIFECYCLE_REVOKED_CODE });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_APPROVAL_REJECTED' });
    expect(channel.invocations).toHaveLength(1);
  });

  it('is idempotent for repeated and concurrent check/revoke signals', async () => {
    const { channel, instance } = fixture({
      entries: [payloadFor('launch-1', 'r1'), payloadFor('launch-2', 'r2')],
    });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });

    const checks = await Promise.all([
      instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET }),
      instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET }),
    ]);
    expect(checks.map(result => result.status).sort()).toEqual(['restarted', 'unchanged']);
    expect(channel.invocations).toHaveLength(2);
    expect(channel.handles[0].closedCalls).toBe(1);
    expect(channel.handles[1].closedCalls).toBe(0);

    const revokes = await Promise.all([instance.revoke(SERVER), instance.revoke(SERVER)]);
    expect(revokes.map(result => result.status).sort()).toEqual(['already-stopped', 'revoked']);
    expect(channel.handles[1].closedCalls).toBe(1);
    expect(await instance.revoke(SERVER)).toMatchObject({ status: 'already-stopped', generation: 2 });
  });

  it('fails closed for foreign generations instead of touching another process child', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const owner = fixture({ store, entries: [payloadFor('launch-1', 'r1')] });
    await owner.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const foreign = fixture({ store, entries: [payloadFor('launch-2', 'r2')] });

    await expect(foreign.instance.revoke(SERVER)).rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_FOREIGN_CURRENT' });
    await expect(foreign.instance.checkRevision({ serverId: SERVER, runtimeAssetId: ASSET }))
      .resolves.toEqual({ status: 'foreign-current', serverId: SERVER, generation: 1 });
    expect(foreign.channel.invocations).toHaveLength(0);
    await expect(owner.instance.revoke(SERVER)).resolves.toMatchObject({ status: 'revoked', generation: 1 });
  });

  it('treats repeated revocation of an absent or already terminated generation as a no-op', async () => {
    const { instance, channel } = fixture();
    await expect(instance.revoke(SERVER)).resolves.toEqual({ status: 'absent', serverId: SERVER, generation: 0 });
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await instance.stop(SERVER);
    await expect(instance.revoke(SERVER)).resolves.toMatchObject({ status: 'already-stopped', generation: 1 });
    expect(channel.handles[0].closedCalls).toBe(1);
  });
});
