import 'reflect-metadata';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  MANAGED_MCP_CONFIG_ENV,
  MANAGED_MCP_CONFIG_INVALID,
  parseManagedMcpConfigEnvelope,
  resolveManagedMcpConfigValue,
} from './managed-mcp-trusted-config';
import {
  MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY,
  createConfigManagedLifecycleApprovalProvider,
} from './managed-mcp-lifecycle-approval';
import {
  MANAGED_MCP_SOURCES_CONFIG_KEY,
  ManagedMcpHandoffPreparationService,
} from './managed-mcp-handoff-preparation.service';

const ASSET = '00000000-0000-0000-0000-0000000000a1';
const SERVER = '00000000-0000-0000-0000-0000000000c3';
const POLICY = {
  version: 1 as const,
  mode: 'auto' as const,
  policyId: 'env-policy',
  allowedActions: ['start', 'stop'] as const,
  allowedServerIds: [SERVER],
};
const SOURCE = {
  [ASSET]: {
    registrySource: {
      configId: 'env-fixture',
      path: resolve('env-registry.json'),
      format: 'json',
      environment: 'test',
      expectedRevision: 'r1',
      expectedContentDigest: 'a'.repeat(64),
    },
    approvedEnvironmentNames: ['API_NOVA_RUNTIME_AUTH_MODE'],
  },
};
const snapshot = {
  runtimeAssetId: ASSET,
  candidateRevision: 'candidate-one',
  verificationRunId: 'run-one',
  behaviorFingerprint: 'a'.repeat(64),
  registryRevision: 'r1',
  registryContentDigest: 'b'.repeat(64),
  inboundAuthMode: 'private_api_key' as const,
};
const approvalRequest = { action: 'start' as const, serverId: SERVER, runtimeAssetId: ASSET, generation: 1, snapshot };
const readEnv = (value: string | undefined) => (value === undefined ? {} : { [MANAGED_MCP_CONFIG_ENV]: value });
const emptyConfig = { get: () => undefined };

describe('managed Mcp trusted configuration from environment', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('parses a bounded, strictly shaped envelope and rejects malformed input', () => {
    const envelope = parseManagedMcpConfigEnvelope(JSON.stringify({ handoffSources: SOURCE, lifecycleApproval: { [ASSET]: POLICY } }));
    expect(envelope).toEqual({ handoffSources: SOURCE, lifecycleApproval: { [ASSET]: POLICY } });
    expect(parseManagedMcpConfigEnvelope(undefined)).toBeUndefined();
    for (const invalid of ['', '{', '[]', 'null', '"x"', '{}', '{"unknown":{}}', '{"handoffSources":{}}extra',
      '{"handoffSources":{"' + ASSET + '":{"__proto__":{"polluted":true}},"lifecycleApproval":{}}}']) {
      expect(() => parseManagedMcpConfigEnvelope(invalid)).toThrow(MANAGED_MCP_CONFIG_INVALID);
    }
    expect(() => parseManagedMcpConfigEnvelope(`{"handoffSources":{"${'x'.repeat(70000)}":{}}}`)).toThrow(MANAGED_MCP_CONFIG_INVALID);
    expect(() => parseManagedMcpConfigEnvelope(`{"handoffSources":{"a":"${'x'.repeat(70000)}"}}`)).toThrow(MANAGED_MCP_CONFIG_INVALID);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('prefers an injected object over the environment and reads the requested sub-key otherwise', () => {
    const injected = { get: (key: string) => (key === MANAGED_MCP_SOURCES_CONFIG_KEY ? SOURCE : undefined) };
    expect(resolveManagedMcpConfigValue(injected, MANAGED_MCP_SOURCES_CONFIG_KEY, 'handoffSources', readEnv(JSON.stringify({ handoffSources: { other: true } })))).toEqual(SOURCE);
    const env = readEnv(JSON.stringify({ lifecycleApproval: { [ASSET]: POLICY } }));
    expect(resolveManagedMcpConfigValue(emptyConfig, MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, 'lifecycleApproval', env)).toEqual({ [ASSET]: POLICY });
    expect(resolveManagedMcpConfigValue(emptyConfig, MANAGED_MCP_SOURCES_CONFIG_KEY, 'handoffSources', env)).toBeUndefined();
    expect(resolveManagedMcpConfigValue(emptyConfig, MANAGED_MCP_SOURCES_CONFIG_KEY, 'handoffSources', {})).toBeUndefined();
  });

  it('approves an environment-provisioned lifecycle policy and fails closed without or with malformed config', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    process.env[MANAGED_MCP_CONFIG_ENV] = JSON.stringify({ lifecycleApproval: { [ASSET]: POLICY } });
    const decision = await createConfigManagedLifecycleApprovalProvider(emptyConfig as any, { now })(approvalRequest);
    expect(decision).toMatchObject({ action: 'start', approvalMode: 'auto', policyId: POLICY.policyId, approvedBy: `auto:${POLICY.policyId}` });
    delete process.env[MANAGED_MCP_CONFIG_ENV];
    expect(await createConfigManagedLifecycleApprovalProvider(emptyConfig as any, { now })(approvalRequest)).toBeNull();
    process.env[MANAGED_MCP_CONFIG_ENV] = '{"lifecycleApproval":{"%":';
    expect(await createConfigManagedLifecycleApprovalProvider(emptyConfig as any, { now })(approvalRequest)).toBeNull();
    process.env[MANAGED_MCP_CONFIG_ENV] = JSON.stringify({ lifecycleApproval: { [ASSET]: POLICY }, unknown: {} });
    expect(await createConfigManagedLifecycleApprovalProvider(emptyConfig as any, { now })(approvalRequest)).toBeNull();
  });

  it('validates an environment-provisioned handoff source and rejects malformed environments', () => {
    const preparation = new ManagedMcpHandoffPreparationService({} as DataSource, emptyConfig as any);
    process.env[MANAGED_MCP_CONFIG_ENV] = JSON.stringify({ handoffSources: SOURCE });
    expect((preparation as any).source(ASSET)).toEqual(SOURCE[ASSET]);
    process.env[MANAGED_MCP_CONFIG_ENV] = JSON.stringify({ handoffSources: { [ASSET]: { registrySource: SOURCE[ASSET].registrySource } } });
    expect(() => (preparation as any).source(ASSET)).toThrow('MANAGED_MCP_PREPARATION_REJECTED');
    process.env[MANAGED_MCP_CONFIG_ENV] = '{"handoffSources":';
    expect(() => (preparation as any).source(ASSET)).toThrow(MANAGED_MCP_CONFIG_INVALID);
    delete process.env[MANAGED_MCP_CONFIG_ENV];
    expect(() => (preparation as any).source(ASSET)).toThrow('MANAGED_MCP_PREPARATION_REJECTED');
  });
});
