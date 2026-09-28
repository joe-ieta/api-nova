import 'reflect-metadata';
import { UpstreamCredentialRegistry, normalizeUpstreamSecurity } from 'api-nova-parser';
import { createUpstreamSecurityContextAuthority } from '../../publication/security/upstream-security-context-authority';
import { createManagedExecutionPermitAuthority, createManagedExecutionPermitProvider } from './managed-execution-permit-authority';
import { InMemoryManagedMcpLifecycleStore } from './managed-mcp-lifecycle.store';
import { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } from './managed-mcp-lifecycle-approval';
import { ManagedMcpLifecycleCoordinator } from './managed-mcp-lifecycle-coordinator.service';

const SERVER = '00000000-0000-0000-0000-000000000001';
const ASSET = '00000000-0000-0000-0000-000000000002';
const SELECTOR = { method: 'GET', path: '/items', sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' };
const request = (overrides: Record<string, unknown> = {}) => ({ tool: 'items', ...SELECTOR, ...overrides }) as any;

function fixture() {
  const secret = { value: 'synthetic-g6-secret' };
  const registry = new UpstreamCredentialRegistry({ environment: 'test',
    providerFactory: (description: any) => ({ type: description.type, resolve: async () => secret.value }) });
  const candidate: any = { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'r1', environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { key: { type: 'apiKey', placement: { in: 'header', name: 'X-Key' }, secretRef: 'env:TOKEN' } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset-one',
      match: { scheme: 'http', host: '127.0.0.1', port: 1234, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'key',
      endpoints: [{ endpointDefinitionId: 'endpoint-one', credential: 'key' }] }] };
  const row: any = { sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one',
    bindingId: 'binding-one', bindingRevision: 'binding-1', method: 'GET', target: 'http://127.0.0.1:1234/items',
    declaration: normalizeUpstreamSecurity({ security: [{ Key: [] }], components: { securitySchemes:
      { Key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } }, {}) };
  let repositoryFailure = false;
  const repository = { read: async () => { if (repositoryFailure) throw new Error('db'); return row; } };
  return { registry, candidate, row, secret, repository,
    setRepositoryFailure: (value: boolean) => { repositoryFailure = value; },
    capture: () => registry.captureSnapshot() };
}

async function authorityFor(f: ReturnType<typeof fixture>, selectors: any[] = [SELECTOR]) {
  await f.registry.reload(f.candidate);
  return createManagedExecutionPermitAuthority({ permitId: 'permit-one', launchId: 'launch-one', selectors,
    repository: f.repository, captureSnapshot: f.capture });
}

describe('managed per-execution permit authority consumes G1 capability semantics (SEC-F1-02C3G6)', () => {
  it('allows only an exact trusted selector and revalidates the live capability on every call', async () => {
    const f = fixture();
    const authority = await authorityFor(f);
    await expect(authority.authorize(request({ endpointDefinitionId: 'foreign-endpoint' }))).resolves.toEqual({ decision: 'deny' });
    await expect(authority.authorize(request({ path: '/other' }))).resolves.toEqual({ decision: 'deny' });
    await expect(authority.authorize({ tool: 'items', method: 'GET' } as any)).resolves.toEqual({ decision: 'deny' });
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    expect(authority.report()).toMatchObject({ permitId: 'permit-one', launchId: 'launch-one', selectorCount: 1,
      allows: 2, denies: 3, revoked: false });
    expect(authority.report().livePermits).toEqual(['asset-one|endpoint-one|GET|/items']);
  });

  it('denies on credential rotation, DB row identity changes and repository failure for a held live permit', async () => {
    const f = fixture();
    const authority = await authorityFor(f);
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    f.secret.value = 'rotated-secret';
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'deny' });
    f.secret.value = 'synthetic-g6-secret';
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    f.row.bindingRevision = 'binding-2';
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'deny' });
    f.row.bindingRevision = 'binding-1';
    f.setRepositoryFailure(true);
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'deny' });
    f.setRepositoryFailure(false);
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    expect(authority.report().allows).toBe(3);

    const report = JSON.parse(JSON.stringify(authority.report()));
    await expect(authority.authorize(report as any)).resolves.toEqual({ decision: 'deny' });
    const wire = JSON.stringify(authority.report());
    expect(wire).not.toContain('synthetic-g6-secret');
    expect(wire).not.toContain('X-Key');
    expect(wire).not.toContain('token');
    expect(wire).not.toContain('proof');
  });

  it('binds the templated operation path to the live target and rejects a changed target', async () => {
    const f = fixture();
    f.row.target = 'http://127.0.0.1:1234/items/7';
    const authority = await authorityFor(f, [{ ...SELECTOR, path: '/items/{id}' }]);
    await expect(authority.authorize(request({ path: '/items/{id}' }))).resolves.toEqual({ decision: 'allow' });
    f.row.target = 'http://127.0.0.1:1234/other/7';
    await expect(authority.authorize(request({ path: '/items/{id}' }))).resolves.toEqual({ decision: 'deny' });
    f.row.target = 'http://127.0.0.1:1234/items/7';
    await expect(authority.authorize(request({ path: '/items/{id}' }))).resolves.toEqual({ decision: 'allow' });
  });

  it('revocation is terminal and idempotent for the launch authority', async () => {
    const f = fixture();
    const authority = await authorityFor(f);
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'allow' });
    authority.revoke(); authority.revoke();
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'deny' });
    expect(authority.report()).toMatchObject({ revoked: true, livePermits: [] });
    await expect(authority.authorize(request())).resolves.toEqual({ decision: 'deny' });
  });

  it('keeps a G1 capability token non-serializable so proof cannot be replayed over any channel', async () => {
    const f = fixture();
    await f.registry.reload(f.candidate);
    const contexts = createUpstreamSecurityContextAuthority(f.repository, f.capture);
    const token = await contexts.issue({ sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' });
    const context = contexts.inspect(token);
    expect(context.target).toBe('http://127.0.0.1:1234/items');
    expect(() => contexts.inspect(JSON.parse(JSON.stringify(token)))).toThrow('CHALLENGE_CONTEXT_UNAVAILABLE');
    expect(() => contexts.inspect(structuredClone(token))).toThrow('CHALLENGE_CONTEXT_UNAVAILABLE');
    expect(() => contexts.inspect({ ...context } as any)).toThrow('CHALLENGE_CONTEXT_UNAVAILABLE');
    expect(JSON.stringify(token)).toBe('{}');
  });

  it('rejects invalid provider configuration before any capability is issued', async () => {
    const f = fixture();
    expect(() => createManagedExecutionPermitProvider({} as any)).toThrow('MANAGED_PERMIT_CONFIGURATION_INVALID');
    expect(() => createManagedExecutionPermitProvider({ repository: f.repository, captureSnapshot: f.capture,
      ttlMs: 0 } as any)).not.toThrow();
    expect(() => createManagedExecutionPermitProvider({ repository: f.repository, captureSnapshot: f.capture,
      permitId: () => '' } as any)).not.toThrow();
    await expect(Promise.resolve().then(() => createManagedExecutionPermitProvider({ repository: f.repository, captureSnapshot: f.capture,
      permitId: () => 'invalid permit id' })({ payload: { launchId: 'launch-one', trustedOperationBindings: [SELECTOR] } } as any)))
      .rejects.toThrow('MANAGED_PERMIT_CONFIGURATION_INVALID');
  });
});

function payload() {
  return { version: 1, launchId: 'launch-one', managedServerId: SERVER, runtimeAssetId: ASSET, inboundAuthMode: 'private_api_key',
    candidateRevision: 'candidate-one', verificationRunId: 'run-one', behaviorFingerprint: 'a'.repeat(64),
    transport: { type: 'streamable', host: '127.0.0.1', port: 9022, endpoint: '/mcp' },
    openApiData: { openapi: '3.0.3', paths: {} },
    trustedOperationBindings: [{ method: 'GET', path: '/items', endpointDefinitionId: 'endpoint-one', sourceServiceAssetId: 'asset-one' }],
    registrySource: { configId: 'registry', path: 'C:/fixture/registry.json', format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } } as any;
}
function approvalConfig() {
  return { [ASSET]: { version: 1, mode: 'auto', policyId: 'policy-one', allowedActions: ['start', 'stop'], allowedServerIds: [SERVER] } };
}
type Handle = { launchId: string; pid: number; state: 'runtimeReady'; ready: Promise<any>; closed: Promise<{ code: string }>; close(): Promise<void>;
  permitAuthority?: any };

describe('managed coordinator permit wiring (SEC-F1-02C3G6)', () => {
  function build(overrides: Record<string, unknown> = {}) {
    const store = new InMemoryManagedMcpLifecycleStore();
    const invocations: any[] = [];
    const handles: Handle[] = [];
    const channel = async (input: any) => {
      invocations.push(input);
      let settleClosed!: (value: { code: string }) => void;
      const closed = new Promise<{ code: string }>(resolve => { settleClosed = resolve; });
      const handle: Handle = { launchId: input.launchId, pid: 7001, state: 'runtimeReady',
        ready: Promise.resolve({ candidateRevision: 'candidate-one', verificationRunId: 'run-one' }),
        closed, close: async () => settleClosed({ code: 'STOPPED' }) };
      handles.push(handle);
      return handle as any;
    };
    const coordinator = new ManagedMcpLifecycleCoordinator({
      store, channel,
      capture: async () => ({ payload: payload(), approvedEnvironmentNames: [], environmentValues: {} }),
      approval: createConfigManagedLifecycleApprovalProvider({ get: (key: string) =>
        key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY ? approvalConfig() : undefined } as any),
      ...overrides,
    });
    return { coordinator, invocations, handles };
  }

  it('is default-off: no permit authority is constructed or passed to the channel', async () => {
    const { coordinator, invocations } = build();
    await coordinator.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].permitAuthority).toBeUndefined();
  });

  it('provides one fresh authority per launch and revokes it when the generation stops', async () => {
    const f = fixture();
    await f.registry.reload(f.candidate);
    const provider = jest.fn(createManagedExecutionPermitProvider({ repository: f.repository, captureSnapshot: f.capture,
      permitId: () => 'permit-one' }));
    const { coordinator, invocations } = build({ permit: provider });
    const first = await coordinator.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ serverId: SERVER, runtimeAssetId: ASSET, generation: first.generation }));
    const authority = invocations[0].permitAuthority;
    expect(authority.permitId).toBe('permit-one');
    await expect(authority.authorize({ tool: 'items', method: 'GET', path: '/items',
      sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' })).resolves.toEqual({ decision: 'allow' });
    await coordinator.stop(SERVER);
    expect(authority.report()).toMatchObject({ revoked: true, livePermits: [] });
    await expect(authority.authorize({ tool: 'items', method: 'GET', path: '/items',
      sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' })).resolves.toEqual({ decision: 'deny' });

    const second = await coordinator.start({ serverId: SERVER, runtimeAssetId: ASSET });
    expect(second.generation).toBe(first.generation + 1);
    expect(invocations[1].permitAuthority).not.toBe(authority);
    await coordinator.stop(SERVER);
  });

  it('rejects the start before any child is spawned when the permit provider fails', async () => {
    const { coordinator, invocations } = build({ permit: () => { throw new Error('permit-provider-failed'); } });
    await expect(coordinator.start({ serverId: SERVER, runtimeAssetId: ASSET }))
      .rejects.toMatchObject({ code: 'MANAGED_LIFECYCLE_CAPTURE_FAILED' });
    expect(invocations).toHaveLength(0);
    expect(coordinator.ownedGeneration(SERVER)).toBeNull();
  });
});
