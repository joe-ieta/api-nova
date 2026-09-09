'use strict';

// In-memory repositories and one loopback-only Nest fixture; never load business DB options.
process.env.DB_TYPE = 'sqlite';
for (const key of ['JWT_SECRET','JWT_REFRESH_SECRET','API_NOVA_OBSERVABILITY_CURSOR_SECRET',
  'API_NOVA_OBSERVABILITY_CURSOR_KEY_ID','API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET']) delete process.env[key];
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { DataSource } = require('typeorm');
const { JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { NestFactory, Reflector } = require('@nestjs/core');
const { Module, Controller, Get, Req, NotFoundException, HttpException } = require('@nestjs/common');

const base = '../dist/src/modules/call-observability/';
const security = '../dist/src/modules/security/';
const {
  authorizeObservability, assertObservabilityAsset, requireGlobalObservabilityScope,
  intersectObservabilityAssets, OBSERVABILITY_PERMISSIONS,
} = require(base + 'call-observability-access.js');
const {
  ObservabilityAccessGuard, ObservabilityAccess, getObservabilityAuthorization, OBSERVABILITY_AUTHORIZATION,
} = require(base + 'call-observability-access.guard.js');
const {
  ObservabilityApiError, ObservabilityApiExceptionFilter, observabilitySuccess,
} = require(base + 'call-observability-api.contract.js');
const { parseObservabilityQuery } = require(base + 'call-observability-query.js');
const { ObservabilityCursorService } = require(base + 'call-observability-cursor.service.js');
const {
  ObservabilityCommandStore, observabilityEtag, requireObservabilityIfMatch, observabilityIdempotencyKey,
} = require(base + 'call-observability-command.store.js');
const { CallObservabilityStore } = require(base + 'call-observability.store.js');
const { canonicalJson } = require(base + 'call-observability-storage.js');
const { parseObservabilityRoleScope, validateObservabilityRoleMetadata } = require(security + 'observability-scope.js');
const { MANAGEMENT_TOKEN_USE, MANAGEMENT_TOKEN_AUDIENCE, MANAGEMENT_TOKEN_ISSUER } = require(security + 'management-access-token.js');
const { AuthService } = require(security + 'services/auth.service.js');
const { UserService } = require(security + 'services/user.service.js');
const { RoleService } = require(security + 'services/role.service.js');
const { SeedService } = require('../dist/src/database/seed.service.js');
const { User, UserStatus } = require('../dist/src/database/entities/user.entity.js');
const { Role, RoleType } = require('../dist/src/database/entities/role.entity.js');
const { Permission, SYSTEM_PERMISSIONS } = require('../dist/src/database/entities/permission.entity.js');
const entities = require('../dist/src/database/entities/runtime-call-observability.entity.js');
const { RuntimeObservabilityEventEntity } = require('../dist/src/database/entities/runtime-observability-event.entity.js');

const READ = 'monitoring:read';
const PAYLOAD = 'monitoring:payload:read';
const SOURCE = 'monitoring:source:read';
const SUBSCRIBE = 'monitoring:subscription:manage';
const RETRY = 'monitoring:delivery:retry';
const secret = randomBytes(48).toString('hex');
const cursorSecret = randomBytes(48).toString('hex');
const commandSecret = randomBytes(48).toString('hex');
const jwt = new JwtService();
const users = new Map();
const settings = {
  JWT_SECRET: secret,
  API_NOVA_OBSERVABILITY_CURSOR_SECRET: cursorSecret,
  API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: 'test-v1',
  API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: commandSecret,
};
const config = new ConfigService(settings);
const code = expected => error => error instanceof ObservabilityApiError && error.code === expected;
const grant = (names = [READ], assets = ['runtime-a'], overrides = {}) => Object.assign(new Role(), {
  id: randomUUID(), name: 'fixture-role', type: RoleType.CUSTOM, enabled: true,
  permissions: names.map(name => Object.assign(new Permission(), { id: randomUUID(), name, enabled: true })),
  metadata: { observabilityScope: assets === null ? { mode: 'all' } : { mode: 'assets', runtimeAssetIds: assets } },
  ...overrides,
});
function user(roles = [grant()], overrides = {}) {
  const value = Object.assign(new User(), {
    id: randomUUID(), username: 'fixture-user', email: 'fixture@example.invalid',
    status: UserStatus.ACTIVE, emailVerified: true, lockedUntil: null, roles, ...overrides,
  });
  users.set(value.id, value);
  return value;
}
function token(account, claims = {}, options = {}) {
  return jwt.sign({ sub: account.id, tokenUse: MANAGEMENT_TOKEN_USE, ...claims }, {
    secret, algorithm: 'HS256', audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER,
    expiresIn: '5m', ...options,
  });
}
function authorized(names = [READ], assets = ['runtime-a'], id) {
  return authorizeObservability(user([grant(names, assets)], id ? { id } : {}), names.filter(name => name !== READ));
}
function binding(authorization = authorized(), overrides = {}) {
  return { kind: 'query', endpoint: 'obsListInvocations', sort: 'startedAt:desc,invocationId:desc', authorization, ...overrides };
}
const queryKeys = ['from','to','origin','timeBasis','runtimeAssetId','limit','includeTotal','cursor'];
const queryTime = Date.parse('2026-09-08T12:00:00.000Z');
const cursorState = () => ({
  filter: parseObservabilityQuery({}, queryKeys, { now: queryTime }).filter,
  snapshotSeq: '18446744073709551615', position: { startedAt: '2026-09-08T11:30:00.000Z', invocationId: 'fixture-call' },
});
function signedCursorChange(value, change) {
  const payload = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
  const body = Buffer.from(canonicalJson({ ...payload, ...change })).toString('base64url');
  return body + '.' + createHmac('sha256', cursorSecret).update('observability.cursor.v1.' + body).digest('base64url');
}

let app, origin;
class FixtureController {
  metadata(request) {
    const scope = getObservabilityAuthorization(request);
    assertObservabilityAsset(scope, request.params.assetId);
    return observabilitySuccess({ runtimeAssetId: request.params.assetId });
  }
  payload(request) { return this.metadata(request); }
  source(request) { return this.metadata(request); }
  subscription(request) { return this.metadata(request); }
  retry(request) { return this.metadata(request); }
  list(request) {
    const scope = getObservabilityAuthorization(request);
    const requested = request.query.runtimeAssetId ? [request.query.runtimeAssetId] : undefined;
    const assets = intersectObservabilityAssets(scope, requested);
    return observabilitySuccess({ items: ['runtime-a','runtime-b'].filter(id => assets === null || assets.includes(id)) });
  }
  failure() { throw new Error('private-driver-error /private/storage password=fixture-only'); }
}
Controller('fixture')(FixtureController);
ObservabilityAccess()(FixtureController);
for (const [name, route, permissions] of [
  ['metadata', 'metadata/:assetId', []], ['payload', 'payload/:assetId', [PAYLOAD]],
  ['source', 'source/:assetId', [SOURCE]], ['subscription', 'subscription/:assetId', [SUBSCRIBE]],
  ['retry', 'retry/:assetId', [SUBSCRIBE, RETRY]], ['list', 'list', []], ['failure', 'failure', []],
]) {
  const descriptor = Object.getOwnPropertyDescriptor(FixtureController.prototype, name);
  Get(route)(FixtureController.prototype, name, descriptor);
  Req()(FixtureController.prototype, name, 0);
  if (permissions.length) ObservabilityAccess(...permissions)(FixtureController.prototype, name, descriptor);
}
Reflect.defineMetadata('isPublic', true, FixtureController.prototype.payload);
const resolver = {
  async findUserById(id) {
    if (id === 'fixture-db-failure') throw new Error('private-user-repository-error');
    if (!users.has(id)) throw new NotFoundException();
    return users.get(id);
  },
};
const guard = new ObservabilityAccessGuard(new Reflector(), jwt, resolver, config);
class FixtureModule {}
Module({
  controllers: [FixtureController],
  providers: [
    { provide: JwtService, useValue: jwt },
    { provide: UserService, useValue: resolver },
    { provide: ConfigService, useValue: config },
    { provide: ObservabilityAccessGuard, useValue: guard },
    ObservabilityApiExceptionFilter,
  ],
})(FixtureModule);
before(async () => {
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  origin = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1/fixture';
});
after(async () => { if (app) await app.close(); });
async function request(route, accessToken, extraHeaders = {}) {
  const response = await fetch(origin + route, {
    headers: { ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {}), ...extraHeaders },
  });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

test('role scopes normalize assets and distinguish explicit global from missing grants', () => {
  assert.deepEqual(parseObservabilityRoleScope({ mode: 'assets', runtimeAssetIds: ['b','a','a'] }), { mode: 'assets', runtimeAssetIds: ['a','b'] });
  assert.deepEqual(parseObservabilityRoleScope({ mode: 'all' }), { mode: 'all' });
  assert.equal(parseObservabilityRoleScope(undefined), null);
  assert.equal(parseObservabilityRoleScope(null), null);
  assert.deepEqual(parseObservabilityRoleScope({ mode: 'assets', runtimeAssetIds: [] }), { mode: 'assets', runtimeAssetIds: [] });
});
test('role scopes reject wildcard mistakes, extra keys, traversal and unbounded lists', () => {
  for (const value of [{ mode: '*' }, { mode: 'all', runtimeAssetIds: [] }, { mode: 'assets' },
    { mode: 'assets', runtimeAssetIds: ['../outside'] }, { mode: 'assets', runtimeAssetIds: ['*'] },
    { mode: 'assets', runtimeAssetIds: Array(1001).fill('a') }, [], 'all']) {
    assert.throws(() => parseObservabilityRoleScope(value), /INVALID_OBSERVABILITY_SCOPE/);
  }
  assert.throws(() => validateObservabilityRoleMetadata({ observabilityScope: { mode: 'all', trusted: true } }));
});
test('ordinary metadata permissions do not imply body, IP, subscription or retry grants', () => {
  const account = user();
  assert.deepEqual(authorizeObservability(account).runtimeAssetIds, ['runtime-a']);
  for (const permission of [PAYLOAD, SOURCE, SUBSCRIBE, RETRY]) {
    assert.throws(() => authorizeObservability(account, [permission]), code('FORBIDDEN'));
  }
});
test('every additional permission still requires base monitoring read', () => {
  for (const permission of [PAYLOAD, SOURCE, SUBSCRIBE, RETRY]) {
    assert.throws(() => authorizeObservability(user([grant([permission])]), [permission]), code('FORBIDDEN'));
    assert.deepEqual(authorizeObservability(user([grant([READ,permission])]), [permission]).runtimeAssetIds, ['runtime-a']);
  }
});
test('role scopes union within one permission and intersect across required permissions', () => {
  const account = user([grant([READ], ['a','b']), grant([READ], ['c']), grant([PAYLOAD], ['b','c','d'])]);
  assert.deepEqual(authorizeObservability(account).runtimeAssetIds, ['a','b','c']);
  assert.deepEqual(authorizeObservability(account, [PAYLOAD]).runtimeAssetIds, ['b','c']);
});
test('permissions on disjoint assets cannot manufacture cross-resource body access', () => {
  const scope = authorizeObservability(user([grant([READ], ['a']), grant([PAYLOAD], ['b'])]), [PAYLOAD]);
  assert.deepEqual(scope.runtimeAssetIds, []);
  assert.throws(() => assertObservabilityAsset(scope, 'b'), code('NOT_FOUND'));
});
test('missing role scope and self-reported user metadata never become grants', () => {
  const account = user([grant([READ], ['a'], { metadata: {} })], {
    metadata: { observabilityScope: { mode: 'all' } }, preferences: { permissions: OBSERVABILITY_PERMISSIONS },
  });
  assert.throws(() => authorizeObservability(account), code('FORBIDDEN'));
});
test('disabled roles, disabled permissions and unsupported conditional grants fail closed', () => {
  assert.throws(() => authorizeObservability(user([grant([READ], ['a'], { enabled: false })])), code('FORBIDDEN'));
  for (const mutation of [
    permission => { permission.enabled = false; },
    permission => { permission.conditions = { ipWhitelist: ['127.0.0.1'] }; },
    permission => { permission.conditions = true; },
    permission => { permission.conditions = []; },
  ]) {
    const role = grant(); mutation(role.permissions[0]);
    assert.throws(() => authorizeObservability(user([role])), code('FORBIDDEN'));
  }
});
test('inactive, unverified and locked accounts are unauthenticated', () => {
  for (const change of [{ status: UserStatus.SUSPENDED }, { emailVerified: false }, { lockedUntil: new Date(Date.now()+60000) }]) {
    assert.throws(() => authorizeObservability(user(undefined, change)), code('UNAUTHENTICATED'));
  }
});
test('only an enabled system super_admin gets the explicit global bypass', () => {
  const system = grant([], [], { name: 'super_admin', type: RoleType.SYSTEM });
  const scope = authorizeObservability(user([system]), [PAYLOAD, SOURCE, SUBSCRIBE, RETRY]);
  assert.equal(scope.runtimeAssetIds, null);
  requireGlobalObservabilityScope(scope);
  assertObservabilityAsset(scope, null);
  assert.throws(() => authorizeObservability(user([grant([], [], { name: 'super_admin' })])), code('FORBIDDEN'));
});
test('list intersection and hidden-object checks never widen an empty scope', () => {
  const scope = authorized([READ], ['a']);
  assert.deepEqual(intersectObservabilityAssets(scope, ['b']), []);
  assert.deepEqual(intersectObservabilityAssets(scope, ['a','a','b']), ['a']);
  for (const value of ['b', null, undefined]) assert.throws(() => assertObservabilityAsset(scope, value), code('NOT_FOUND'));
  assert.throws(() => requireGlobalObservabilityScope(scope), code('FORBIDDEN'));
});
test('authorization fingerprints are canonical and bound to principal, permission and assets', () => {
  const account = user([grant([READ, PAYLOAD], ['b','a','a'])]);
  const read = authorizeObservability(account);
  account.roles = [grant([PAYLOAD,READ], ['a','b'])];
  assert.equal(authorizeObservability(account).fingerprint, read.fingerprint);
  assert.notEqual(authorizeObservability(account, [PAYLOAD]).fingerprint, read.fingerprint);
  assert.notEqual(authorized([READ], ['a','b']).fingerprint, read.fingerprint);
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.runtimeAssetIds), true);
});
test('new system permissions exist without broadening ordinary seeded roles', async () => {
  const definitions = Object.values(SYSTEM_PERMISSIONS);
  for (const name of [PAYLOAD,SOURCE,SUBSCRIBE,RETRY]) assert.equal(definitions.filter(p => p.name === name).length, 1);
  const fixture = { permissionRepository: { find: async query => query ? query.where : definitions } };
  for (const role of ['admin','operator','viewer','guest']) {
    const result = await SeedService.prototype.resolveSystemRolePermissions.call(fixture, role);
    assert.equal(result.some(p => [PAYLOAD,SOURCE,SUBSCRIBE,RETRY].includes(p.name)), false);
  }
});
test('role administration rejects invalid scopes before saving', async () => {
  let saves = 0;
  const existing = grant();
  const repository = { findOne: async () => existing, save: async value => { saves++; return value; } };
  const service = new RoleService(repository, {}, {}, {});
  await assert.rejects(service.createRole({ name: 'x', metadata: { observabilityScope: { mode: '*' } } }), e => e.getStatus() === 400);
  await assert.rejects(service.updateRole(existing.id, { metadata: { observabilityScope: { mode: '*' } } }), e => e.getStatus() === 400);
  assert.equal(saves, 0);
});
test('role creation records the explicitly managed scope in its audit details', async () => {
  const audits = [];
  const repository = {
    findOne: async () => null,
    create: value => Object.assign(new Role(), { id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }, value),
    save: async value => value,
  };
  const service = new RoleService(repository, {}, {}, { log: async value => audits.push(value) });
  await service.createRole({ name: 'fixture-created', metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['a'] } } }, 'operator');
  assert.deepEqual(audits[0].details.observabilityScope, { mode: 'assets', runtimeAssetIds: ['a'] });
});

test('real HTTP guard rejects no token even when a public marker is present', async () => {
  const result = await request('/payload/runtime-a');
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'UNAUTHENTICATED');
  assert.equal(result.cache, 'no-store');
});
test('real HTTP metadata and payload routes enforce separate AND permissions', async () => {
  const account = user();
  const access = token(account);
  assert.equal((await request('/metadata/runtime-a', access)).status, 200);
  assert.equal((await request('/payload/runtime-a', access)).status, 403);
  account.roles = [grant([READ,PAYLOAD])];
  assert.equal((await request('/payload/runtime-a', access)).status, 200);
});
test('real HTTP source, subscription and retry routes enforce their complete permission sets', async () => {
  const account = user([grant([READ,SOURCE,SUBSCRIBE])]);
  const access = token(account);
  assert.equal((await request('/source/runtime-a', access)).status, 200);
  assert.equal((await request('/subscription/runtime-a', access)).status, 200);
  assert.equal((await request('/retry/runtime-a', access)).status, 403);
  account.roles = [grant([READ,RETRY])];
  assert.equal((await request('/retry/runtime-a', access)).status, 403);
  account.roles = [grant([READ,SUBSCRIBE,RETRY])];
  assert.equal((await request('/retry/runtime-a', access)).status, 200);
});
test('real HTTP resource filtering hides inaccessible details and list entries', async () => {
  const access = token(user());
  const hidden = await request('/metadata/runtime-b', access);
  assert.equal(hidden.status, 404);
  assert.equal(JSON.stringify(hidden.body).includes('runtime-b'), false);
  assert.deepEqual((await request('/list?runtimeAssetId=runtime-b', access)).body.data.items, []);
});
test('real HTTP guard ignores JWT self-reported roles and observes permission revocation', async () => {
  const account = user();
  const access = token(account, { roles: ['super_admin'], permissions: [READ,PAYLOAD] });
  assert.equal((await request('/payload/runtime-a', access)).status, 403);
  account.roles[0].enabled = false;
  assert.equal((await request('/metadata/runtime-a', access)).status, 403);
});
test('real JWT purpose, issuer, audience, signature and algorithm are all enforced', async () => {
  const account = user();
  const invalid = [
    token(account, { tokenUse: 'gateway_access' }),
    token(account, {}, { audience: 'gateway' }),
    token(account, {}, { issuer: 'external' }),
    token(account, {}, { secret: randomBytes(48).toString('hex') }),
    token(account, {}, { algorithm: 'HS384' }),
    jwt.sign({ sub: account.id }, { secret, expiresIn: '5m' }),
    jwt.sign({ sub: account.id, tokenId: randomUUID() }, { secret, expiresIn: '5m' }),
  ];
  for (const access of invalid) assert.equal((await request('/metadata/runtime-a', access)).status, 401);
});
test('real JWT expiry, missing expiry, missing iat and future iat cannot bypass the guard', async () => {
  const account = user();
  const common = { secret, algorithm: 'HS256', audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER };
  const invalid = [
    token(account, {}, { expiresIn: -1 }),
    jwt.sign({ sub: account.id, tokenUse: MANAGEMENT_TOKEN_USE }, common),
    token(account, {}, { noTimestamp: true }),
    token(account, { iat: Math.floor(Date.now()/1000)+120 }),
  ];
  for (const access of invalid) assert.equal((await request('/metadata/runtime-a', access)).status, 401);
});
test('real HTTP guard validates current account status and maps repository failure safely', async () => {
  const account = user();
  const access = token(account);
  account.status = UserStatus.SUSPENDED;
  assert.equal((await request('/metadata/runtime-a', access)).status, 401);
  const failed = await request('/metadata/runtime-a', token({ id: 'fixture-db-failure' }));
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes('private-user-repository'), false);
  assert.equal((await request('/metadata/runtime-a', token({ id: randomUUID() }))).status, 401);
});
test('guard clears stale authorization and fails closed without a strong configured key', async () => {
  const account = user();
  const requestValue = { headers: { authorization: 'Bearer '+token(account) }, [OBSERVABILITY_AUTHORIZATION]: { forged: true } };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => requestValue, getResponse: () => ({ setHeader() {} }) }),
    getClass: () => FixtureController, getHandler: () => FixtureController.prototype.metadata,
  };
  const weak = new ObservabilityAccessGuard(new Reflector(), jwt, resolver, new ConfigService({ JWT_SECRET: 'weak' }));
  await assert.rejects(weak.canActivate(ctx), code('OBSERVABILITY_UNAVAILABLE'));
  assert.equal(requestValue[OBSERVABILITY_AUTHORIZATION], undefined);
});
test('class-level extra permissions cannot be weakened by method metadata', async () => {
  class Restricted { read() {} }
  ObservabilityAccess(PAYLOAD)(Restricted);
  ObservabilityAccess()(Restricted.prototype, 'read', Object.getOwnPropertyDescriptor(Restricted.prototype, 'read'));
  const account = user();
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer '+token(account) } }), getResponse: () => ({ setHeader() {} }) }),
    getClass: () => Restricted, getHandler: () => Restricted.prototype.read,
  };
  await assert.rejects(guard.canActivate(ctx), code('FORBIDDEN'));
});
test('existing management token signer produces tokens accepted by the new guard', async () => {
  const old = Object.fromEntries(['JWT_SECRET','JWT_REFRESH_SECRET','JWT_EXPIRES_IN'].map(key => [key,process.env[key]]));
  try {
    process.env.JWT_SECRET = secret;
    process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
    process.env.JWT_EXPIRES_IN = '15m';
    const account = user();
    const auth = new AuthService({}, jwt, {}, {}, {});
    const signed = await auth.generateTokens(account, false);
    const payload = jwt.verify(signed.accessToken, { secret, audience: MANAGEMENT_TOKEN_AUDIENCE, issuer: MANAGEMENT_TOKEN_ISSUER });
    assert.equal(payload.tokenUse, MANAGEMENT_TOKEN_USE);
    assert.equal((await request('/metadata/runtime-a', signed.accessToken)).status, 200);
    assert.equal((await request('/metadata/runtime-a', signed.refreshToken)).status, 401);
  } finally {
    for (const [key,value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('error envelopes hide internal errors and generate request ids instead of echoing client ids', async () => {
  const result = await request('/failure', token(user()), { 'x-request-id': 'client-supplied' });
  assert.equal(result.status, 503);
  assert.equal(result.body.status, 'error');
  assert.match(result.body.error.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(/private|password|client-supplied/.test(JSON.stringify(result.body)), false);
});
test('success metadata preserves unknown values without inventing zero watermarks', () => {
  const result = observabilitySuccess({ items: [], nextCursor: null, hasMore: false }, { lagMs: null, isPartial: true });
  assert.equal(result.meta.schemaVersion, '1.0');
  assert.equal(result.meta.lagMs, null);
  assert.equal(result.meta.snapshotSeq, undefined);
});

test('query normalization has bounded defaults and a deterministic initial window', () => {
  const result = parseObservabilityQuery({}, queryKeys, { now: queryTime });
  assert.equal(result.filter.from, '2026-09-08T11:00:00.000Z');
  assert.equal(result.filter.to, '2026-09-08T12:00:00.000Z');
  assert.equal(result.filter.origin, 'external');
  assert.deepEqual(result.page, { limit: 50, includeTotal: false });
});
test('query normalization rejects unknown keys, duplicate arrays and nested scalar values', () => {
  for (const value of [{ bogus: 'x' }, { limit: ['1','2'] }, { runtimeAssetId: { id: 'a' } }, { limit: '201' }, { limit: '0' },
    { limit: '-1' }, { limit: '1.5' }, { includeTotal: '1' }, { origin: 'telemetry' }]) {
    assert.throws(() => parseObservabilityQuery(value, queryKeys), code('INVALID_QUERY'));
  }
});
test('UTC query windows reject invalid calendar dates, offsets, one-sided and inverted bounds', () => {
  for (const value of [
    { from: '2026-09-08T00:00:00Z' },
    { from: '2026-02-30T00:00:00Z', to: '2026-03-02T00:00:00Z' },
    { from: '2026-09-08T00:00:00+00:00', to: '2026-09-08T01:00:00Z' },
    { from: '2026-09-08T02:00:00Z', to: '2026-09-08T01:00:00Z' },
    { from: '2026-07-01T00:00:00Z', to: '2026-09-08T01:00:00Z' },
  ]) assert.throws(() => parseObservabilityQuery(value, queryKeys), code('INVALID_QUERY'));
});
test('group and bucket limits reject unsupported sizes rather than silently truncating', () => {
  const allowed = ['from','to','interval','groupBy','top'];
  assert.throws(() => parseObservabilityQuery({ groupBy: 'a,b,c' }, allowed), code('INVALID_QUERY'));
  assert.throws(() => parseObservabilityQuery({ groupBy: 'a,a' }, allowed), code('INVALID_QUERY'));
  assert.throws(() => parseObservabilityQuery({ top: '101' }, allowed), code('INVALID_QUERY'));
  assert.throws(() => parseObservabilityQuery({
    from: '2026-09-08T00:00:00Z', to: '2026-09-09T00:00:00.001Z', interval: '1m',
  }, allowed), code('QUERY_TOO_LARGE'));
});
test('event cursor mechanisms are mutually exclusive and sequences preserve uint64 precision', () => {
  const allowed = ['after','afterSequence','cursor','limit'];
  assert.equal(parseObservabilityQuery({ afterSequence: '18446744073709551615' }, allowed).page.afterSequence, '18446744073709551615');
  for (const value of [{ after: 'a', afterSequence: '0' }, { cursor: 'a', after: 'b' }, { afterSequence: '18446744073709551616' }, { afterSequence: '01' }]) {
    assert.throws(() => parseObservabilityQuery(value, allowed), code('INVALID_QUERY'));
  }
});
test('signed cursor roundtrips normalized filters, position and uint64 snapshot sequence', () => {
  const service = new ObservabilityCursorService(config);
  const bind = binding(), state = cursorState();
  const opened = service.open(service.issue(bind, state), bind);
  assert.deepEqual(opened.filter, state.filter);
  assert.deepEqual(opened.position, state.position);
  assert.equal(opened.snapshotSeq, state.snapshotSeq);
});
test('signed cursor rejects body tampering, signature tampering and oversized input', () => {
  const service = new ObservabilityCursorService(config), bind = binding();
  const value = service.issue(bind, cursorState());
  const [body,signature] = value.split('.');
  const changedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body,'base64url')), snapshotSeq: '0' })).toString('base64url');
  for (const changed of [changedBody+'.'+signature, body+'.'+(signature[0] === 'A' ? 'B' : 'A')+signature.slice(1), 'x'.repeat(8193), 'invalid']) {
    assert.throws(() => service.open(changed, bind), code('INVALID_QUERY'));
  }
});
test('signed cursor cannot cross principals, asset scopes, extra permissions, routes or sort orders', () => {
  const service = new ObservabilityCursorService(config), bind = binding();
  const value = service.issue(bind, cursorState());
  const changes = [
    { authorization: authorized() }, { authorization: authorized([READ], ['runtime-b'], bind.authorization.principalId) },
    { authorization: authorized([READ,PAYLOAD], ['runtime-a'], bind.authorization.principalId) },
    { endpoint: 'obsListSources' }, { kind: 'event' }, { sort: 'ascending' },
  ];
  for (const change of changes) assert.throws(() => service.open(value, { ...bind,...change }), code('CURSOR_SCOPE_MISMATCH'));
});
test('expired query and event cursors return their distinct 410 errors', () => {
  const service = new ObservabilityCursorService(config);
  for (const kind of ['query','event']) {
    const bind = binding(undefined, { kind });
    const value = signedCursorChange(service.issue(bind, cursorState()), { issuedAt: Date.now()-3000, expiresAt: Date.now()-1000 });
    assert.throws(() => service.open(value, bind), code(kind === 'query' ? 'QUERY_CURSOR_EXPIRED' : 'EVENT_CURSOR_EXPIRED'));
  }
});
test('cursor resume restores its original relative window and rejects explicit filter changes', () => {
  const service = new ObservabilityCursorService(config), bind = binding();
  const value = service.issue(bind, cursorState()), opened = service.open(value, bind);
  const resumed = parseObservabilityQuery({ cursor: value, limit: '10' }, queryKeys, { previousFilter: opened.filter, now: queryTime+86400000 });
  service.assertFilter(opened, resumed.filter);
  assert.equal(resumed.filter.to, '2026-09-08T12:00:00.000Z');
  assert.equal(resumed.page.limit, 10);
  const changed = parseObservabilityQuery({ origin: 'test' }, queryKeys, { previousFilter: opened.filter });
  assert.throws(() => service.assertFilter(opened, changed.filter), code('CURSOR_SCOPE_MISMATCH'));
});
test('cursor configuration has no weak fallback and bounds lifetime and token size', () => {
  const bind = binding(), state = cursorState();
  for (const values of [{}, { API_NOVA_OBSERVABILITY_CURSOR_SECRET: 'short' }]) {
    assert.throws(() => new ObservabilityCursorService(new ConfigService(values)).issue(bind,state), code('OBSERVABILITY_UNAVAILABLE'));
  }
  const service = new ObservabilityCursorService(config);
  assert.throws(() => service.issue(bind,state,3600001), code('INVALID_QUERY'));
  assert.throws(() => service.issue(bind,state,0), code('INVALID_QUERY'));
  assert.throws(() => service.issue(bind,{ ...state, filter: Object.fromEntries(Array.from({length: 20}, (_,i) => ['field'+i,'x'.repeat(1000)])) }), code('QUERY_TOO_LARGE'));
});
test('cursor key changes invalidate old tokens without an implicit legacy-key path', () => {
  const bind = binding(), service = new ObservabilityCursorService(config);
  const value = service.issue(bind, cursorState());
  const replacement = new ObservabilityCursorService(new ConfigService({ ...settings, API_NOVA_OBSERVABILITY_CURSOR_SECRET: randomBytes(48).toString('hex') }));
  assert.throws(() => replacement.open(value, bind), code('INVALID_QUERY'));
});
test('resource ETags bind both identity and version and require one exact strong tag', () => {
  const value = observabilityEtag('subscription-a', 1);
  requireObservabilityIfMatch(value, 'subscription-a', 1);
  assert.throws(() => requireObservabilityIfMatch(undefined, 'subscription-a',1), code('PRECONDITION_REQUIRED'));
  for (const header of ['*', 'W/'+value, value+','+value, '', [value]]) {
    assert.throws(() => requireObservabilityIfMatch(header, 'subscription-a',1), code('INVALID_QUERY'));
  }
  assert.throws(() => requireObservabilityIfMatch(value,'subscription-b',1), code('PRECONDITION_FAILED'));
  assert.throws(() => requireObservabilityIfMatch(value,'subscription-a',2), code('PRECONDITION_FAILED'));
});
test('idempotency keys distinguish optional absence and required bounded visible strings', () => {
  assert.equal(observabilityIdempotencyKey(undefined), null);
  assert.equal(observabilityIdempotencyKey('abc'), 'abc');
  for (const value of [undefined, '', ' ', 'abc\\n', ['a','b'], 'x'.repeat(129)]) {
    if (value === 'abc\\n') assert.throws(() => observabilityIdempotencyKey('abc\n', true), code('INVALID_QUERY'));
    else assert.throws(() => observabilityIdempotencyKey(value,true), code('INVALID_QUERY'));
  }
});

async function databaseFixture(t) {
  const database = new DataSource({
    type: 'sqljs', entities: [...entities.CALL_OBSERVABILITY_ENTITIES, RuntimeObservabilityEventEntity],
    synchronize: true, logging: false,
  });
  t.after(async () => { if (database.isInitialized) await database.destroy(); });
  await database.initialize();
  // Command storage never invokes payload preparation; no filesystem store is created.
  const store = new CallObservabilityStore(database, {});
  const commands = new ObservabilityCommandStore(store, config);
  const authorization = authorized([READ,SUBSCRIBE,RETRY]);
  const command = { method: 'POST', path: '/api/v1/monitoring/observability/subscriptions', key: randomUUID(),
    request: { name: 'fixture', secretRef: 'fixture-secret-ref-not-for-storage' } };
  const authorize = async () => {};
  const operation = async tx => {
    const repository = tx.manager.getRepository(entities.RuntimePipelineStateEntity);
    const current = await repository.findOneBy({ id: 'fixture:resource' });
    const version = (current?.value.version || 0) + 1;
    const sequence = tx.nextSequence();
    await repository.save(repository.create({ id: 'fixture:resource', value: { version }, updatedAt: tx.now }));
    await repository.save(repository.create({ id: 'fixture:audit:'+sequence, value: { version }, updatedAt: tx.now }));
    return { statusCode: 201, resourceId: 'fixture-resource', version, operationId: 'fixture-operation-'+version };
  };
  return { database, store, commands, authorization, command, authorize, operation,
    receipts: database.getRepository(entities.RuntimeObservabilityIdempotencyEntity),
    state: database.getRepository(entities.RuntimePipelineStateEntity) };
}
test('idempotent operation, audit reference and receipt commit together without secret content', async t => {
  const f = await databaseFixture(t);
  const result = await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  assert.equal(result.replayed,false);
  assert.equal(await f.store.watermark(),'1');
  assert.equal(await f.receipts.count(),1);
  const serialized = JSON.stringify(await f.receipts.find());
  assert.equal(serialized.includes(f.command.key),false);
  assert.equal(serialized.includes(f.command.request.secretRef),false);
  assert.equal(serialized.includes(commandSecret),false);
  assert.ok(await f.state.findOneBy({id:'fixture:resource'}));
});
test('same idempotency request replays its result but rechecks authorization', async t => {
  const f = await databaseFixture(t);
  let checked=0;
  const authorize=async()=>{checked++;};
  const first = await f.commands.execute(f.authorization,f.command,authorize,f.operation);
  const second = await f.commands.execute(f.authorization,f.command,authorize,f.operation);
  assert.equal(second.replayed,true);
  assert.deepEqual(second.result,first.result);
  assert.equal(checked,2);
  assert.equal(await f.store.watermark(),'1');
});
test('canonical key order does not change idempotency request identity', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  const changed = {...f.command,request:{secretRef:f.command.request.secretRef,name:'fixture'}};
  assert.equal((await f.commands.execute(f.authorization,changed,f.authorize,f.operation)).replayed,true);
});
test('different content under one idempotency identity returns conflict without mutation', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  await assert.rejects(f.commands.execute(f.authorization,{...f.command,request:{name:'different'}},f.authorize,f.operation),code('IDEMPOTENCY_CONFLICT'));
  assert.equal(await f.store.watermark(),'1');
  assert.equal(await f.receipts.count(),1);
});
test('concurrent identical commands execute the mutation once', async t => {
  const f = await databaseFixture(t);
  const results = await Promise.all(Array.from({length:12},()=>f.commands.execute(f.authorization,f.command,f.authorize,f.operation)));
  assert.equal(results.filter(result=>!result.replayed).length,1);
  assert.equal(await f.receipts.count(),1);
  assert.equal(await f.store.watermark(),'1');
  assert.equal((await f.state.findOneByOrFail({id:'fixture:resource'})).value.version,1);
});
test('command failure rolls back mutation, audit, sequence and receipt', async t => {
  const f = await databaseFixture(t);
  await assert.rejects(f.commands.execute(f.authorization,f.command,f.authorize,async tx=>{
    await f.operation(tx); throw new Error('fixture-rollback');
  }),/fixture-rollback/);
  assert.equal(await f.receipts.count(),0);
  assert.equal(await f.state.count(),0);
  assert.equal(await f.store.watermark(),'0');
  assert.equal((await f.commands.execute(f.authorization,f.command,f.authorize,f.operation)).result.version,1);
});
test('revoked object access blocks a replay instead of returning its stored result', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  await assert.rejects(f.commands.execute(f.authorization,f.command,async(tx,previous)=>{
    assert.equal(previous.resourceId,'fixture-resource'); throw new ObservabilityApiError('NOT_FOUND');
  },f.operation),code('NOT_FOUND'));
  assert.equal(await f.store.watermark(),'1');
});
test('changed authorization scope cannot replay an earlier broader command', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  const narrowed = authorized([READ,SUBSCRIBE,RETRY],[],f.authorization.principalId);
  await assert.rejects(f.commands.execute(narrowed,f.command,f.authorize,f.operation),code('FORBIDDEN'));
  assert.equal(await f.store.watermark(),'1');
});
test('idempotency identity separates principal, HTTP method and canonical resource path', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  await f.commands.execute(authorized([READ,SUBSCRIBE,RETRY]),f.command,f.authorize,f.operation);
  await f.commands.execute(f.authorization,{...f.command,method:'PATCH'},f.authorize,f.operation);
  await f.commands.execute(f.authorization,{...f.command,path:f.command.path+'/other'},f.authorize,f.operation);
  assert.equal(await f.receipts.count(),4);
  assert.equal(await f.store.watermark(),'4');
});
test('expired idempotency records are replaced only within a new authorized transaction', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  const [receipt] = await f.receipts.find();
  await f.store.transaction(async tx=>{
    receipt.expiresAt=new Date(Date.parse(tx.now)-1000).toISOString();
    await tx.manager.getRepository(entities.RuntimeObservabilityIdempotencyEntity).save(receipt);
  });
  const result = await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  assert.equal(result.replayed,false);
  assert.equal(result.result.version,2);
  assert.equal(await f.receipts.count(),1);
});
test('request-digest secret rotation conflicts safely rather than duplicating an old operation', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  const rotated = new ObservabilityCommandStore(f.store,new ConfigService({
    ...settings, API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET:randomBytes(48).toString('hex'),
  }));
  await assert.rejects(rotated.execute(f.authorization,f.command,f.authorize,f.operation),code('IDEMPOTENCY_CONFLICT'));
  assert.equal(await f.store.watermark(),'1');
});
test('invalid paths, missing secrets and excessive request bodies fail before mutation', async t => {
  const f = await databaseFixture(t);
  for (const path of ['/outside','/api/v1/monitoring/observability/../secret','/api/v1/monitoring/observability/subscriptions?token=x']) {
    await assert.rejects(f.commands.execute(f.authorization,{...f.command,path},f.authorize,f.operation),code('INVALID_QUERY'));
  }
  const unavailable = new ObservabilityCommandStore(f.store,new ConfigService({}));
  await assert.rejects(unavailable.execute(f.authorization,f.command,f.authorize,f.operation),code('OBSERVABILITY_UNAVAILABLE'));
  await assert.rejects(f.commands.execute(f.authorization,{...f.command,request:'x'.repeat(1024*1024)},f.authorize,f.operation),code('QUERY_TOO_LARGE'));
  assert.equal(await f.receipts.count(),0);
});
test('unsafe operation results roll back rather than persisting arbitrary response secrets', async t => {
  const f = await databaseFixture(t);
  await assert.rejects(f.commands.execute(f.authorization,f.command,f.authorize,async tx=>({
    ...await f.operation(tx),secret:'must-not-be-stored',
  })),code('OBSERVABILITY_UNAVAILABLE'));
  assert.equal(await f.receipts.count(),0);
  assert.equal(await f.state.count(),0);
});
test('version preconditions execute under the same transaction as concurrent mutations', async t => {
  const f = await databaseFixture(t);
  await f.commands.execute(f.authorization,f.command,f.authorize,f.operation);
  const header=observabilityEtag('fixture-resource',1);
  const operation=async tx=>{
    const row=await tx.manager.getRepository(entities.RuntimePipelineStateEntity).findOneByOrFail({id:'fixture:resource'});
    requireObservabilityIfMatch(header,'fixture-resource',row.value.version);
    return f.operation(tx);
  };
  const outcomes=await Promise.allSettled([1,2].map(index=>f.commands.execute(f.authorization,{...f.command,key:'conditional-'+index},f.authorize,operation)));
  assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(value=>value.status==='rejected'&&code('PRECONDITION_FAILED')(value.reason)).length,1);
  assert.equal((await f.state.findOneByOrFail({id:'fixture:resource'})).value.version,2);
  assert.equal(await f.receipts.count(),2);
});
