import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UpstreamCredentialRegistry } from './registry';

function document(revision = 'r1') {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode: 'watch', debounceMs: 80, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'env:SYNTHETIC_WATCH' } },
    sites: [{ id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
      allowedHosts: ['api.example.com'], credential: 'token', endpoints: [] }],
  };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(10);
  expect(check()).toBe(true);
}

describe('host-owned credential file watch lifecycle', () => {
  let directory: string, file: string, registry: UpstreamCredentialRegistry;
  let resolveSecret: () => Promise<string>;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'api-nova-watch-')));
    file = join(directory, 'bindings.json');
    resolveSecret = async () => 'synthetic-watch-secret';
    registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: () => ({ type: 'env', resolve: () => resolveSecret() }) });
    await fs.writeFile(file, JSON.stringify(document()));
  });
  afterEach(async () => {
    registry.stopWatching();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('coalesces bursts, ignores other files and survives repeated atomic replacements', async () => {
    await registry.startWatchingFile(file, 'json');
    const original = registry.captureSnapshot();
    await fs.writeFile(join(directory, 'other.json'), JSON.stringify(document('unrelated')));
    await delay(160);
    expect(registry.captureSnapshot()).toBe(original);
    await fs.writeFile(file, JSON.stringify(document('r2')));
    await fs.writeFile(file, JSON.stringify(document('r3')));
    await until(() => registry.getStatus().revision === 'r3');
    expect(registry.getStatus().generation).toBe(2);
    for (const revision of ['r4', 'r5']) {
      const staging = join(directory, 'replacement.json');
      await fs.writeFile(staging, JSON.stringify(document(revision)));
      await fs.rename(staging, file);
      await until(() => registry.getStatus().revision === revision);
    }
  });

  test('bad text and provider errors preserve the old snapshot, then recover', async () => {
    await registry.startWatchingFile(file, 'json');
    const original = registry.captureSnapshot();
    await fs.writeFile(file, '{sensitive-synthetic-watch-secret');
    await until(() => registry.getStatus().lastReloadError === 'CANDIDATE_REJECTED');
    expect(registry.captureSnapshot()).toBe(original);
    resolveSecret = async () => { throw new Error('sensitive-path-and-secret'); };
    await fs.writeFile(file, JSON.stringify(document('r2')));
    await until(() => registry.getStatus().lastReloadError === 'SECRET_RESOLUTION_FAILED');
    expect(JSON.stringify(registry.getStatus())).not.toContain('sensitive');
    expect(registry.captureSnapshot()).toBe(original);
    resolveSecret = async () => 'recovered-secret';
    await fs.writeFile(file, JSON.stringify(document('r3')));
    await until(() => registry.getStatus().revision === 'r3');
    expect(await registry.captureSnapshot().resolveSecret('token')).toBe('recovered-secret');
  });

  test('pins the source and mode while watching', async () => {
    await registry.startWatchingFile(file, 'json');
    await expect(registry.startWatchingFile(file, 'json')).rejects.toMatchObject({ code: 'WATCH_ALREADY_STARTED' });
    await expect(registry.reloadFile(join(directory, 'other'), 'json')).rejects.toMatchObject({ code: 'WATCH_SOURCE_MISMATCH' });
    await expect(registry.reload(document('r2'))).rejects.toMatchObject({ code: 'WATCH_SOURCE_MISMATCH' });
    await expect(registry.reloadText(JSON.stringify(document('r2')), 'json')).rejects.toMatchObject({ code: 'WATCH_SOURCE_MISMATCH' });
    const changed = document('r2'); changed.reload.mode = 'manual';
    await fs.writeFile(file, JSON.stringify(changed));
    await until(() => registry.getStatus().lastReloadError === 'UNSUPPORTED_RELOAD_MODE');
    expect(registry.getStatus().revision).toBe('r1');
  });

  test('serializes admin reload and replays changes arriving during provider resolution', async () => {
    await registry.startWatchingFile(file, 'json');
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let entered = false;
    resolveSecret = async () => { entered = true; await gate; return 'synthetic-watch-secret'; };
    await fs.writeFile(file, JSON.stringify(document('r2')));
    const manual = registry.reloadFile(file, 'json');
    await until(() => entered);
    await expect(registry.reloadFile(file, 'json')).rejects.toMatchObject({ code: 'RELOAD_IN_PROGRESS' });
    await fs.writeFile(file, JSON.stringify(document('r3')));
    release(); await manual;
    await until(() => registry.getStatus().revision === 'r3');
    expect(registry.getStatus().generation).toBe(3);
  });

  test('shutdown closes handles and fences an already resolving candidate', async () => {
    await registry.startWatchingFile(file, 'json');
    const original = registry.captureSnapshot();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let entered = false;
    resolveSecret = async () => { entered = true; await gate; return 'synthetic-watch-secret'; };
    await fs.writeFile(file, JSON.stringify(document('r2')));
    await until(() => entered);
    registry.onModuleDestroy(); registry.stopWatching();
    release();
    await until(() => !registry.getStatus().reloading);
    expect(registry.captureSnapshot()).toBe(original);
    expect(registry.getStatus().lastReloadError).toBe('WATCH_STOPPED');
    await fs.writeFile(file, JSON.stringify(document('r3')));
    await delay(250);
    expect(registry.captureSnapshot()).toBe(original);
  });

  test('startup failure releases the handle and allows a corrected startup', async () => {
    await fs.writeFile(file, '{}');
    await expect(registry.startWatchingFile(file, 'json')).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    await fs.writeFile(file, JSON.stringify(document()));
    await registry.startWatchingFile(file, 'json');
    expect(registry.getStatus().revision).toBe('r1');
  });
  test('removal retains the snapshot and recreation at the fixed name recovers', async () => {
    await registry.startWatchingFile(file, 'json');
    const retained = registry.captureSnapshot();
    await fs.unlink(file);
    await until(() => registry.getStatus().lastReloadError === 'CONFIGURATION_READ_FAILED');
    expect(registry.captureSnapshot()).toBe(retained);
    await fs.writeFile(file, JSON.stringify(document('recreated')));
    await until(() => registry.getStatus().revision === 'recreated');
  });

  test('stop during initial stable read cannot install a watcher or activate later', async () => {
    const starting = registry.startWatchingFile(file, 'json');
    registry.stopWatching();
    await expect(starting).rejects.toMatchObject({ code: 'WATCH_STOPPED' });
    expect(registry.getStatus().state).toBe('empty');
    await registry.startWatchingFile(file, 'json');
    expect(registry.getStatus().revision).toBe('r1');
  });

});
