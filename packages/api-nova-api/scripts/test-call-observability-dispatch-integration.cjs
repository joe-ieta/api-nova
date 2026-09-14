'use strict';
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { CallObservabilityDispatchAuthorization } = require('../dist/src/modules/call-observability/call-observability-dispatch-authorization.js');
const { CallObservabilityDispatchWorker } = require('../dist/src/modules/call-observability/call-observability-dispatch.worker.js');
const { User, UserStatus } = require('../dist/src/database/entities/user.entity.js');
const { Role, RoleType } = require('../dist/src/database/entities/role.entity.js');
const { Permission } = require('../dist/src/database/entities/permission.entity.js');
const makeRole = (permission, assets) => Object.assign(new Role(), { enabled: true, type: RoleType.CUSTOM,
  name: 'dispatch-fixture', permissions: [Object.assign(new Permission(), { name: permission, enabled: true })],
  metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: assets } } });

test('dispatch authorization refreshes enabled current grants in the supplied transaction', async () => {
  const user = Object.assign(new User(), { id: 'owner', status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null,
    roles: [makeRole('monitoring:read', ['asset-a', 'asset-b']), makeRole('monitoring:subscription:manage', ['asset-b'])] });
  let reads = 0;
  const manager = { getRepository(entity) {
    assert.equal(entity, User);
    return { async findOne(options) {
      reads++;
      assert.deepEqual(options, { where: { id: 'owner' }, relations: { roles: { permissions: true } } });
      return user;
    } };
  } };
  const service = new CallObservabilityDispatchAuthorization();
  assert.deepEqual((await service.resolve('owner', manager)).runtimeAssetIds, ['asset-b']);
  user.roles[1].enabled = false;
  assert.equal(await service.resolve('owner', manager), null);
  user.roles[1].enabled = true;
  user.emailVerified = false;
  assert.equal(await service.resolve('owner', manager), null);
  assert.equal(reads, 3);
});

test('absent account fails closed and database failures propagate for transaction rollback', async () => {
  const service = new CallObservabilityDispatchAuthorization();
  assert.equal(await service.resolve('missing', { getRepository: () => ({ findOne: async () => null }) }), null);
  const failure = new Error('database unavailable');
  await assert.rejects(service.resolve('owner', { getRepository: () => ({ findOne: async () => { throw failure; } }) }), failure);
});

test('dispatch scheduling is disabled unless the literal true flag is supplied', async () => {
  for (const value of [undefined, false, true, 'false']) {
    let calls = 0;
    const worker = new CallObservabilityDispatchWorker({ dispatchBatch: async () => { calls++; } },
      new ConfigService({ API_NOVA_OBSERVABILITY_DISPATCH_ENABLED: value }));
    worker.onApplicationBootstrap();
    await Promise.resolve();
    await worker.onModuleDestroy();
    assert.equal(calls, 0);
  }
});

test('dispatch bootstrap is idempotent and shutdown waits for the active transaction', async () => {
  let release, calls = 0;
  const active = new Promise(resolve => { release = resolve; });
  const worker = new CallObservabilityDispatchWorker({ dispatchBatch: async () => { calls++; await active; } },
    new ConfigService({ API_NOVA_OBSERVABILITY_DISPATCH_ENABLED: 'true' }));
  worker.onApplicationBootstrap();
  worker.onApplicationBootstrap();
  await Promise.resolve();
  assert.equal(calls, 1);
  let stopped = false;
  const closing = worker.onModuleDestroy().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await closing;
  assert.equal(stopped, true);
  worker.onApplicationBootstrap();
  assert.equal(calls, 1);
});