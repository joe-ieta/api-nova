import { ConfigService } from '@nestjs/config';
import { mkdtemp, writeFile, unlink, rmdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { GatewayUpstreamCredentialAdminService } from './gateway-upstream-credential-admin.service';

function candidate(revision = 'r1') {
  return { apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'fixture' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { memory: { type: 'env' } }, credentials: { token: { type: 'bearer', secretRef: 'memory:FIXTURE' } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset', match: { scheme: 'https', host: 'example.invalid', port: 443, basePath: '/' },
      allowedHosts: ['example.invalid'], credential: 'token', endpoints: [] }] };
}
const actor = randomUUID();
const body = { expectedGeneration: 1, reason: 'fixture manual activation' };
describe('credential management manual reload', () => {
  let directory: string, file: string, registry: UpstreamCredentialRegistry, audit: any, service: GatewayUpstreamCredentialAdminService;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'apinova-admin-fixture-')));
    file = join(directory, 'bindings.json');
    await writeFile(file, JSON.stringify(candidate('r2')));
    registry = new UpstreamCredentialRegistry({ environment: 'fixture', providerFactory: () => ({ type: 'env', resolve: async () => 'synthetic-private-value' }) });
    await registry.reload(candidate());
    audit = { log: jest.fn(async () => ({ id: randomUUID() })) };
    service = new GatewayUpstreamCredentialAdminService(registry, new ConfigService({
      API_NOVA_UPSTREAM_CREDENTIAL_FILE: file, API_NOVA_UPSTREAM_CREDENTIAL_FORMAT: 'json' }), audit);
  });
  afterEach(async () => { await unlink(file); await rmdir(directory); });
  it('reloads the same registry from the configured stable file and audits actor with metadata only', async () => {
    const old = registry.captureSnapshot();
    const result = await service.reload(body, actor);
    expect(result).toMatchObject({ revision: 'r2', generation: 2, reloading: false });
    expect(registry.captureSnapshot()).not.toBe(old);
    expect(audit.log.mock.calls.map(([entry]: any) => entry.status)).toEqual(['pending', 'success']);
    expect(audit.log.mock.calls[1][0]).toMatchObject({ userId: actor, details: { beforeGeneration: 1, generation: 2, reasonProvided: true } });
    for (const forbidden of [file, 'synthetic-private-value', 'memory:FIXTURE', body.reason]) {
      expect(JSON.stringify([result, audit.log.mock.calls])).not.toContain(forbidden);
    }
  });
  it.each([{ ...body, file: '/private' }, { ...body, secret: 'x' }, { expectedGeneration: 1 }, { ...body, reason: 'x'.repeat(501) }, { ...body, expectedGeneration: -1 }])('rejects arbitrary input %j', async input => {
    await expect(service.reload(input, actor)).rejects.toMatchObject({ response: { code: 'INVALID_RELOAD_REQUEST' } });
    expect(registry.getStatus().generation).toBe(1);
    expect(audit.log).not.toHaveBeenCalled();
  });
  it('fails closed with disabled registry and reveals no source', async () => {
    const disabled = new GatewayUpstreamCredentialAdminService(null, new ConfigService(), audit);
    expect(disabled.status()).toEqual({ configured: false, state: 'disabled', generation: 0, reloading: false });
    await expect(disabled.reload(body, actor)).rejects.toMatchObject({ response: { code: 'UPSTREAM_CREDENTIALS_NOT_CONFIGURED' } });
  });
  it('records stale generation rejection without changing the snapshot', async () => {
    await expect(service.reload({ ...body, expectedGeneration: 0 }, actor)).rejects.toMatchObject({ response: { code: 'GENERATION_CONFLICT' } });
    expect(audit.log.mock.calls[0][0]).toMatchObject({ status: 'failed', details: { result: 'GENERATION_CONFLICT' } });
    expect(registry.getStatus().generation).toBe(1);
  });
  it('rejects overlapping requests while one stable read is active', async () => {
    const first = service.reload(body, actor);
    await expect(service.reload(body, actor)).rejects.toMatchObject({ response: { code: 'RELOAD_IN_PROGRESS' } });
    await first;
    expect(registry.getStatus().generation).toBe(2);
  });
  it('retains the old snapshot and records failed invalid candidates without raw source', async () => {
    const previous = registry.captureSnapshot();
    await writeFile(file, '{invalid synthetic-private-value');
    await expect(service.reload(body, actor)).rejects.toMatchObject({ response: { code: 'CANDIDATE_REJECTED', generation: 1 } });
    expect(registry.captureSnapshot()).toBe(previous);
    expect(audit.log.mock.calls[1][0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('synthetic-private-value');
  });
  it('does not activate if initial durable audit fails', async () => {
    audit.log.mockRejectedValueOnce(new Error('private audit failure'));
    await expect(service.reload(body, actor)).rejects.toMatchObject({ response: { code: 'RELOAD_AUDIT_UNAVAILABLE', generation: 1 } });
    expect(registry.getStatus().generation).toBe(1);
  });
  it('reports actual activated generation if completion audit fails', async () => {
    audit.log.mockResolvedValueOnce({ id: randomUUID() }).mockRejectedValueOnce(new Error('private audit failure'));
    await expect(service.reload(body, actor)).rejects.toMatchObject({ response: { code: 'RELOAD_AUDIT_UNAVAILABLE', generation: 2 } });
    expect(service.status()).toMatchObject({ revision: 'r2', generation: 2, reloading: false });
  });
});
