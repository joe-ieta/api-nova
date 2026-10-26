import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('api-nova-server', () => require('../../../../../api-nova-server/src/managed/handoff'));

const spawn = require('node:child_process').spawn as jest.Mock;
const { startManagedMcpChannel, MANAGED_AUTHORIZATION_ACK_MS } = require('./managed-mcp-channel');

const LAUNCH = 'launch-permit';
function payload() {
  return { version: 1, launchId: LAUNCH, managedServerId: 'server-permit', runtimeAssetId: 'asset-permit',
    inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: 'a'.repeat(64), transport: { type: 'streamable', host: '127.0.0.1', port: 9333, endpoint: '/mcp' },
    openApiData: { openapi: '3.0.3', paths: {} },
    trustedOperationBindings: [{ method: 'GET', path: '/items', endpointDefinitionId: 'endpoint-one', sourceServiceAssetId: 'asset-one' }],
    registrySource: { configId: 'registry', path: resolve('fixture-registry.json'), format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } };
}
function input(permitAuthority?: unknown) {
  const value = payload();
  return { launchId: value.launchId, serverId: value.managedServerId, payload: value,
    approvedEnvironmentNames: [], environmentValues: {}, permitAuthority: permitAuthority as any };
}
function fakeChild() {
  const child: any = new EventEmitter();
  child.pid = 6201; child.connected = true;
  const stream = () => ({ resume() {}, end() {}, destroy() {} });
  child.stdout = stream(); child.stderr = stream(); child.stdin = stream();
  child.send = jest.fn((_message: unknown, callback?: (error?: Error | null) => void) => { callback?.(null); return true; });
  child.kill = jest.fn();
  return child;
}
const runtimeReady = () => ({ type: 'runtimeReady', launchId: LAUNCH, nonSecretRevisions: { candidateRevision: 'candidate-one',
  verificationRunId: 'run-one', behaviorFingerprint: 'a'.repeat(64), registryRevision: 'r1', registryContentDigest: 'b'.repeat(64),
  authMode: 'api_key', credentialMode: 'single-hop' } });
const permitRequest = (overrides: Record<string, unknown> = {}) => ({ type: 'permitRequest', version: 1, launchId: LAUNCH,
  requestId: 'permit-request-1', tool: 'items', method: 'GET', path: '/items', sourceServiceAssetId: 'asset-one',
  endpointDefinitionId: 'endpoint-one', ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function opened(permitAuthority?: any) {
  const child = fakeChild();
  spawn.mockReturnValueOnce(child);
  const pending = startManagedMcpChannel(input(permitAuthority));
  await Promise.resolve();
  child.emit('message', { type: 'handoffAccepted', launchId: LAUNCH });
  const handle = await pending;
  return { child, handle };
}

afterEach(() => { jest.useRealTimers(); spawn.mockReset(); });

describe('managed channel per-execution permits (SEC-F1-02C3G6)', () => {
  it('opts the child into per-call permits only after the mode acknowledgement and serves a live allow', async () => {
    const authorize = jest.fn(async () => ({ decision: 'allow' as const }));
    const { child, handle } = await opened({ permitId: 'permit-one', authorize });
    const ready = handle.ready;
    child.emit('message', runtimeReady());
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'permitMode', version: 1, launchId: LAUNCH,
      sequence: 1, permitId: 'permit-one' }), expect.any(Function));
    await flush();
    child.emit('message', { type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'applied' });
    await expect(ready).resolves.toMatchObject({ candidateRevision: 'candidate-one' });

    child.emit('message', permitRequest());
    await flush();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({ tool: 'items', method: 'GET', path: '/items',
      sourceServiceAssetId: 'asset-one', endpointDefinitionId: 'endpoint-one' });
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'permitDecision', version: 1, launchId: LAUNCH,
      requestId: 'permit-request-1', permitId: 'permit-one', decision: 'allow' }), expect.any(Function));

    const closing = handle.close();
    child.emit('exit', 0, null);
    await closing;
  });

  it('denies on authority denial and short-circuits after a launch-level deny without a capability read', async () => {
    const authorize = jest.fn(async () => ({ decision: 'deny' as const }));
    const { child, handle } = await opened({ permitId: 'permit-one', authorize });
    child.emit('message', runtimeReady());
    child.emit('message', { type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'applied' });
    await handle.ready;
    child.emit('message', permitRequest());
    await flush();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'permitDecision', requestId: 'permit-request-1', decision: 'deny' }), expect.any(Function));

    const pending = handle.authorize!({ decision: 'deny', permitId: 'permit-deny', sequence: 1 });
    child.emit('message', { type: 'authorizationAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-deny', decision: 'deny', status: 'applied' });
    await expect(pending).resolves.toEqual({ status: 'applied' });
    authorize.mockClear();
    child.emit('message', permitRequest({ requestId: 'permit-request-2' }));
    await flush();
    expect(authorize).not.toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'permitDecision', requestId: 'permit-request-2', decision: 'deny' }), expect.any(Function));

    const closing = handle.close();
    child.emit('exit', 0, null);
    await closing;
  });

  it('fails the launch closed when a permit request does not match a trusted binding', async () => {
    const authorize = jest.fn(async () => ({ decision: 'allow' as const }));
    const { child, handle } = await opened({ permitId: 'permit-one', authorize });
    child.emit('message', runtimeReady());
    child.emit('message', { type: 'permitModeAck', launchId: LAUNCH, sequence: 1, permitId: 'permit-one', status: 'applied' });
    await handle.ready;
    child.emit('message', permitRequest({ endpointDefinitionId: 'foreign-endpoint' }));
    await flush();
    expect(authorize).not.toHaveBeenCalled();
    child.emit('exit', 1, null);
    await expect(handle.closed).resolves.toEqual({ code: 'INVALID_MANAGED_HANDOFF' });
  });

  it('fails closed with a fixed code when the permit mode acknowledgement is missing within the bound', async () => {
    jest.useFakeTimers();
    const authorize = jest.fn(async () => ({ decision: 'allow' as const }));
    const { child, handle } = await opened({ permitId: 'permit-one', authorize });
    const ready = handle.ready;
    const rejected = expect(ready).rejects.toMatchObject({ code: 'MANAGED_AUTHORIZATION_UNVERIFIED' });
    void ready.catch(() => undefined);
    child.emit('message', runtimeReady());
    await jest.advanceTimersByTimeAsync(MANAGED_AUTHORIZATION_ACK_MS);
    child.emit('exit', 1, null);
    await rejected;
    await expect(handle.closed).resolves.toEqual({ code: 'MANAGED_AUTHORIZATION_UNVERIFIED' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('keeps the established default-open readiness when no permit authority is configured', async () => {
    const { child, handle } = await opened(undefined);
    child.emit('message', runtimeReady());
    await expect(handle.ready).resolves.toMatchObject({ candidateRevision: 'candidate-one' });
    expect(child.send.mock.calls.every((call: unknown[]) => (call[0] as any)?.type !== 'permitMode')).toBe(true);
    const closing = handle.close();
    child.emit('exit', 0, null);
    await closing;
  });
});
