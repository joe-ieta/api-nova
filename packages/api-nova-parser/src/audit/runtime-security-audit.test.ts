import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateRuntimeRequest, runtimeChallenge } from './runtime-auth';
import { auditDigest, beginRuntimeCall, captureAuditBody, createAuditBodyTracker,
  getRuntimeCallContext, listObservedRuntimeCallers, redactAuditHeaders, redactAuditUrl, withRuntimeCallContext } from './runtime-call-audit';

describe('runtime authentication and audit contract', () => {
  it('redacts explicitly configured vendor credential headers', () => {
    expect(redactAuditHeaders({ 'X-Vendor-Auth': 'vendor-secret', accept: 'application/json' }, ['x-vendor-auth']))
      .toEqual({ 'X-Vendor-Auth': '[REDACTED]', accept: 'application/json' });
  });
  let directory: string;
  let original: NodeJS.ProcessEnv;
  let privateKey: any;
  const issuer = 'https://identity.example';
  const resource = 'https://runtime.example/mcp';
  beforeAll(async () => {
    original = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), 'api-nova-security-audit-'));
    process.env.API_NOVA_AUDIT_DIR = directory;
    process.env.API_NOVA_RUNTIME_AUTH_MODE = 'oauth';
    process.env.API_NOVA_RUNTIME_ISSUER = issuer;
    process.env.API_NOVA_RUNTIME_RESOURCE = resource;
    delete process.env.API_NOVA_RUNTIME_JWKS_URI;
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test' }] });
    process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES = 'api:invoke';
  });
  afterAll(async () => {
    process.env = original;
    await rm(directory, { recursive: true, force: true });
  });
  const token = (overrides: Record<string, unknown> = {}) => new SignJWT({ sub: 'caller-1', iss: issuer,
    aud: resource, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    scope: 'api:invoke', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);

  it('verifies unknown callers without preregistration and keeps identity across token renewal', async () => {
    const first = await authenticateRuntimeRequest({ authorization: `Bearer ${await token()}` }, 'mcp');
    const second = await authenticateRuntimeRequest({ authorization: `Bearer ${await token({ jti: 'new-token' })}` }, 'gateway');
    expect(first.callerId).toBe(second.callerId);
    expect(first.identitySource).toBe('authenticated');
    for (const transport of ['gateway', 'mcp'] as const) {
      const call = beginRuntimeCall({ transport, requestId: transport, callerId: first.callerId,
        identitySource: 'authenticated', callerIssuer: first.issuer, callerSubject: first.subject }, 'api');
      await call.finish({ outcome: 'success' });
    }
    const callers = await listObservedRuntimeCallers();
    expect(callers).toHaveLength(1);
    expect(callers[0].transports.sort()).toEqual(['gateway', 'mcp']);
    expect(callers[0].subject).toBe('caller-1');
  });

  it.each([{ aud: 'https://another.example' }, { iss: 'https://untrusted.example' },
    { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 3600 }])('rejects invalid token claims %j', async overrides => {
    await expect(authenticateRuntimeRequest({ authorization: `Bearer ${await token(overrides)}` }, 'mcp'))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rejects missing tokens, insufficient scopes, and unsigned tokens', async () => {
    await expect(authenticateRuntimeRequest({}, 'mcp')).rejects.toMatchObject({ status: 401 });
    await expect(authenticateRuntimeRequest({ authorization: `Bearer ${await token({ scope: '' })}` }, 'mcp'))
      .rejects.toMatchObject({ status: 403 });
    await expect(authenticateRuntimeRequest({ authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' }, 'mcp'))
      .rejects.toMatchObject({ status: 401 });
    expect(runtimeChallenge('mcp')).toMatch(/^Bearer resource_metadata=/);
  });

  it('binds private API keys to a stable subject, allowed resources and expiry', async () => {
    const entry = { id: 'key-old', subject: 'service-a', secretHash: auditDigest('key-secret-old'),
      resources: [resource], scopes: ['api:invoke'], expiresAt: Math.floor(Date.now() / 1000) + 300 };
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([entry,
      { ...entry, id: 'key-new', secretHash: auditDigest('key-secret-new') }]);
    const first = await authenticateRuntimeRequest({ 'x-api-key': 'key-secret-old' }, 'mcp', 'api_key');
    const next = await authenticateRuntimeRequest({ 'x-api-key': 'key-secret-new' }, 'gateway', 'api_key');
    expect(next.callerId).toBe(first.callerId);
    expect(next.credentialId).not.toBe(first.credentialId);
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'unknown' }, 'mcp', 'api_key'))
      .rejects.toMatchObject({ status: 401 });
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([{ ...entry, resources: [] }]);
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'key-secret-old' }, 'mcp', 'api_key'))
      .rejects.toMatchObject({ status: 403 });
    process.env.API_NOVA_RUNTIME_API_KEYS = JSON.stringify([{ ...entry, expiresAt: 1 }]);
    await expect(authenticateRuntimeRequest({ 'x-api-key': 'key-secret-old' }, 'mcp', 'api_key'))
      .rejects.toMatchObject({ status: 401 });
  });

  it('stores real bodies beyond 4 KB with JSON and query credential redaction', () => {
    const message = 'x'.repeat(9000);
    const body = captureAuditBody({ message, password: 'never-store', child: { access_token: 'never-store' } });
    expect(JSON.parse(body.data!)).toEqual({ message, password: '[REDACTED]', child: { access_token: '[REDACTED]' } });
    expect(body.state).toBe('complete');
    expect(body.totalBytes).toBeGreaterThan(4096);
    expect(redactAuditUrl('https://x.test/p?api_key=never-store&q=1')).not.toContain('never-store');
    const form = captureAuditBody('password=never-store&keep=yes', 'application/x-www-form-urlencoded');
    expect(form.data).not.toContain('never-store');
    const tool = captureAuditBody({ content: [{ type: 'text', text: 'HTTP 200\n```json\n{"password": "never-store"}\n```' }] });
    expect(tool.data).not.toContain('never-store');
    expect(captureAuditBody('<password>never-store</password>', 'text/xml').data).not.toContain('never-store');
  });

  it('explicitly omits oversized, malformed and interrupted structured bodies without leaking fragments', () => {
    const tracker = createAuditBodyTracker('application/json', 20);
    tracker.observe('{"password":"never-store-this-secret"}');
    expect(tracker.finish()).toMatchObject({ state: 'omitted', reason: 'size_limit', capturedBytes: 0 });
    expect(tracker.finish().data).toBeUndefined();
    expect(captureAuditBody('{"password":"never-store')).toMatchObject({ state: 'omitted', reason: 'invalid_json' });
    const interrupted = createAuditBodyTracker('application/json');
    interrupted.observe('{"secret":"never-store');
    expect(interrupted.finish(false)).toMatchObject({ state: 'incomplete', reason: 'stream_interrupted' });
  });

  it('preserves binary bytes and distinguishes empty bodies', () => {
    const bytes = Buffer.from([0, 255, 12, 10]);
    const body = captureAuditBody(bytes, 'application/octet-stream');
    expect(Buffer.from(body.data!, 'base64')).toEqual(bytes);
    expect(body.sha256).toBe(auditDigest(bytes));
    expect(captureAuditBody(undefined).state).toBe('empty');
  });

  it('captures multipart fields and file bytes while redacting credential fields', () => {
    const form = Buffer.concat([
      Buffer.from('--audit\r\nContent-Disposition: form-data; name="password"\r\n\r\nnever-store\r\n'),
      Buffer.from('--audit\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.from([0, 255, 1]), Buffer.from('\r\n--audit--\r\n'),
    ]);
    const body = captureAuditBody(form, 'multipart/form-data; boundary=audit');
    expect(body.state).toBe('complete');
    expect(body.data).not.toContain('never-store');
    const parts = JSON.parse(body.data!).parts;
    expect(parts[0].body).toBe('[REDACTED]');
    expect(Buffer.from(parts[1].body.data, 'base64')).toEqual(Buffer.from([0, 255, 1]));
    expect(captureAuditBody(form, 'multipart/form-data; boundary=wrong').state).toBe('omitted');
  });

  it('isolates concurrent request contexts and serializes valid JSONL records', async () => {
    await Promise.all([1, 2, 3].map(async id => withRuntimeCallContext({ transport: 'mcp',
      requestId: String(id), identitySource: 'anonymous' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 4 - id));
      const call = beginRuntimeCall(getRuntimeCallContext()!, 'tool');
      expect(call.record.requestId).toBe(String(id));
      await call.finish({ outcome: 'success', request: captureAuditBody({ id }) });
    })));
    const files = (await readdir(directory)).filter(file => /^\d{4}-/.test(file));
    const records = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8'))))
      .flatMap(data => data.trim().split('\n').map(line => JSON.parse(line)));
    expect(new Set(records.map(item => item.invocationId)).size).toBe(records.length);
    expect(records.every(item => item.completedAt >= item.startedAt)).toBe(true);
  });

  it('reports storage failures without leaking payloads or failing the API call', async () => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'fixture');
    process.env.API_NOVA_AUDIT_DIR = file;
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const call = beginRuntimeCall({ transport: 'gateway', requestId: 'failure', identitySource: 'anonymous' }, 'api');
      await expect(call.finish({ request: captureAuditBody({ private: 'never-print' }) })).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('RUNTIME_AUDIT_WRITE_FAILED'));
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('never-print');
    } finally { stderr.mockRestore(); process.env.API_NOVA_AUDIT_DIR = directory; }
  });
});
