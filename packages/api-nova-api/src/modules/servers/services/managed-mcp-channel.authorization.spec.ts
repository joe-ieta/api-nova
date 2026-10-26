import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('api-nova-server', () => require('../../../../../api-nova-server/src/managed/handoff'));

const spawn = require('node:child_process').spawn as jest.Mock;
const { startManagedMcpChannel, MANAGED_AUTHORIZATION_ACK_MS } = require('./managed-mcp-channel');

const LAUNCH = 'launch-authorization';
function payload() {
  return { version: 1, launchId: LAUNCH, managedServerId: 'server-authorization', runtimeAssetId: 'asset-authorization',
    inboundAuthMode: 'private_api_key', candidateRevision: 'candidate-one', verificationRunId: 'run-one',
    behaviorFingerprint: 'a'.repeat(64), transport: { type: 'streamable', host: '127.0.0.1', port: 9333, endpoint: '/mcp' },
    openApiData: { openapi: '3.0.3', paths: {} }, trustedOperationBindings: [],
    registrySource: { configId: 'registry', path: resolve('fixture-registry.json'), format: 'json', environment: 'test',
      expectedRevision: 'r1', expectedContentDigest: 'b'.repeat(64) } };
}
function input() {
  const value = payload();
  return { launchId: value.launchId, serverId: value.managedServerId, payload: value,
    approvedEnvironmentNames: [], environmentValues: {} };
}
function fakeChild() {
  const child: any = new EventEmitter();
  child.pid = 6101; child.connected = true;
  const stream = () => ({ resume() {}, end() {}, destroy() {} });
  child.stdout = stream(); child.stderr = stream(); child.stdin = stream();
  child.send = jest.fn((_message: unknown, callback?: (error?: Error | null) => void) => { callback?.(null); return true; });
  child.kill = jest.fn();
  return child;
}
async function opened() {
  const child = fakeChild();
  spawn.mockReturnValueOnce(child);
  const pending = startManagedMcpChannel(input());
  await Promise.resolve();
  child.emit('message', { type: 'handoffAccepted', launchId: LAUNCH });
  const handle = await pending;
  return { child, handle };
}
const ack = (overrides: Record<string, unknown> = {}) => ({ type: 'authorizationAck', launchId: LAUNCH,
  sequence: 1, permitId: 'permit-1', decision: 'allow', status: 'applied', ...overrides });

afterEach(() => { jest.useRealTimers(); spawn.mockReset(); });

describe('managed channel authorization events (SEC-F1-02E3b)', () => {
  it('delivers an authorization decision and resolves on the applied acknowledgement', async () => {
    const { child, handle } = await opened();
    const pending = handle.authorize({ decision: 'allow', permitId: 'permit-1', sequence: 1 });
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'authorization', version: 1,
      launchId: LAUNCH, sequence: 1, permitId: 'permit-1', decision: 'allow' }), expect.any(Function));
    child.emit('message', ack());
    await expect(pending).resolves.toEqual({ status: 'applied' });
    expect(Object.keys(handle).sort()).toEqual(['close', 'closed', 'launchId', 'pid', 'ready', 'state']);
    const closing = handle.close();
    child.emit('exit', 0, null);
    await closing;
    await expect(handle.closed).resolves.toEqual({ code: 'STOPPED' });
  });

  it('is idempotent for duplicate delivery and rejects conflicting sequence reuse without re-sending', async () => {
    const { child, handle } = await opened();
    const first = handle.authorize({ decision: 'deny', permitId: 'permit-1', sequence: 1 });
    const duplicate = handle.authorize({ decision: 'deny', permitId: 'permit-1', sequence: 1 });
    expect(duplicate).toBe(first);
    expect(child.send).toHaveBeenCalledTimes(2); // handoff + one authorization
    child.emit('message', ack({ decision: 'deny', status: 'duplicate' }));
    await expect(first).resolves.toEqual({ status: 'duplicate' });

    await expect(handle.authorize({ decision: 'allow', permitId: 'permit-1', sequence: 1 }))
      .rejects.toMatchObject({ code: 'MANAGED_AUTHORIZATION_UNVERIFIED' });
    expect(child.send).toHaveBeenCalledTimes(2);
    const closing = handle.close();
    child.emit('exit', 0, null);
    await closing;
  });

  it('fails closed with a fixed channel code when the acknowledgement is missing within the bound', async () => {
    jest.useFakeTimers();
    const { child, handle } = await opened();
    const pending = handle.authorize({ decision: 'allow', permitId: 'permit-1', sequence: 1 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'MANAGED_AUTHORIZATION_UNVERIFIED' });
    await jest.advanceTimersByTimeAsync(MANAGED_AUTHORIZATION_ACK_MS);
    await rejection;
    await jest.advanceTimersByTimeAsync(MANAGED_AUTHORIZATION_ACK_MS);
    expect(child.kill).toHaveBeenCalled();
    child.emit('exit', 1, null);
    await expect(handle.closed).resolves.toEqual({ code: 'MANAGED_AUTHORIZATION_UNVERIFIED' });
  });

  it('fails closed on malformed or unsolicited acknowledgements', async () => {
    const { child, handle } = await opened();
    const pending = handle.authorize({ decision: 'allow', permitId: 'permit-1', sequence: 1 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INVALID_MANAGED_HANDOFF' });
    child.emit('message', ack({ secret: 'synthetic-extra-field' }));
    child.emit('exit', 1, null);
    await rejection;
    await expect(handle.closed).resolves.toEqual({ code: 'INVALID_MANAGED_HANDOFF' });

    const unsolicited = await opened();
    unsolicited.child.emit('message', ack({ sequence: 7, permitId: 'permit-7' }));
    unsolicited.child.emit('exit', 1, null);
    await expect(unsolicited.handle.closed).resolves.toEqual({ code: 'INVALID_MANAGED_HANDOFF' });
  });
});
