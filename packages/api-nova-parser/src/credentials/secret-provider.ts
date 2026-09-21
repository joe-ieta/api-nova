import { constants, promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { readWindowsPrivateSecret } from './windows-secret-file';
import type { UpstreamSecretProviderDescription } from './types';

export const UPSTREAM_SECRET_PROVIDER_LIMITS = Object.freeze({
  maxSecretBytes: 8192,
  maxKeyBytes: 512,
  maxPathSegments: 16,
});

export type UpstreamSecretProviderErrorCode =
  | 'INVALID_PROVIDER_CONFIGURATION' | 'INVALID_SECRET_KEY'
  | 'SECRET_NOT_FOUND' | 'SECRET_VALUE_INVALID' | 'SECRET_LIMIT_EXCEEDED'
  | 'SECRET_FILE_UNSAFE' | 'SECRET_CHANGED_DURING_READ'
  | 'SECRET_READ_FAILED' | 'UNSUPPORTED_PLATFORM';

/** Errors intentionally omit keys, paths, native causes and secret contents. */
export class UpstreamSecretProviderError extends Error {
  constructor(public readonly code: UpstreamSecretProviderErrorCode) {
    super('Upstream secret provider rejected the request: ' + code);
    this.name = 'UpstreamSecretProviderError';
  }
}

export interface UpstreamSecretProvider {
  readonly type: 'env' | 'file';
  /**
   * Resolve a provider-local key, not a complete secretRef.
   * The result is secret material for trusted in-process callers only.
   * Never log, serialize, cache publicly or return it through a control-plane API.
   */
  resolve(key: string): Promise<string>;
}

function fail(code: UpstreamSecretProviderErrorCode): never {
  throw new UpstreamSecretProviderError(code);
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 ||
      Buffer.byteLength(key, 'utf8') > UPSTREAM_SECRET_PROVIDER_LIMITS.maxKeyBytes) {
    fail('INVALID_SECRET_KEY');
  }
}

function validateValue(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes) {
    fail('SECRET_LIMIT_EXCEEDED');
  }
  // Do not silently trim a file newline, expand placeholders or alter a token.
  if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('SECRET_VALUE_INVALID');
  }
  return value;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function assertPrivateFile(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid ||
      stat.nlink !== 1 || (stat.mode & 0o177) !== 0 || (stat.mode & 0o400) === 0) {
    fail('SECRET_FILE_UNSAFE');
  }
  if (stat.size > UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes) {
    fail('SECRET_LIMIT_EXCEEDED');
  }
}

interface DirectorySnapshot {
  readonly name: string;
  readonly stat: Stats;
}

async function snapshotDirectories(root: string, target: string, uid: number): Promise<DirectorySnapshot[]> {
  const names: string[] = [];
  let current = path.dirname(target);
  for (;;) {
    names.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  names.reverse();
  const snapshots: DirectorySnapshot[] = [];
  for (const name of names) {
    const stat = await fs.lstat(name);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('SECRET_FILE_UNSAFE');
    if (within(root, name)) {
      if (stat.uid !== uid || (stat.mode & 0o077) !== 0 ||
          (stat.mode & 0o500) !== 0o500) fail('SECRET_FILE_UNSAFE');
    } else if ((stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0) {
      // An untrusted writable ancestor could replace even a private root directory.
      // This deliberately rejects roots beneath shared writable directories such as /tmp.
      fail('SECRET_FILE_UNSAFE');
    }
    snapshots.push({ name, stat });
  }
  return snapshots;
}

async function readPrivateFile(root: string, key: string): Promise<string> {
  // Each supported platform verifies its native permission model.
  if (process.platform !== 'win32' && (process.platform !== 'linux' || typeof process.geteuid !== 'function' ||
      typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')) {
    fail('UNSUPPORTED_PLATFORM');
  }
  validateKey(key);
  const segments = key.split('/');
  if (segments.length > UPSTREAM_SECRET_PROVIDER_LIMITS.maxPathSegments ||
      segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) {
    fail('INVALID_SECRET_KEY');
  }
  const target = path.resolve(root, ...segments);
  if (target === root || !within(root, target)) fail('INVALID_SECRET_KEY');

  if (process.platform === 'win32') {
    if (segments.some(segment => segment.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) fail('INVALID_SECRET_KEY');
    let bytes: Buffer | undefined;
    try {
      bytes = await readWindowsPrivateSecret(root, key);
      let value: string;
      try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return fail('SECRET_VALUE_INVALID'); }
      return validateValue(value);
    } catch (error) {
      if (error instanceof UpstreamSecretProviderError) throw error;
      const codes: UpstreamSecretProviderErrorCode[] = ['SECRET_FILE_UNSAFE', 'SECRET_READ_FAILED', 'SECRET_NOT_FOUND', 'SECRET_LIMIT_EXCEEDED', 'SECRET_CHANGED_DURING_READ'];
      const code = error instanceof Error ? error.message as UpstreamSecretProviderErrorCode : 'SECRET_READ_FAILED';
      return fail(codes.includes(code) ? code : 'SECRET_READ_FAILED');
    } finally { bytes?.fill(0); }
  }
  const uid = process.geteuid!();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    const directories = await snapshotDirectories(root, target, uid);
    const beforeOpen = await fs.lstat(target);
    assertPrivateFile(beforeOpen, uid);
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const beforeRead = await handle.stat();
    assertPrivateFile(beforeRead, uid);
    if (!sameSnapshot(beforeOpen, beforeRead)) fail('SECRET_CHANGED_DURING_READ');

    buffer = Buffer.alloc(UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > UPSTREAM_SECRET_PROVIDER_LIMITS.maxSecretBytes) fail('SECRET_LIMIT_EXCEEDED');
    }

    const afterRead = await handle.stat();
    if (total !== beforeRead.size || !sameSnapshot(beforeRead, afterRead) ||
        !sameSnapshot(afterRead, await fs.lstat(target))) {
      fail('SECRET_CHANGED_DURING_READ');
    }
    for (const directory of directories) {
      if (!sameSnapshot(directory.stat, await fs.lstat(directory.name))) {
        fail('SECRET_CHANGED_DURING_READ');
      }
    }
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
    } catch {
      fail('SECRET_VALUE_INVALID');
    }
    return validateValue(value);
  } catch (error) {
    if (error instanceof UpstreamSecretProviderError) throw error;
    if (typeof error === 'object' && error !== null &&
        'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('SECRET_NOT_FOUND');
    }
    return fail('SECRET_READ_FAILED');
  } finally {
    buffer?.fill(0);
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Construct a provider without reading secrets or touching the filesystem.
 * This is not a Registry, resolver, watcher or runtime activation API.
 * Descriptions normally come from validateUpstreamCredentialBindings.
 */
export function createUpstreamSecretProvider(
  description: UpstreamSecretProviderDescription,
): UpstreamSecretProvider {
  let type: unknown;
  let root: unknown;
  try {
    if (!description || typeof description !== 'object' || Array.isArray(description)) {
      fail('INVALID_PROVIDER_CONFIGURATION');
    }
    const prototype = Object.getPrototypeOf(description);
    if (prototype !== Object.prototype && prototype !== null) fail('INVALID_PROVIDER_CONFIGURATION');
    const keys = Reflect.ownKeys(description);
    const typeProperty = Object.getOwnPropertyDescriptor(description, 'type');
    if (!typeProperty || !('value' in typeProperty)) fail('INVALID_PROVIDER_CONFIGURATION');
    type = typeProperty.value;
    const allowed = type === 'env' ? ['type'] : ['type', 'root', 'requireOwnerOnly'];
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) {
      fail('INVALID_PROVIDER_CONFIGURATION');
    }
    if (type === 'file') {
      const rootProperty = Object.getOwnPropertyDescriptor(description, 'root');
      const ownerProperty = Object.getOwnPropertyDescriptor(description, 'requireOwnerOnly');
      if (!rootProperty || !('value' in rootProperty) ||
          !ownerProperty || !('value' in ownerProperty) || ownerProperty.value !== true) {
        fail('INVALID_PROVIDER_CONFIGURATION');
      }
      root = rootProperty.value;
      if (typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root) ||
          /[\u0000-\u001f\u007f]/u.test(root)) fail('INVALID_PROVIDER_CONFIGURATION');
    } else if (type !== 'env') {
      fail('INVALID_PROVIDER_CONFIGURATION');
    }
  } catch {
    fail('INVALID_PROVIDER_CONFIGURATION');
  }

  if (type === 'env') {
    return Object.freeze({
      type: 'env' as const,
      async resolve(key: string): Promise<string> {
        validateKey(key);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail('INVALID_SECRET_KEY');
        if (!Object.prototype.hasOwnProperty.call(process.env, key)) fail('SECRET_NOT_FOUND');
        const value = process.env[key];
        if (value === undefined) fail('SECRET_NOT_FOUND');
        return validateValue(value);
      },
    });
  }

  // Capture configuration so later caller mutation cannot change the permitted root.
  const configuredRoot = path.resolve(root as string);
  return Object.freeze({
    type: 'file' as const,
    resolve: (key: string): Promise<string> => readPrivateFile(configuredRoot, key),
  });
}
