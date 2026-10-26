import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RuntimePipelineStateEntity } from '../../../database/entities/runtime-call-observability.entity';
import {
  MANAGED_MCP_AUTHORIZATION_UNVERIFIED_CODE,
  MANAGED_MCP_LIFECYCLE_REVOKED_CODE,
  MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE,
  ManagedLifecycleCapturedHandoff,
  ManagedLifecycleChannelHandle,
  ManagedLifecycleChannelInput,
  ManagedMcpLifecycleCoordinator,
} from './managed-mcp-lifecycle-coordinator.service';
import { DataSourceManagedMcpLifecycleStore, InMemoryManagedMcpLifecycleStore, ManagedMcpLifecycleStore } from './managed-mcp-lifecycle.store';
import {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  createConfigManagedLifecycleApprovalProvider,
} from './managed-mcp-lifecycle-approval';
import { ManagedChildSecurityLeaseCoordinator } from './managed-child-security-lease-coordinator';

const SERVER = '00000000-0000-0000-0000-000000000001';
const ASSET = '00000000-0000-0000-0000-000000000002';
const POLICY_ID = 'policy-one';
const SOURCE = 'source-one';
const OTHER_SOURCE = 'source-two';

function config() {
  const sources = { [ASSET]: { version: 1, mode: 'auto', policyId: POLICY_ID, allowedActions: ['start', 'stop'], allowedServerIds: [SERVER] } };
  return { get: (key: string) => key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY ? sources : undefined } as any;
}

function payloadFor(launchId: string, revision = 'r1', sources: readonly string[] = [SOURCE]) {
  return { version: 1, launchId, managedServerId: SERVER, runtimeAssetId: ASSET, inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate-one', verificationRunId: 'run-one', behaviorFingerprint: 'a'.repeat(64),
    transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' },
    openApiData: { openapi: '3.0.3', paths: {} },
    trustedOperationBindings: sources.map((sourceServiceAssetId, index) => ({ method: 'GET', path: `/items-${index}`,
      endpointDefinitionId: `endpoint-${index}`, sourceServiceAssetId })),
    registrySource: { configId: 'registry', path: 'C:/fixture/registry.json', format: 'json', environment: 'test',
      expectedRevision: revision, expectedContentDigest: 'b'.repeat(64) } } as any;
}

class Deferred<T> {
  promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (error: Error) => void;
  constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject; }); }
  resolve(value: T) { this.resolveFn(value); }
  reject(error: Error) { this.rejectFn(error); }
}

class FakeHandle implements ManagedLifecycleChannelHandle {
  pid = 9001;
  state: 'handoffAccepted' | 'runtimeReady' = 'runtimeReady';
  private readonly closedDeferred = new Deferred<{ code: string }>();
  readonly ready = Promise.resolve({ candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: 'a'.repeat(64), registryRevision: 'r1', registryContentDigest: 'b'.repeat(64),
    authMode: 'api_key' as const, credentialMode: 'single-hop' as const });
  readonly closed = this.closedDeferred.promise;
  closedCalls = 0;
  closedSettled = false;
  authorize: ((input: any) => Promise<{ status: 'applied' | 'duplicate' }>) | undefined;
  constructor(readonly launchId: string, readonly input: ManagedLifecycleChannelInput) {}
  exit(code = 'MANAGED_CHILD_EXITED') { if (!this.closedSettled) { this.closedSettled = true; this.closedDeferred.resolve({ code }); } }
  async close() { this.closedCalls++; this.exit('STOPPED'); }
}

function fakeChannel() {
  const invocations: ManagedLifecycleChannelInput[] = [];
  const handles: FakeHandle[] = [];
  const channel = async (input: ManagedLifecycleChannelInput) => {
    invocations.push(input);
    const handle = new FakeHandle(input.launchId, input);
    handles.push(handle);
    return handle;
  };
  return { channel, invocations, handles };
}

function capture(payload: any) {
  const capture = async (): Promise<ManagedLifecycleCapturedHandoff> => ({ payload, approvedEnvironmentNames: [], environmentValues: {} });
  return capture;
}

function fixture(options: { store?: ManagedMcpLifecycleStore; lease?: ManagedChildSecurityLeaseCoordinator; payload?: any } = {}) {
  const store = options.store ?? new InMemoryManagedMcpLifecycleStore();
  const channel = fakeChannel();
  const instance = new ManagedMcpLifecycleCoordinator({
    store,
    capture: capture(options.payload ?? payloadFor('launch-1')),
    approval: createConfigManagedLifecycleApprovalProvider(config()),
    channel: channel.channel,
    lease: options.lease,
  });
  return { store, channel, instance };
}

describe('managed child security lease wiring (SEC-F1-02E3b)', () => {
  it('isolates only the affected source, verifies child closure and persists a security terminal before the update is applied', async () => {
    const lease = new ManagedChildSecurityLeaseCoordinator();
    const { store, channel, instance } = fixture({ payload: payloadFor('launch-1', 'r1', [SOURCE, OTHER_SOURCE]), lease });
    const started = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(started.generation).toBe(1);
    expect(lease.isAllowed(SERVER, 'launch-1')).toBe(true);

    const unrelated = await instance.isolateSourceForUpdate('source-other');
    expect(unrelated).toEqual({ status: 'clear', sourceAssetId: 'source-other', isolatedGenerations: [] });
    expect(channel.handles[0].closedCalls).toBe(0);
    expect(lease.isAllowed(SERVER, 'launch-1')).toBe(true);

    const barrier = await instance.isolateSourceForUpdate(SOURCE);
    expect(barrier).toEqual({ status: 'clear', sourceAssetId: SOURCE, isolatedGenerations: [1] });
    expect(channel.handles[0].closedCalls).toBe(1);
    expect(lease.isAllowed(SERVER, 'launch-1')).toBe(false);
    expect(instance.ownedGeneration(SERVER)).toBeNull();
    const read = await store.read(SERVER);
    expect(read.status).toBe('valid');
    expect((read as any).record.state).toBe('stopped');
    expect((read as any).record.currentVerified).toBe(false);
    expect((read as any).record.terminal).toMatchObject({ reason: 'security_revoked', verifiedByParent: true, code: MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE });
    const restarted = await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(restarted.generation).toBe(2);
  });

  it('is default-off and reports the barrier as unenforced without a lease dependency', async () => {
    const { channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    await expect(instance.isolateSourceForUpdate(SOURCE)).resolves.toEqual({ status: 'unenforced', sourceAssetId: SOURCE });
    expect(channel.handles[0].closedCalls).toBe(0);
  });

  it('persists the isolated generation through the real SQL.js store and survives reopen without a stale current', async () => {
    const dataSource = await new DataSource({ type: 'sqljs', synchronize: true,
      entities: [RuntimePipelineStateEntity] }).initialize();
    try {
      const store = new DataSourceManagedMcpLifecycleStore(dataSource);
      const lease = new ManagedChildSecurityLeaseCoordinator();
      const { instance } = fixture({ store, lease });
      await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
      await expect(instance.isolateSourceForUpdate(SOURCE)).resolves.toMatchObject({ status: 'clear', isolatedGenerations: [1] });
      const bytes = (dataSource.driver as any).export();
      await dataSource.destroy();
      const reopened = await new DataSource({ type: 'sqljs', database: bytes, entities: [RuntimePipelineStateEntity] }).initialize();
      const reopenedStore = new DataSourceManagedMcpLifecycleStore(reopened);
      const read = await reopenedStore.read(SERVER);
      expect(read.status).toBe('valid');
      expect((read as any).record.state).toBe('stopped');
      expect((read as any).record.terminal).toMatchObject({ reason: 'security_revoked', code: MANAGED_MCP_LIFECYCLE_SOURCE_UPDATED_CODE });
      const foreign = fixture({ store: reopenedStore, payload: payloadFor('launch-2') });
      await foreign.instance.reconcile(SERVER);
      const restarted = await foreign.instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
      expect(restarted.generation).toBe(2);
    } finally {
      if (dataSource?.isInitialized) await dataSource.destroy();
    }
  });

  it('fails closed and persists a security terminal when lease registration is rejected', async () => {
    const store = new InMemoryManagedMcpLifecycleStore();
    const channel = fakeChannel();
    const brokenLease = {
      register: () => { throw new Error('duplicate-lease'); },
      isolateSource: async () => undefined,
      revalidate: async () => false,
      isAllowed: () => false,
    } as unknown as ManagedChildSecurityLeaseCoordinator;
    const instance = new ManagedMcpLifecycleCoordinator({ store, capture: capture(payloadFor('launch-1')),
      approval: createConfigManagedLifecycleApprovalProvider(config()), channel: channel.channel, lease: brokenLease });
    await expect(instance.start({ serverId: SERVER, runtimeAssetId: ASSET })).rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_REJECTED' });
    expect(channel.handles[0].closedCalls).toBe(1);
    const read = await store.read(SERVER);
    expect((read as any).record.state).toBe('stopped');
    expect((read as any).record.terminal).toMatchObject({ reason: 'security_revoked' });
  });
});

describe('real-time managed child authorization (SEC-F1-02E3b)', () => {
  it('delivers allow/deny decisions, honors idempotent duplicate delivery and rejects conflicting reuse', async () => {
    const { store, channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const handle = channel.handles[0];
    const seen: string[] = [];
    handle.authorize = async input => { seen.push(`${input.permitId}:${input.decision}`); return { status: 'applied' }; };

    expect(await instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-1', sequence: 1 }))
      .toEqual({ status: 'applied', serverId: SERVER, generation: 1, decision: 'allow', permitId: 'permit-1', sequence: 1 });
    expect(await instance.authorize(SERVER, { decision: 'deny', permitId: 'permit-2', sequence: 2 }))
      .toMatchObject({ status: 'applied', generation: 1, decision: 'deny' });
    expect(await instance.authorize(SERVER, { decision: 'deny', permitId: 'permit-2', sequence: 2 }))
      .toEqual({ status: 'duplicate', serverId: SERVER, generation: 1, decision: 'deny', permitId: 'permit-2', sequence: 2 });
    expect(seen).toEqual(['permit-1:allow', 'permit-2:deny']);

    expect(await instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-2', sequence: 2 })).toEqual({ status: 'rejected', serverId: SERVER });
    expect(await instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-0', sequence: 1 })).toEqual({ status: 'rejected', serverId: SERVER });
    expect(seen).toHaveLength(2);
    expect((await store.read(SERVER) as any).record.state).toBe('current');
    expect(handle.closedCalls).toBe(0);
  });

  it('fails closed with a security terminal when an authorization acknowledgement cannot be verified', async () => {
    const { store, channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    channel.handles[0].authorize = async () => { throw new Error('MANAGED_AUTHORIZATION_UNVERIFIED'); };
    await expect(instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-1', sequence: 1 }))
      .resolves.toEqual({ status: 'rejected', serverId: SERVER });
    expect(channel.handles[0].closedCalls).toBe(1);
    const record = (await store.read(SERVER) as any).record;
    expect(record.state).toBe('stopped');
    expect(record.terminal).toMatchObject({ reason: 'security_revoked', verifiedByParent: true, code: MANAGED_MCP_AUTHORIZATION_UNVERIFIED_CODE });
  });

  it('revokes over the event channel, terminates decisively and never restarts without a fresh preparation', async () => {
    const { store, channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    channel.handles[0].authorize = async () => ({ status: 'applied' });
    const revoked = await instance.authorize(SERVER, { decision: 'revoke', permitId: 'permit-revoke', sequence: 5 });
    expect(revoked).toEqual({ status: 'revoked', serverId: SERVER, generation: 1, permitId: 'permit-revoke', sequence: 5,
      code: MANAGED_MCP_LIFECYCLE_REVOKED_CODE });
    expect(channel.handles[0].closedCalls).toBe(1);
    const record = (await store.read(SERVER) as any).record;
    expect(record.state).toBe('stopped');
    expect(record.terminal).toMatchObject({ reason: 'security_revoked', code: MANAGED_MCP_LIFECYCLE_REVOKED_CODE });
    await expect(instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-2', sequence: 6 })).resolves.toEqual({ status: 'rejected', serverId: SERVER });
  });

  it('rejects authorization when the channel exposes no authorization capability', async () => {
    const { channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    channel.handles[0].authorize = undefined;
    await expect(instance.authorize(SERVER, { decision: 'allow', permitId: 'permit-1', sequence: 1 }))
      .resolves.toEqual({ status: 'rejected', serverId: SERVER });
    expect(channel.handles[0].closedCalls).toBe(0);
  });

  it('rejects malformed authorization inputs before touching the child', async () => {
    const { channel, instance } = fixture();
    await instance.start({ serverId: SERVER, runtimeAssetId: ASSET });
    const handle = channel.handles[0];
    handle.authorize = jest.fn(async () => ({ status: 'applied' as const }));
    for (const input of [null, { decision: 'grant', permitId: 'p', sequence: 1 }, { decision: 'allow', permitId: '', sequence: 1 },
      { decision: 'allow', permitId: 'p', sequence: 0 }, { decision: 'allow', permitId: 'p', sequence: 1.5 }]) {
      await expect(instance.authorize(SERVER, input as any)).rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_REJECTED' });
    }
    expect(handle.authorize).not.toHaveBeenCalled();
    expect(handle.closedCalls).toBe(0);
  });
});
