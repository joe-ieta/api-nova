import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { GatewayRuntimeModule } from '../gateway-runtime.module';
import { GatewayRuntimeService } from './gateway-runtime.service';
import {
  GATEWAY_UPSTREAM_PROOF_EXECUTION,
  assertGatewayUpstreamProofExecution,
  createGatewayUpstreamProofExecution,
  gatewayUpstreamProofExecutionProvider,
  resolveGatewayUpstreamProofExecution,
} from './gateway-upstream-proof-execution.wiring';

const fakes = () => ({
  endpoints: { findOneBy: jest.fn(async () => undefined) },
  authority: { issue: jest.fn(), inspect: jest.fn(), resolveCurrent: jest.fn(), revoke: jest.fn() } as any,
  transport: { challenge: jest.fn(), inspect: jest.fn() } as any,
  intents: { issue: jest.fn(), resolve: jest.fn(), complete: jest.fn() } as any,
  repository: {} as any,
  contexts: { read: jest.fn(async () => undefined) },
});

describe('Gateway proof execution registration wiring', () => {
  it('registers a default-off provider in the real Gateway module', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GatewayRuntimeModule);
    expect(providers).toContain(gatewayUpstreamProofExecutionProvider);
    expect(gatewayUpstreamProofExecutionProvider.provide).toBe(GATEWAY_UPSTREAM_PROOF_EXECUTION);
    expect(gatewayUpstreamProofExecutionProvider.useValue).toBeNull();
    expect(resolveGatewayUpstreamProofExecution(null)).toBeNull();
    expect(resolveGatewayUpstreamProofExecution(undefined)).toBeNull();
  });

  it('keeps the current runtime behavior when no host execution is installed', async () => {
    const proxy = { requiresPreparation: jest.fn().mockReturnValue(false), prepareRequest: jest.fn(), forward: jest.fn().mockResolvedValue({ statusCode: 200 }) };
    const cache = { resolve: jest.fn().mockReturnValue(null), store: jest.fn(), writeHit: jest.fn() };
    const service = new GatewayRuntimeService(
      { resolve: () => ({ policies: {} }) } as any,
      { authorize: jest.fn().mockResolvedValue({ mode: 'anonymous' }) } as any,
      { admit: jest.fn().mockResolvedValue({ release: jest.fn() }), beforeAttempt: jest.fn(), recordAttemptSuccess: jest.fn(), recordAttemptFailure: jest.fn(), recordRetryAttempt: jest.fn() } as any,
      cache as any, proxy as any,
      { recordRequest: jest.fn(), recordUnmatchedRequest: jest.fn() } as any,
      { recordPolicyEvent: jest.fn(), recordCacheResult: jest.fn(), recordForwardResult: jest.fn(), recordPolicyObservabilityEvent: jest.fn(), recordRouteMiss: jest.fn() } as any,
      undefined, null, null,
    );
    await service.forwardResolvedRoute({
      routeBinding: { id: 'route', routePath: '/x', routeMethod: 'GET', upstreamPath: '/x', upstreamMethod: 'GET' },
      runtimeAsset: { id: 'runtime' }, membership: { id: 'membership' }, endpointDefinition: { id: 'endpoint' },
      sourceServiceAsset: { id: 'asset' }, upstreamBaseUrl: 'https://api.example', params: {},
      policies: { auth: { mode: 'anonymous' }, traffic: { timeoutMs: 1000, retryPolicy: { attempts: 1 } }, cache: { enabled: false, methods: ['GET'] }, upstream: {} },
    } as any, { method: 'GET', headers: {}, socket: {} } as any, { setHeader: jest.fn() } as any);
    expect(proxy.forward).toHaveBeenCalledTimes(1);
    expect(cache.resolve).toHaveBeenCalledTimes(1);
  });

  it('accepts only explicitly composed branded executions', async () => {
    const execution = createGatewayUpstreamProofExecution(fakes());
    expect(resolveGatewayUpstreamProofExecution(execution)).toBe(execution);
    expect(assertGatewayUpstreamProofExecution(execution)).toBe(execution);
    expect(() => assertGatewayUpstreamProofExecution({ ...execution })).toThrow('gateway_upstream_proof_execution_invalid');
    expect(() => resolveGatewayUpstreamProofExecution({ guard: { assertCurrent: jest.fn() }, close: jest.fn() })).toThrow('gateway_upstream_proof_execution_invalid');
    expect(() => createGatewayUpstreamProofExecution({} as any)).toThrow('gateway_upstream_proof_execution_invalid');
    await expect(execution.close()).resolves.toBeUndefined();
  });
});
