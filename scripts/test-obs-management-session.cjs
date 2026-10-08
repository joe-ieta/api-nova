'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHmac, randomUUID } = require('node:crypto');
const { createObservabilityManagementSession } = require('./obs-management-session.cjs');

async function fixture(t) {
  const username = 'fixture-admin', password = randomUUID(), signingKey = randomUUID();
  let clock = Date.now(), issued = 0, loginCalls = 0, loginAllowed = true, rejectAll = false;
  const revoked = new Set(), calls = [], remembered = [];
  const mint = () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(clock / 1000) + 900, jti: ++issued })).toString('base64url');
    return `${header}.${payload}.` + createHmac('sha256', signingKey).update(`${header}.${payload}`).digest('base64url');
  };
  const valid = token => {
    try {
      const [header, payload, signature] = token.split('.');
      return signature === createHmac('sha256', signingKey).update(`${header}.${payload}`).digest('base64url') &&
        JSON.parse(Buffer.from(payload, 'base64url')).exp * 1000 > clock && !revoked.has(token) && !rejectAll;
    } catch { return false; }
  };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/auth/login') {
      loginCalls++;
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined, 'login must use raw unauthenticated request');
      assert(input.username === username && input.password === password);
      await new Promise(resolve => setTimeout(resolve, 20));
      response.statusCode = loginAllowed ? 200 : 401;
      response.end(JSON.stringify(loginAllowed ? { accessToken: mint() } : { echoedSecret: password }));
      return;
    }
    const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
    calls.push({ method: request.method, url: request.url, token });
    response.statusCode = valid(token) ? 200 : 401;
    response.end(JSON.stringify({ accepted: response.statusCode === 200 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(url, { method: options.method, headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal || AbortSignal.timeout(options.timeoutMs) });
    return { status: response.status, body: await response.json() };
  };
  const session = createObservabilityManagementSession({ baseUrl, request, username, password, timeoutMs: 2000,
    rememberSecret: token => remembered.push(token), now: () => clock });
  return { session, calls, remembered, password, revoked, get logins() { return loginCalls; },
    advance: milliseconds => { clock += milliseconds; },
    allowLogin: value => { loginAllowed = value; }, rejectAll: value => { rejectAll = value; } };
}

test('normal login renews once before the 60 second margin across concurrent real HTTP reads', async t => {
  const f = await fixture(t); await f.session.login();
  assert.equal(f.logins, 1);
  f.advance(841000);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.session.request('GET', `/items/${index}`)));
  assert(results.every(result => result.status === 200));
  assert.equal(f.logins, 2); assert.equal(f.remembered.length, 2);
  assert(f.calls.every(call => call.token === f.remembered[1]));
});

test('concurrent GET 401 responses share one real re-login and each retry only once', async t => {
  const f = await fixture(t); await f.session.login(); f.revoked.add(f.remembered[0]);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.session.request('GET', `/items/${index}`)));
  assert(results.every(result => result.status === 200)); assert.equal(f.logins, 2);
  assert.equal(f.calls.length, 24);
  f.rejectAll(true);
  assert.equal((await f.session.request('GET', '/still-forbidden')).status, 401);
  assert.equal(f.logins, 3);
  assert.equal(f.calls.filter(call => call.url === '/api/still-forbidden').length, 2);
});

test('POST, PUT, PATCH and DELETE 401 outcomes are never replayed or trigger reactive login', async t => {
  const f = await fixture(t); await f.session.login(); f.rejectAll(true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await f.session.request(method, '/mutation', { change: true })).status, 401);
    assert.equal(f.calls.filter(call => call.method === method).length, 1);
  }
  assert.equal(f.logins, 1);
});

test('failed single-flight login rejects safely, then a subsequent normal login can recover', async t => {
  const f = await fixture(t); f.allowLogin(false);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.session.request('GET', '/items')));
  assert(results.every(result => result.status === 'rejected' && /login failed \(HTTP 401\)/.test(result.reason.message) &&
    !result.reason.message.includes(f.password)));
  assert.equal(f.logins, 1); assert.equal(f.calls.length, 0);
  f.allowLogin(true); assert.equal((await f.session.request('GET', '/items')).status, 200); assert.equal(f.logins, 2);
});

test('an already cancelled observation does not start login or send a management request', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.session.request('GET', '/items', undefined, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.logins, 0); assert.equal(f.calls.length, 0);
});
