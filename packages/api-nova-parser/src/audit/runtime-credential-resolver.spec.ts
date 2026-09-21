import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import { resolveRuntimeCredentials } from './runtime-credential-resolver';
import { authenticateRuntimeRequest } from './runtime-auth';

describe('per-request runtime DB resolver boundary', () => {
  let server: Server;
  let env: NodeJS.ProcessEnv;
  let original: NodeJS.ProcessEnv;
  let body: string;
  beforeEach(async () => {
    original = { ...process.env };
    body = JSON.stringify({ version: 1, runtimeAssetId: 'runtime', credentials: [] });
    server = createServer((req, res) => {
      expect(req.url).toBe('/credentials');
      expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
      res.end(body);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    env = { API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL: `http://127.0.0.1:${(server.address() as any).port}/credentials`,
      API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_TOKEN: 'a'.repeat(64), API_NOVA_RUNTIME_CREDENTIAL_RUNTIME_ID: 'runtime' };
  });
  afterEach(async () => { process.env = original; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('reads every request and rejects mismatched runtime without returning previous good data', async () => {
    expect((await resolveRuntimeCredentials(env)).credentials).toEqual([]);
    body = JSON.stringify({ version: 1, runtimeAssetId: 'other', credentials: [] });
    await expect(resolveRuntimeCredentials(env)).rejects.toMatchObject({ status: 503 });
  });
  it.each(['http://example.com/credentials', 'https://127.0.0.1:443/credentials', 'http://127.0.0.1:99/credentials?runtime=other',
    'http://user:pass@127.0.0.1:99/credentials', 'http://127.0.0.1:99/other'])('rejects noncanonical resolver URL %s', async url => {
    await expect(resolveRuntimeCredentials({ ...env, API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL: url })).rejects.toMatchObject({ status: 503 });
  });
  it('bounds response bytes and rejects malformed body', async () => {
    body = 'x'.repeat(2 * 1024 * 1024 + 1);
    await expect(resolveRuntimeCredentials(env)).rejects.toMatchObject({ status: 503 });
    body = '{';
    await expect(resolveRuntimeCredentials(env)).rejects.toMatchObject({ status: 503 });
  });
  it('fails closed when database source was selected but no resolver was supplied', async () => {
    process.env = { ...original, API_NOVA_RUNTIME_CREDENTIAL_SOURCE: 'database', API_NOVA_RUNTIME_ACCESS_CREDENTIALS: JSON.stringify({ version: 1, runtimeAssetId: 'runtime', credentials: [] }) };
    delete process.env.API_NOVA_RUNTIME_CREDENTIAL_RESOLVER_URL;
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'test.secret' }, 'mcp', 'api_key')).rejects.toMatchObject({ status: 503 });
  });
  it('never falls back to a static snapshot if resolver fails', async () => {
    process.env = { ...original, ...env, API_NOVA_RUNTIME_ACCESS_CREDENTIALS: JSON.stringify({ version: 1, runtimeAssetId: 'runtime', credentials: [] }) };
    body = '{';
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'test.secret' }, 'mcp', 'api_key')).rejects.toMatchObject({ status: 503 });
  });
});
