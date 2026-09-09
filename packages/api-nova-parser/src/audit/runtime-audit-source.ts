import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface RuntimeAuditSourceManifest {
  schemaVersion: 2;
  kind: 'runtime_audit_source';
  sourceInstanceId: string;
  pid: number;
  startedAt: string;
}

const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
export const isRuntimeAuditSourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export function normalizeRuntimeAuditSourceManifest(value: unknown): RuntimeAuditSourceManifest {
  const row = value as RuntimeAuditSourceManifest;
  if (!row || Array.isArray(row) || row.schemaVersion !== 2 || row.kind !== 'runtime_audit_source' ||
    !isRuntimeAuditSourceId(row.sourceInstanceId) || !Number.isSafeInteger(row.pid) ||
    row.pid < 1 || row.pid > 4294967295 || typeof row.startedAt !== 'string' ||
    !/T.*Z$/.test(row.startedAt) || !Number.isFinite(Date.parse(row.startedAt))) {
    throw new Error('INVALID_RUNTIME_AUDIT_SOURCE');
  }
  return { schemaVersion: 2, kind: 'runtime_audit_source', sourceInstanceId: row.sourceInstanceId,
    pid: row.pid, startedAt: new Date(row.startedAt).toISOString() };
}

/** Private local evidence, not a public lifecycle event or a credential. */
export async function publishRuntimeAuditSource(directory: string, sourceInstanceId: string): Promise<void> {
  if (!isRuntimeAuditSourceId(sourceInstanceId)) throw new Error('INVALID_RUNTIME_AUDIT_SOURCE');
  const manifest: RuntimeAuditSourceManifest = { schemaVersion: 2, kind: 'runtime_audit_source',
    sourceInstanceId, pid: process.pid, startedAt: processStartedAt };
  const data = JSON.stringify(manifest) + '\n';
  const target = join(directory, 'source-v2-' + sourceInstanceId + '.json');
  const temporary = join(directory, '.source-v2-' + sourceInstanceId + '-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temporary, target); }
    catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await existing.stat();
        const bytes = Buffer.alloc(Buffer.byteLength(data));
        if (!stat.isFile() || stat.size !== bytes.length ||
          (await existing.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length ||
          bytes.toString('utf8') !== data) throw new Error('RUNTIME_AUDIT_SOURCE_CONFLICT');
      } finally { await existing.close(); }
    }
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
