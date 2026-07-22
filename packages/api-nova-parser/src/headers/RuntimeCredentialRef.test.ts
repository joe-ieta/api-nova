import { resolveRuntimeCredentialRefHeaders } from './RuntimeCredentialRef';

describe('resolveRuntimeCredentialRefHeaders', () => {
  it('resolves multiple header values without persisting their secrets in the reference', () => {
    expect(resolveRuntimeCredentialRefHeaders(
      'env-headers:Authorization=ORDER_API_TOKEN;X-Api-Key=ORDER_API_KEY',
      { ORDER_API_TOKEN: 'Bearer secret', ORDER_API_KEY: 'key-secret' },
    )).toEqual({ authorization: 'Bearer secret', 'x-api-key': 'key-secret' });
  });

  it('rejects missing environment variables and transport-owned headers', () => {
    expect(() => resolveRuntimeCredentialRefHeaders(
      'env-headers:Authorization=MISSING_TOKEN',
      {},
    )).toThrow("Runtime credential environment variable 'MISSING_TOKEN' is not configured");
    expect(() => resolveRuntimeCredentialRefHeaders(
      'env-headers:Host=UPSTREAM_HOST',
      { UPSTREAM_HOST: 'evil.example' },
    )).toThrow("Runtime credentialRef contains forbidden header 'Host'");
  });
});
