import fs = require('node:fs/promises');
import timers = require('node:timers/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStableUpstreamCredentialText, UPSTREAM_CREDENTIAL_FILE_LIMITS,
} from './file-source';
import { UpstreamCredentialRegistry } from './registry';

function raw(revision = 'r1', mode = 'manual') {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode, debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'env:FILE_SOURCE_TEST_TOKEN' } },
    sites: [{
      id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
      allowedHosts: ['api.example.com'], credential: 'token', endpoints: [],
    }],
  };
}

describe('stable upstream credential file activation', () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'api-nova-bindings-'));
    // Use a canonical directory on hosts where tmpdir itself is an alias.
    directory = await fs.realpath(directory);
    path = join(directory, 'bindings.json');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('reads valid UTF-8 only after two identical bounded samples', async () => {
    const text = JSON.stringify(raw());
    await fs.writeFile(path, text);
    expect(await readStableUpstreamCredentialText(path)).toBe(text);
  });

  test.each(['relative.json', '', '../bindings.json'])('rejects non-absolute input %p', async input => {
    await expect(readStableUpstreamCredentialText(input)).rejects.toMatchObject({
      code: 'CONFIGURATION_READ_FAILED',
    });
  });

  test('rejects directories and missing paths without exposing paths', async () => {
    for (const input of [directory, path]) {
      const error = await readStableUpstreamCredentialText(input).catch(error => error);
      expect(error.code).toBe('CONFIGURATION_READ_FAILED');
      expect(String(error)).not.toContain(directory);
      expect(error.cause).toBeUndefined();
    }
  });

  test('rejects oversized files before allocating a full read', async () => {
    await fs.writeFile(path, Buffer.alloc(UPSTREAM_CREDENTIAL_FILE_LIMITS.maxBytes + 1));
    const open = jest.spyOn(fs, 'open');
    await expect(readStableUpstreamCredentialText(path)).rejects.toMatchObject({
      code: 'CONFIGURATION_READ_FAILED',
    });
    expect(open).not.toHaveBeenCalled();
  });

  test('rejects malformed UTF-8 instead of inserting replacement characters', async () => {
    await fs.writeFile(path, Buffer.from([0xc3, 0x28]));
    await expect(readStableUpstreamCredentialText(path)).rejects.toMatchObject({
      code: 'CONFIGURATION_READ_FAILED',
    });
  });

  test('rejects in-place writes between samples', async () => {
    await fs.writeFile(path, JSON.stringify(raw()));
    jest.spyOn(timers, 'setTimeout').mockImplementationOnce((async () => {
      await fs.writeFile(path, JSON.stringify(raw('r2')));
    }) as any);
    await expect(readStableUpstreamCredentialText(path)).rejects.toMatchObject({
      code: 'CONFIGURATION_UNSTABLE',
    });
  });

  test('rejects replacement by an identical file with a different identity', async () => {
    const text = JSON.stringify(raw());
    await fs.writeFile(path, text);
    jest.spyOn(timers, 'setTimeout').mockImplementationOnce((async () => {
      const replacement = join(directory, 'replacement.json');
      await fs.writeFile(replacement, text);
      await fs.rename(replacement, path);
    }) as any);
    await expect(readStableUpstreamCredentialText(path)).rejects.toMatchObject({
      code: 'CONFIGURATION_UNSTABLE',
    });
  });

  test('rejects hard-linked configuration files', async () => {
    const original = join(directory, 'original.json');
    await fs.writeFile(original, JSON.stringify(raw()));
    await fs.link(original, path);
    await expect(readStableUpstreamCredentialText(path)).rejects.toMatchObject({
      code: 'CONFIGURATION_READ_FAILED',
    });
  });

  test('rejects aliased parent directories', async () => {
    await fs.writeFile(path, JSON.stringify(raw()));
    const alias = join(directory, 'alias');
    await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readStableUpstreamCredentialText(join(alias, 'bindings.json'))).rejects.toMatchObject({
      code: 'CONFIGURATION_READ_FAILED',
    });
  });

  test('holds the shared lock throughout file I/O and preserves the previous snapshot on failure', async () => {
    const factory = jest.fn(description => ({
      type: description.type, resolve: async () => 'synthetic-file-secret',
    }));
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: factory });
    const first = await registry.reload(raw());
    factory.mockClear();
    await fs.writeFile(path, JSON.stringify(raw('r2')));
    let release!: () => void;
    let sampled!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reachedSample = new Promise<void>(resolve => { sampled = resolve; });
    jest.spyOn(timers, 'setTimeout').mockImplementationOnce((async () => {
      sampled();
      await gate;
      await fs.writeFile(path, '{"sensitive":"synthetic-file-secret"');
    }) as any);
    const pending = registry.reloadFile(path, 'json');
    await reachedSample;
    expect(registry.getStatus().reloading).toBe(true);
    expect(registry.captureSnapshot()).toBe(first);
    await expect(registry.reload(raw('r3'))).rejects.toMatchObject({ code: 'RELOAD_IN_PROGRESS' });
    release();
    await expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_UNSTABLE' });
    expect(factory).not.toHaveBeenCalled();
    expect(registry.captureSnapshot()).toBe(first);
    expect(registry.getStatus()).toMatchObject({
      generation: 1, reloading: false, lastReloadError: 'CONFIGURATION_UNSTABLE',
    });
    await fs.writeFile(path, JSON.stringify(raw('r2')));
    await expect(registry.reloadFile(path, 'json')).resolves.toMatchObject({ generation: 2 });
    expect(registry.getStatus().lastReloadError).toBeUndefined();
  });

  test('rejects unsupported watch activation before any provider resolution', async () => {
    await fs.writeFile(path, JSON.stringify(raw('r1', 'watch')));
    const factory = jest.fn();
    const registry = new UpstreamCredentialRegistry({ environment: 'test', providerFactory: factory });
    await expect(registry.reloadFile(path, 'json')).rejects.toMatchObject({ code: 'UNSUPPORTED_RELOAD_MODE' });
    expect(factory).not.toHaveBeenCalled();
    expect(registry.getStatus().state).toBe('empty');
  });

  test('invalid format does not touch the filesystem', async () => {
    const registry = new UpstreamCredentialRegistry({ environment: 'test' });
    const realpath = jest.spyOn(fs, 'realpath');
    await expect(registry.reloadFile(path, 'toml' as never)).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(realpath).not.toHaveBeenCalled();
  });

  test('missing file and invalid document preserve a ready registry', async () => {
    const registry = new UpstreamCredentialRegistry({
      environment: 'test',
      providerFactory: description => ({ type: description.type, resolve: async () => 'synthetic' }),
    });
    const active = await registry.reload(raw());
    await expect(registry.reloadFile(path, 'json')).rejects.toMatchObject({ code: 'CONFIGURATION_READ_FAILED' });
    await fs.writeFile(path, '{"secret":"synthetic"');
    await expect(registry.reloadFile(path, 'json')).rejects.toMatchObject({ code: 'CANDIDATE_REJECTED' });
    expect(registry.captureSnapshot()).toBe(active);
  });
});
