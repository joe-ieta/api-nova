'use strict';

// Test-runner session only: authenticate through the ordinary product login API.
// JWT expiry is a scheduling hint; the server still validates every bearer token.
function createObservabilityManagementSession({ baseUrl, request, username, password,
  timeoutMs, rememberSecret = () => {}, now = Date.now }) {
  let accessToken;
  let expiresAt = 0;
  let loginFlight;

  async function tokenForRequest(rejectedToken) {
    if (rejectedToken && accessToken && rejectedToken !== accessToken) return accessToken;
    if (!rejectedToken && accessToken && expiresAt - now() > 60000) return accessToken;
    if (loginFlight) return loginFlight;
    loginFlight = (async () => {
      // Never call the authenticated request wrapper recursively.
      const response = await request(`${baseUrl}/api/auth/login`, {
        method: 'POST', body: { username, password }, timeoutMs,
      });
      if (response.status !== 200) throw new Error(`Management session login failed (HTTP ${response.status})`);
      const token = response.body?.accessToken;
      if (typeof token !== 'string' || !token) throw new Error('Management session login returned no access token');
      rememberSecret(token);
      if (typeof response.body?.refreshToken === 'string') rememberSecret(response.body.refreshToken);
      let expiry;
      try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid JWT');
        expiry = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
      } catch { throw new Error('Management session login returned an invalid token expiry'); }
      if (!Number.isSafeInteger(expiry) || expiry * 1000 <= now()) {
        throw new Error('Management session login returned an expired or invalid token');
      }
      accessToken = token;
      expiresAt = expiry * 1000;
      return token;
    })().finally(() => { loginFlight = undefined; });
    return loginFlight;
  }

  return {
    async login() { await tokenForRequest(); },
    async request(method, url, body, options = {}) {
      const verb = method.toUpperCase();
      options.signal?.throwIfAborted();
      const token = await tokenForRequest();
      options.signal?.throwIfAborted();
      const send = bearer => request(`${baseUrl}/api${url}`, {
        ...options, method: verb, body, timeoutMs: options.timeoutMs ?? timeoutMs,
        headers: { ...options.headers, authorization: `Bearer ${bearer}` },
      });
      const response = await send(token);
      // Only safe reads may be retried, once. A 401 mutation can have an unknown
      // outcome in intermediaries and must never be replayed by this harness.
      if (verb !== 'GET' || response.status !== 401) return response;
      options.signal?.throwIfAborted();
      const renewed = await tokenForRequest(token);
      options.signal?.throwIfAborted();
      return send(renewed);
    },
  };
}

module.exports = { createObservabilityManagementSession };
