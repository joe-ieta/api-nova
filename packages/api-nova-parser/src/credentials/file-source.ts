import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { UPSTREAM_CREDENTIAL_TEXT_LIMITS } from './loader';

export type UpstreamCredentialFileErrorCode =
  | 'CONFIGURATION_READ_FAILED' | 'CONFIGURATION_UNSTABLE';

export class UpstreamCredentialFileError extends Error {
  constructor(readonly code: UpstreamCredentialFileErrorCode) {
    super(code);
    this.name = 'UpstreamCredentialFileError';
  }
}

export const UPSTREAM_CREDENTIAL_FILE_LIMITS = Object.freeze({
  maxBytes: UPSTREAM_CREDENTIAL_TEXT_LIMITS.maxUtf8Bytes,
  stableReadIntervalMs: 50,
});

function fail(code: UpstreamCredentialFileErrorCode): never {
  throw new UpstreamCredentialFileError(code);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.mode === right.mode &&
    left.nlink === right.nlink;
}

async function checkedPath(path: string): Promise<BigIntStats> {
  // Reject symbolic links, including parent-directory aliases. This is not an
  // OS sandbox: the host must control the configuration directory and mounts.
  if (await fs.realpath(path) !== path) return fail('CONFIGURATION_READ_FAILED');
  const stat = await fs.lstat(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n ||
      stat.size > BigInt(UPSTREAM_CREDENTIAL_FILE_LIMITS.maxBytes)) {
    return fail('CONFIGURATION_READ_FAILED');
  }
  return stat;
}

async function readOnce(path: string): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const before = await checkedPath(path);
  const handle = await fs.open(
    path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) return fail('CONFIGURATION_UNSTABLE');
    // Never allocate/read an unbounded file even when it grows after stat.
    const buffer = Buffer.alloc(UPSTREAM_CREDENTIAL_FILE_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > UPSTREAM_CREDENTIAL_FILE_LIMITS.maxBytes) {
      return fail('CONFIGURATION_READ_FAILED');
    }
    const after = await handle.stat({ bigint: true });
    const named = await checkedPath(path);
    if (BigInt(length) !== opened.size || !sameFile(opened, after) || !sameFile(after, named)) {
      return fail('CONFIGURATION_UNSTABLE');
    }
    return { bytes: buffer.subarray(0, length), stat: after };
  } finally {
    await handle.close();
  }
}

/**
 * Bounded two-sample stable read of a host-controlled local regular file.
 * Changes or atomic replacements during sampling are rejected, not retried.
 * No watcher is installed. Native paths, contents and errors never escape.
 */
export async function readStableUpstreamCredentialText(path: string): Promise<string> {
  try {
    if (typeof path !== 'string' || !path || path.trim() !== path ||
        /[\u0000-\u001f\u007f]/u.test(path) || !isAbsolute(path) ||
        /^[\\/]{2}/u.test(path)) {
      return fail('CONFIGURATION_READ_FAILED');
    }
    const absolute = resolve(path);
    const first = await readOnce(absolute);
    await delay(UPSTREAM_CREDENTIAL_FILE_LIMITS.stableReadIntervalMs);
    const second = await readOnce(absolute);
    if (!sameFile(first.stat, second.stat) || !first.bytes.equals(second.bytes)) {
      return fail('CONFIGURATION_UNSTABLE');
    }
    // Invalid UTF-8 must not be replaced silently in identifiers or references.
    return new TextDecoder('utf-8', { fatal: true }).decode(second.bytes);
  } catch (error) {
    throw new UpstreamCredentialFileError(
      error instanceof UpstreamCredentialFileError ? error.code : 'CONFIGURATION_READ_FAILED',
    );
  }
}
