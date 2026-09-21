import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateRuntimeRequest } from './runtime-auth';
import { normalizeRuntimeJwtPolicy, readRuntimeJwtPolicy } from './runtime-jwt-policy';

describe('JWT verification policy', () => {
  const baseline = ['sub', 'exp', 'iat'];
  const original = { ...process.env };
  const issuer = 'https://jwt-policy.example';
  let rsa: any;
  let ec: any;
  beforeAll(async () => {
    rsa = await generateKeyPair('RS256'); ec = await generateKeyPair('ES256');
    process.env.API_NOVA_RUNTIME_ISSUER = issuer;
    process.env.API_NOVA_RUNTIME_RESOURCE = 'https://runtime.example';
    process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [
      { ...await exportJWK(rsa.publicKey), kid: 'rsa' }, { ...await exportJWK(ec.publicKey), kid: 'ec' },
    ] });
    delete process.env.API_NOVA_RUNTIME_JWKS_URI;
    delete process.env.API_NOVA_RUNTIME_JWT_POLICY;
    delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
  });
  afterAll(() => { process.env = original; });
  const sign = (claims: Record<string, unknown> = {}, alg = 'RS256') => new SignJWT({
    sub: 'user', iss: issuer, aud: 'https://runtime.example', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120, ...claims,
  }).setProtectedHeader({ alg, kid: alg === 'RS256' ? 'rsa' : 'ec' }).sign(alg === 'RS256' ? rsa.privateKey : ec.privateKey);
  const auth = async (claims = {}, policy?: unknown, alg = 'RS256') => authenticateRuntimeRequest(
    { authorization: `Bearer ${await sign(claims, alg)}` }, 'gateway', 'jwt', policy);

  it.each([null, [], { algorithms: [] }, { algorithms: ['none'] }, { algorithms: ['HS256'] },
    { requiredClaims: ['sub'] }, { requiredClaims: ['sub', 'exp', 'iat', ''] }, { clockToleranceSeconds: -1 },
    { clockToleranceSeconds: 301 }, { clockToleranceSeconds: 1.5 }, { clockToleranceSeconds: '2' },
    { algorithms: null }, { requiredClaims: null }, { clockToleranceSeconds: null }, { algorithm: 'RS256' }])(
    'fails closed for malformed policy %j', policy => {
      expect(() => normalizeRuntimeJwtPolicy(policy)).toThrow('invalid_jwt_policy');
    });
  it('retains backward-compatible defaults', async () => {
    expect(normalizeRuntimeJwtPolicy()).toEqual({ algorithms: ['RS256', 'ES256'], requiredClaims: baseline, clockToleranceSeconds: 0 });
    await expect(auth()).resolves.toMatchObject({ subject: 'user' });
  });
  it('allows only configured asymmetric algorithms', async () => {
    await expect(auth({}, { algorithms: ['ES256'] })).rejects.toMatchObject({ status: 401 });
    await expect(auth({}, { algorithms: ['ES256'] }, 'ES256')).resolves.toMatchObject({ subject: 'user' });
  });
  it('requires additional claims without weakening baseline claims', async () => {
    const policy = { requiredClaims: [...baseline, 'tenant', 'jti'] };
    await expect(auth({ tenant: 'a' }, policy)).rejects.toMatchObject({ status: 401 });
    await expect(auth({ tenant: 'a', jti: 'id' }, policy)).resolves.toMatchObject({ subject: 'user' });
    for (const claim of baseline) await expect(auth({ [claim]: undefined }, policy)).rejects.toMatchObject({ status: 401 });
  });
  it('applies bounded skew to expiry and not-before without relaxing audience or issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(auth({ exp: now - 5 })).rejects.toMatchObject({ status: 401 });
    await expect(auth({ exp: now - 5 }, { clockToleranceSeconds: 20 })).resolves.toMatchObject({ subject: 'user', expiresAt: now - 5, authorizationExpiresAt: now + 15 });
    await expect(auth({ nbf: now + 5 }, { clockToleranceSeconds: 20 })).resolves.toMatchObject({ subject: 'user' });
    for (const claims of [{ exp: now - 60 }, { nbf: now + 60 }, { aud: 'other' }, { iss: 'https://other.example' }]) {
      await expect(auth(claims, { clockToleranceSeconds: 20 })).rejects.toMatchObject({ status: 401 });
    }
  });
  it('uses host policy unless an explicit persisted policy is supplied', async () => {
    process.env.API_NOVA_RUNTIME_JWT_POLICY = JSON.stringify({ algorithms: ['ES256'] });
    await expect(auth()).rejects.toMatchObject({ status: 401 });
    await expect(auth({}, { algorithms: ['RS256'] })).resolves.toMatchObject({ subject: 'user' });
    process.env.API_NOVA_RUNTIME_JWT_POLICY = '{';
    expect(() => readRuntimeJwtPolicy()).toThrow('invalid_jwt_policy');
    await expect(auth()).rejects.toMatchObject({ status: 503, code: 'invalid_jwt_policy' });
    delete process.env.API_NOVA_RUNTIME_JWT_POLICY;
  });
});
