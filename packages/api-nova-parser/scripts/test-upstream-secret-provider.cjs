'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createUpstreamSecretProvider,
  UpstreamSecretProviderError,
  UPSTREAM_SECRET_PROVIDER_LIMITS,
} = require('../dist/credentials/secret-provider.js');

const marker = 'synthetic-' + randomUUID();
const rootDescription = () => ({
  type: 'file',
  root: path.resolve('tmp', 'synthetic-secret-provider-root'),
  requireOwnerOnly: true,
});

function rejected(code, ...sensitive) {
  return error => {
    assert.ok(error instanceof UpstreamSecretProviderError);
    assert.equal(error.code, code);
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    for (const value of [marker, ...sensitive]) {
      assert.equal(String(error).includes(value), false);
      assert.equal(JSON.stringify(error).includes(value), false);
    }
    return true;
  };
}

function temporaryEnvironment(t, value) {
  const key = 'API_NOVA_PROVIDER_TEST_' + randomUUID().replace(/-/g, '').toUpperCase();
  assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false);
  if (value !== undefined) process.env[key] = value;
  t.after(() => { delete process.env[key]; });
  return key;
}

test('providers are frozen and construction performs no filesystem I/O', t => {
  let calls = 0;
  for (const name of ['open', 'lstat', 'readFile']) {
    t.mock.method(fs, name, () => { calls++; throw new Error(marker); });
  }
  const env = createUpstreamSecretProvider({ type: 'env' });
  const file = createUpstreamSecretProvider(rootDescription());
  assert.equal(env.type, 'env');
  assert.equal(file.type, 'file');
  assert.equal(Object.isFrozen(env), true);
  assert.equal(Object.isFrozen(file), true);
  assert.equal(calls, 0);
});

const malformedDescriptions = [
  ['undefined', undefined], ['null', null], ['string', 'env'], ['number', 1],
  ['array', []], ['date', new Date(0)], ['unknown type', { type: marker }],
  ['missing type', {}], ['inherited type', Object.create({ type: 'env' })],
  ['env extra field', { type: 'env', root: marker }],
  ['symbol field', { type: 'env', [Symbol(marker)]: true }],
  ['file missing root', { type: 'file', requireOwnerOnly: true }],
  ['file missing owner policy', { type: 'file', root: path.resolve('tmp') }],
  ['file relaxed owner policy', { ...rootDescription(), requireOwnerOnly: false }],
  ['file nonboolean owner policy', { ...rootDescription(), requireOwnerOnly: 'true' }],
  ['relative root', { ...rootDescription(), root: marker }],
  ['empty root', { ...rootDescription(), root: '' }],
  ['nonstring root', { ...rootDescription(), root: 7 }],
  ['oversized root', { ...rootDescription(), root: path.sep + 'a'.repeat(4097) }],
  ['control character root', { ...rootDescription(), root: path.resolve('tmp') + '\n' + marker }],
];
for (const [label, description] of malformedDescriptions) {
  test('configuration rejects ' + label, () => {
    assert.throws(() => createUpstreamSecretProvider(description), rejected('INVALID_PROVIDER_CONFIGURATION'));
  });
}

for (const property of ['type', 'root', 'requireOwnerOnly']) {
  test('configuration never invokes the ' + property + ' accessor', () => {
    let calls = 0;
    const description = rootDescription();
    Object.defineProperty(description, property, {
      enumerable: true,
      get() { calls++; throw new Error(marker); },
    });
    assert.throws(() => createUpstreamSecretProvider(description), rejected('INVALID_PROVIDER_CONFIGURATION'));
    assert.equal(calls, 0);
  });
}

test('environment value is resolved exactly without interpolation', async t => {
  const value = marker + '-${NOT_AN_ENV_LOOKUP}';
  const key = temporaryEnvironment(t, value);
  const provider = createUpstreamSecretProvider({ type: 'env' });
  assert.equal(await provider.resolve(key), value);
});

test('environment provider reads the current value rather than caching', async t => {
  const key = temporaryEnvironment(t, marker);
  const provider = createUpstreamSecretProvider({ type: 'env' });
  assert.equal(await provider.resolve(key), marker);
  process.env[key] = marker + '-rotated';
  assert.equal(await provider.resolve(key), marker + '-rotated');
});

test('environment absence is rejected without leaking its key', async t => {
  const key = temporaryEnvironment(t);
  await assert.rejects(createUpstreamSecretProvider({ type: 'env' }).resolve(key),
    rejected('SECRET_NOT_FOUND', key));
});

const invalidEnvKeys = [
  ['undefined', undefined], ['null', null], ['number', 1], ['empty', ''],
  ['lowercase', 'secret'], ['path', 'SECRET/TOKEN'], ['reference', 'env:TOKEN'],
  ['space', 'SECRET TOKEN'], ['digit prefix', '1TOKEN'],
  ['control', 'TOKEN\n'], ['oversized', 'A'.repeat(513)],
];
for (const [label, key] of invalidEnvKeys) {
  test('environment rejects ' + label + ' key', async () => {
    await assert.rejects(createUpstreamSecretProvider({ type: 'env' }).resolve(key),
      rejected('INVALID_SECRET_KEY'));
  });
}

const invalidEnvValues = [
  ['empty', ''], ['spaces', '   '], ['leading space', ' ' + marker],
  ['trailing space', marker + ' '], ['tab', marker + '\t' + marker],
  ['LF', marker + '\n' + marker], ['CR', marker + '\r' + marker],
  ['control', marker + '\u0001' + marker], ['DEL', marker + '\u007f' + marker],
];
for (const [label, value] of invalidEnvValues) {
  test('environment rejects ' + label + ' value without exposing it', async t => {
    const key = temporaryEnvironment(t, value);
    await assert.rejects(createUpstreamSecretProvider({ type: 'env' }).resolve(key),
      rejected('SECRET_VALUE_INVALID', key));
  });
}

for (const [label, value, valid] of [
  ['ASCII exact bound', 'a'.repeat(8192), true],
  ['ASCII overflow', 'a'.repeat(8193), false],
  ['UTF-8 exact bound', '\u00e9'.repeat(4096), true],
  ['UTF-8 overflow', '\u00e9'.repeat(4096) + 'a', false],
]) {
  test('environment enforces ' + label, async t => {
    const key = temporaryEnvironment(t, value);
    const operation = createUpstreamSecretProvider({ type: 'env' }).resolve(key);
    if (valid) assert.equal(await operation, value);
    else await assert.rejects(operation, rejected('SECRET_LIMIT_EXCEEDED', key));
  });
}

test('exported limits are immutable', () => {
  assert.equal(Object.isFrozen(UPSTREAM_SECRET_PROVIDER_LIMITS), true);
  assert.equal(UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes, 8192);
  assert.equal(UPSTREAM_SECRET_PROVIDER_LIMITS.maxKeyBytes, 512);
  assert.equal(UPSTREAM_SECRET_PROVIDER_LIMITS.maxPathSegments, 16);
});

test('unsupported platforms reject file reads before filesystem access', {
  skip: process.platform === 'linux' ? 'Linux uses the real-file cases below' : false,
}, async t => {
  let calls = 0;
  for (const name of ['open', 'lstat', 'readFile']) {
    t.mock.method(fs, name, () => { calls++; throw new Error(marker); });
  }
  const provider = createUpstreamSecretProvider(rootDescription());
  await assert.rejects(provider.resolve('token'), rejected('UNSUPPORTED_PLATFORM'));
  assert.equal(calls, 0);
});

const linuxOnly = {
  skip: process.platform !== 'linux' ? 'Requires real Linux ownership, mode and link semantics' : false,
};

// All real-file cases use newly created, private synthetic fixtures, never deployed secrets.
async function privateFixture(t) {
  const parent = path.resolve(os.homedir());
  const prefix = '.api-nova-secret-provider-test-';
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  await fs.chmod(directory, 0o700);
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('Unsafe synthetic fixture cleanup');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(directory, 'secrets');
  await fs.mkdir(root, { mode: 0o700 });
  const description = { type: 'file', root, requireOwnerOnly: true };
  return {
    directory, root, description,
    provider: createUpstreamSecretProvider(description),
    async put(key, value = marker, mode = 0o600) {
      const target = path.join(root, ...key.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, value, { mode });
      return target;
    },
  };
}

test('Linux resolves a nested private single-link UTF-8 file', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('service/.token');
  assert.equal(await fixture.provider.resolve('service/.token'), marker);
});

test('Linux captures the configured root independently of caller mutation', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('token');
  fixture.description.root = path.join(fixture.directory, 'different');
  assert.equal(await fixture.provider.resolve('token'), marker);
});

test('Linux rejects a missing file with redacted errors', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await assert.rejects(fixture.provider.resolve('missing'),
    rejected('SECRET_NOT_FOUND', fixture.root));
});

const invalidFileKeys = [
  ['absolute', '/token'], ['parent', '../token'], ['dot segment', 'service/./token'],
  ['empty segment', 'service//token'], ['trailing separator', 'service/'],
  ['backslash', 'service\\token'], ['colon', 'file:token'],
  ['percent escape', '%2e%2e/token'], ['too many segments', Array(17).fill('a').join('/')],
  ['too many bytes', 'a'.repeat(513)],
];
for (const [label, key] of invalidFileKeys) {
  test('Linux rejects ' + label + ' file key', linuxOnly, async t => {
    const fixture = await privateFixture(t);
    await assert.rejects(fixture.provider.resolve(key), rejected('INVALID_SECRET_KEY', fixture.root));
  });
}

test('Linux rejects a non-private root', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('token');
  await fs.chmod(fixture.root, 0o755);
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE', fixture.root));
});

test('Linux rejects a non-private nested directory', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('nested/token');
  await fs.chmod(path.join(fixture.root, 'nested'), 0o755);
  await assert.rejects(fixture.provider.resolve('nested/token'), rejected('SECRET_FILE_UNSAFE'));
});

test('Linux rejects a shared writable ancestor of a private root', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('token');
  await fs.chmod(fixture.directory, 0o777);
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
});

for (const [label, mode] of [['group-readable', 0o640], ['world-readable', 0o604], ['executable', 0o700]]) {
  test('Linux rejects a ' + label + ' secret file', linuxOnly, async t => {
    const fixture = await privateFixture(t);
    const file = await fixture.put('token');
    await fs.chmod(file, mode);
    await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
  });
}

test('Linux rejects a directory in place of a secret file', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fs.mkdir(path.join(fixture.root, 'token'), { mode: 0o700 });
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
});

test('Linux rejects a final symlink', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('real');
  await fs.symlink(path.join(fixture.root, 'real'), path.join(fixture.root, 'token'));
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
});

test('Linux rejects a symlink in the root path', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('token');
  const linkedRoot = path.join(fixture.directory, 'linked');
  await fs.symlink(fixture.root, linkedRoot);
  const provider = createUpstreamSecretProvider({ ...fixture.description, root: linkedRoot });
  await assert.rejects(provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
});

test('Linux rejects hardlinked secret material', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  const file = await fixture.put('token');
  await fs.link(file, path.join(fixture.root, 'alias'));
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_FILE_UNSAFE'));
});

for (const [label, value] of [
  ['empty', ''], ['final newline', marker + '\n'], ['NUL', marker + '\0' + marker],
  ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
]) {
  test('Linux rejects ' + label + ' file contents', linuxOnly, async t => {
    const fixture = await privateFixture(t);
    await fixture.put('token', value);
    await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_VALUE_INVALID'));
  });
}

test('Linux accepts exactly the byte limit', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  const value = 'a'.repeat(8192);
  await fixture.put('token', value);
  assert.equal(await fixture.provider.resolve('token'), value);
});

test('Linux rejects a file above the byte limit', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  await fixture.put('token', 'a'.repeat(8193));
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_LIMIT_EXCEEDED'));
});

test('Linux rejects an in-place change during reading rather than returning partial data', linuxOnly, async t => {
  const fixture = await privateFixture(t);
  const target = await fixture.put('token');
  const originalOpen = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === target && typeof args[1] === 'number') {
      const originalRead = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (!changed && result.bytesRead > 0) {
          changed = true;
          await fs.appendFile(target, 'x');
        }
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(fixture.provider.resolve('token'), rejected('SECRET_CHANGED_DURING_READ'));
  assert.equal(changed, true);
});
