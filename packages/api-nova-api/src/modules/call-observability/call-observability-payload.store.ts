import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants } from 'fs';
import type { Dir } from 'fs';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { auditBodyLimit, auditDirectory, InvocationBody } from 'api-nova-parser';
import type { QuotaSettlement } from './call-observability-payload-quota';
import { PayloadInventorySession, type PayloadInventoryResumeEvidence } from './call-observability-payload-inventory';
import { RuntimePayloadEntity } from '../../database/entities/runtime-call-observability.entity';
import {
  canonicalJson, contentHash, ObservabilityStorageError, publicSequence, sequenceKey, SerialStorageLane,
} from './call-observability-storage';

export interface PayloadIdentity {
  sourceInstanceId: string;
  invocationId: string;
  side: 'request' | 'response';
}

export interface PayloadGarbageCandidate {
  id: string;
  key: string;
  temporary: boolean;
  modifiedAt: number;
  size: number;
  inode: number;
}

export interface PayloadScanUsage {
  measurement: 'logical_file_length_before_cleanup';
  scanCoverage: 'complete' | 'partial';
  scanStartedAt: string;
  scanCompletedAt: string;
  observedBytes: number;
  observedFiles: number;
  scannedEntries: number;
  missingShards: number;
  traversedShards: number;
  unmeasuredEntries: number;
  startedAtShardBoundary: boolean;
  truncated: boolean;
}

export interface PayloadPublicationQuota {
  reserve(payloadId: string, bytes: number): Promise<{
    mode: 'publish' | 'verify_existing';
    settle(outcome: QuotaSettlement): Promise<void>;
  }>;
}

export interface PreparedPayload {
  entity: RuntimePayloadEntity;
  body: Omit<InvocationBody, 'data'>;
  storageFailed: boolean;
}

/**
 * Private, content-addressed payload objects. Only opaque database IDs reach APIs.
 * The directory is not a static-file root; deployment ACLs must restrict it.
 */
@Injectable()
export class CallObservabilityPayloadStore implements OnModuleDestroy {
  private readonly root = resolve(
    process.env.API_NOVA_OBSERVABILITY_DATA_DIR || join(auditDirectory(), 'observability'),
    'payloads',
  );
  private readonly lane = new SerialStorageLane(8);
  // Stored text/base64 may be larger than its measured raw body.
  private readonly writeLimit = Math.min(128 * 1024 * 1024, auditBodyLimit() * 2);
  private readonly readLimit = 128 * 1024 * 1024;
  private ownerId: string | null = null;
  private scanDirectory?: Dir;
  private scanShard = 0;
  private readonly scanner = new SerialStorageLane(1);
  private scanActive?: Promise<unknown>;
  private scannerStopping = false;
  private scannerShutdown?: Promise<void>;

  async prepare(identity: PayloadIdentity, body: InvocationBody,
    createdAt: string, expiresAt: string, generation: string, quota?: PayloadPublicationQuota): Promise<PreparedPayload> {
    return this.lane.run(async () => {
      if (!this.ownerId) throw new ObservabilityStorageError('PAYLOAD_STORAGE_NOT_BOUND');
      const namespace = { storageOwnerId: this.ownerId, storageGeneration: publicSequence(sequenceKey(generation)) };
      const { data: originalData, ...bodyMetadata } = body;
      const metadata = { ...bodyMetadata, storedBytes: 0 };
      let data = originalData;
      let digest: string | null = null;
      let fileKey: string | null = null;
      let storageFailed = false;
      if (Date.parse(expiresAt) <= Date.now()) {
        metadata.state = 'expired';
        metadata.reason = 'retention_elapsed';
        data = undefined;
      } else if (metadata.state !== 'captured' && metadata.state !== 'incomplete') {
        data = undefined;
      } else if (data === undefined) {
        metadata.state = 'omitted';
        metadata.reason = 'missing_content';
      } else if (Buffer.byteLength(data, 'utf8') > this.writeLimit) {
        metadata.state = 'omitted';
        metadata.reason = 'storage_body_limit';
        data = undefined;
      }
      if (data !== undefined) {
        metadata.storedBytes = Buffer.byteLength(data, 'utf8');
        digest = contentHash(data);
      }
      let id = contentHash(canonicalJson({ ...identity, ...namespace, metadata, digest }));
      if (data !== undefined && metadata.storedBytes > 0) {
        let reservation: Awaited<ReturnType<PayloadPublicationQuota['reserve']>> | undefined;
        let publicationStarted = false;
        try {
          fileKey = this.key(id);
          const enabled = process.env.API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_ENABLED;
          if (quota || (enabled !== undefined && enabled !== 'false')) {
            if (!quota) throw new ObservabilityStorageError('QUOTA_UNAVAILABLE');
            reservation = await quota.reserve(id, metadata.storedBytes * 2);
          }
          if (reservation?.mode === 'verify_existing') {
            const path = await this.objectPath(fileKey, false);
            const existing = await this.readBounded(path, metadata.storedBytes);
            if (contentHash(existing) !== digest) throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
          } else {
            publicationStarted = true;
            const published = await this.publish(fileKey, data, digest!);
            if (reservation) {
              if (!published.temporaryAbsent) {
                await reservation.settle({ reason: 'unknown' });
                throw new ObservabilityStorageError('QUOTA_PUBLICATION_UNCERTAIN');
              }
              await reservation.settle({ reason: 'confirmed_occupancy_and_unused_absent',
                committedBytes: published.created ? metadata.storedBytes : 0 });
            }
          }
        } catch (error) {
          if (reservation && publicationStarted) await reservation.settle({ reason: 'unknown' }).catch(() => undefined);
          // Only known quota errors get quota reasons. Filesystem/DB faults retain
          // the existing storage_error category; no partial success claims captured.
          const quotaCode = error instanceof ObservabilityStorageError ? error.code : '';
          const quotaReason: Record<string, string> = { QUOTA_EXHAUSTED: 'quota_exhausted', QUOTA_NOT_READY: 'quota_unavailable',
            QUOTA_UNAVAILABLE: 'quota_unavailable', QUOTA_BODY_LIMIT: 'quota_body_limit', QUOTA_PUBLICATION_PENDING: 'quota_publication_pending',
            QUOTA_PUBLICATION_UNCERTAIN: 'quota_publication_uncertain', QUOTA_EPOCH_MISMATCH: 'quota_unavailable' };
          storageFailed = !quotaReason[quotaCode];
          metadata.state = 'omitted';
          metadata.reason = quotaReason[quotaCode] ?? 'storage_error';
          metadata.storedBytes = 0;
          digest = null;
          fileKey = null;
          id = contentHash(canonicalJson({ ...identity, ...namespace, metadata, digest }));
        }
      }
      return {
        entity: Object.assign(new RuntimePayloadEntity(), {
          id, invocationId: identity.invocationId, side: identity.side,
          state: metadata.state, reason: metadata.reason, fileKey, digest,
          metadata, createdAt, expiresAt,
        }),
        body: metadata,
        storageFailed,
      };
    });
  }

  async read(entity: RuntimePayloadEntity): Promise<InvocationBody> {
    if (!Number.isFinite(Date.parse(entity.expiresAt))) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_METADATA');
    }
    if (Date.parse(entity.expiresAt) <= Date.now() || entity.state === 'expired') {
      throw new ObservabilityStorageError('PAYLOAD_EXPIRED');
    }
    const metadata = entity.metadata as InvocationBody;
    if (entity.state !== 'captured' && entity.state !== 'incomplete') return { ...metadata };
    if (entity.fileKey === null && metadata.storedBytes === 0) return { ...metadata, data: '' };
    if (entity.fileKey !== this.key(entity.id) || !/^[a-f0-9]{64}$/.test(entity.digest || '')) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_METADATA');
    }
    try {
      const path = await this.objectPath(entity.fileKey, false);
      const content = await this.readBounded(path, metadata.storedBytes);
      if (contentHash(content) !== entity.digest) {
        throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
      }
      return { ...metadata, data: content.toString('utf8') };
    } catch (error) {
      if (error instanceof ObservabilityStorageError) throw error;
      throw new ObservabilityStorageError('PAYLOAD_STORAGE_UNAVAILABLE');
    }
  }

  async ensureOwner(ownerId: string): Promise<void> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ownerId) ||
      this.ownerId && this.ownerId !== ownerId) {
      throw new ObservabilityStorageError('PAYLOAD_ROOT_OWNER_MISMATCH');
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    }
    const existing = await this.readOwner();
    if (existing !== null) {
      if (existing !== ownerId) throw new ObservabilityStorageError('PAYLOAD_ROOT_OWNER_MISMATCH');
      this.ownerId = ownerId;
      return;
    }
    // Never adopt populated, unowned directories as a new database's payload root.
    const directory = await fs.opendir(this.root);
    let populated = false;
    let inspected = 0;
    try {
      for await (const entry of directory) {
        if (!/^\.owner-[a-f0-9-]{36}\.tmp$/.test(entry.name) || ++inspected > 128) {
          populated = true;
          break;
        }
      }
    } finally {
      await directory.close().catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    if (populated) {
      if (await this.readOwner() !== ownerId) throw new ObservabilityStorageError('PAYLOAD_ROOT_NOT_EMPTY');
      this.ownerId = ownerId;
      return;
    }
    const temporary = join(this.root, '.owner-' + randomUUID() + '.tmp');
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify({ schemaVersion: 1, ownerId }), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(temporary, join(this.root, '.owner.json')).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      if (await this.readOwner() !== ownerId) throw new ObservabilityStorageError('PAYLOAD_ROOT_OWNER_MISMATCH');
      this.ownerId = ownerId;
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async assertOwnedRoot(): Promise<void> {
    if (!this.ownerId || await this.readOwner() !== this.ownerId) {
      throw new ObservabilityStorageError('PAYLOAD_ROOT_OWNER_MISMATCH');
    }
  }

  async openInventory(startShard = 0, resume?: PayloadInventoryResumeEvidence): Promise<PayloadInventorySession> {
    await this.assertOwnedRoot();
    return PayloadInventorySession.open(this.root, key => this.objectPath(key, false),
      () => this.assertOwnedRoot(), startShard, resume);
  }

  async scanGarbage(scanLimit: number, candidateLimit: number, olderThan: number,
    shardHint?: number): Promise<{ candidates: PayloadGarbageCandidate[]; scanned: number; nextShard: number; hasMore: boolean; scanUsage: PayloadScanUsage }> {
    if (this.scannerStopping) throw new ObservabilityStorageError('PAYLOAD_SCANNER_STOPPED');
    if (this.scanActive) throw new ObservabilityStorageError('STORAGE_BUSY');
    const active = this.scanner.run(async () => {
      await this.assertOwnedRoot();
      if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 1000 ||
        !Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > scanLimit ||
        !Number.isFinite(olderThan)) throw new ObservabilityStorageError('INVALID_GC_LIMIT');
      if (shardHint !== undefined && Number.isInteger(shardHint) && shardHint >= 0 &&
        shardHint < 256 && shardHint !== this.scanShard) {
        await this.closeScanner();
        this.scanShard = shardHint;
      }
      try {
        const scanStartedAt = new Date().toISOString();
        const startedAtShardBoundary = !this.scanDirectory;
        let observedBytes = 0, observedFiles = 0, missingShards = 0, unmeasuredEntries = 0;
        const candidates: PayloadGarbageCandidate[] = [];
        let scanned = 0;
        let directories = 0;
        while (scanned < scanLimit && candidates.length < candidateLimit && directories < 256) {
          const shard = this.scanShard.toString(16).padStart(2, '0');
          if (!this.scanDirectory) {
            try {
              const probe = await this.objectPath(shard + '/' + shard + '0'.repeat(62) + '.body', false);
              this.scanDirectory = await fs.opendir(dirname(probe));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              missingShards++;
              this.scanShard = (this.scanShard + 1) % 256;
              directories++;
              continue;
            }
          }
          const entry = await this.scanDirectory.read();
          if (!entry) {
            await this.closeScanner();
            this.scanShard = (this.scanShard + 1) % 256;
            directories++;
            continue;
          }
          scanned++;
          const match = /^([a-f0-9]{64})\.body(?:\.([a-f0-9-]{36})\.tmp)?$/.exec(entry.name);
          if (!match || match[1].slice(0, 2) !== shard || !entry.isFile() || entry.isSymbolicLink()) { unmeasuredEntries++; continue; }
          const key = shard + '/' + entry.name;
          try {
            const file = await this.candidatePath(key);
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) { unmeasuredEntries++; continue; }
            if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isSafeInteger(observedBytes + stat.size)) {
              throw new ObservabilityStorageError('INVALID_PAYLOAD_SIZE');
            }
            // Count every measured recognized object, even if too young to be a GC candidate.
            observedBytes += stat.size; observedFiles++;
            if (stat.mtimeMs > olderThan) continue;
            candidates.push({ id: match[1], key, temporary: !!match[2],
              modifiedAt: stat.mtimeMs, size: stat.size, inode: stat.ino });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            unmeasuredEntries++;
          }
        }
        const truncated = scanned >= scanLimit || candidates.length >= candidateLimit;
        const scanUsage: PayloadScanUsage = { measurement: 'logical_file_length_before_cleanup',
          scanCoverage: !truncated && directories === 256 && startedAtShardBoundary && missingShards === 0 && unmeasuredEntries === 0 ? 'complete' : 'partial',
          scanStartedAt, scanCompletedAt: new Date().toISOString(), observedBytes, observedFiles, scannedEntries: scanned,
          missingShards, traversedShards: directories, unmeasuredEntries, startedAtShardBoundary, truncated };
        return { candidates, scanned, nextShard: this.scanShard, hasMore: truncated, scanUsage };
      } catch (error) {
        // A failed batch has no usable evidence. Reopen its shard on retry so a
        // consumed entry is not skipped and a failed directory handle is not reused.
        // closeScanner clears the handle first; preserve the original scan error.
        await this.closeScanner().catch(() => undefined);
        throw error;
      }
    });
    this.scanActive = active;
    try { return await active; }
    finally { this.scanActive = undefined; }
  }

  /** Metadata repair uses a single controlled stat, never a directory scan. */
  async isStoredObjectMissing(id: string, key: string): Promise<boolean> {
    if (key !== this.key(id)) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    // A lost/replaced owner root is not evidence that an individual object expired.
    await this.assertOwnedRoot();
    try {
      const file = await this.objectPath(key, false);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.assertOwnedRoot();
        return true;
      }
      throw error;
    }
  }

  /** Call only while the database GC fence is held and references have been checked. */
  async deleteGarbage(candidate: PayloadGarbageCandidate, olderThan: number): Promise<'deleted' | 'missing' | 'changed'> {
    try {
      const file = await this.candidatePath(candidate.key);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
      if (stat.mtimeMs > olderThan || stat.mtimeMs !== candidate.modifiedAt ||
        stat.size !== candidate.size || stat.ino !== candidate.inode) return 'changed';
      await fs.unlink(file);
      return 'deleted';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      if (error instanceof ObservabilityStorageError) throw error;
      throw new ObservabilityStorageError('PAYLOAD_DELETE_FAILED');
    }
  }

  async closeScanner(): Promise<void> {
    const directory = this.scanDirectory;
    this.scanDirectory = undefined;
    if (directory) await directory.close();
  }

  async onModuleDestroy(): Promise<void> {
    this.scannerStopping = true;
    // Nest may destroy dependent providers concurrently. Drain the current scan
    // before closing, including a directory open that has not resolved yet.
    if (!this.scannerShutdown) this.scannerShutdown = (async () => {
      await this.scanActive?.catch(() => undefined);
      await this.closeScanner();
    })();
    await this.scannerShutdown;
  }

  private async readOwner(): Promise<string | null> {
    try {
      const file = join(this.root, '.owner.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) {
        throw new ObservabilityStorageError('INVALID_PAYLOAD_OWNER_FILE');
      }
      const value = JSON.parse((await this.readBounded(file, stat.size)).toString('utf8'));
      if (value.schemaVersion !== 1 || typeof value.ownerId !== 'string') {
        throw new ObservabilityStorageError('INVALID_PAYLOAD_OWNER_FILE');
      }
      return value.ownerId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof ObservabilityStorageError) throw error;
      throw new ObservabilityStorageError('INVALID_PAYLOAD_OWNER_FILE');
    }
  }

  private async candidatePath(key: string): Promise<string> {
    const match = /^([a-f0-9]{2})\/([a-f0-9]{64})\.body(\.[a-f0-9-]{36}\.tmp)?$/.exec(key);
    if (!match || match[1] !== match[2].slice(0, 2)) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    const base = await this.objectPath(match[1] + '/' + match[2] + '.body', false);
    return base + (match[3] || '');
  }

  private key(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ObservabilityStorageError('INVALID_PAYLOAD_ID');
    return id.slice(0, 2) + '/' + id + '.body';
  }

  private async objectPath(key: string, createDirectory: boolean): Promise<string> {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.body$/.test(key) ||
      key.slice(0, 2) !== key.slice(3, 5)) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    }
    const shard = join(this.root, key.slice(0, 2));
    if (createDirectory) {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.mkdir(shard, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
    const rootStat = await fs.lstat(this.root);
    const shardStat = await fs.lstat(shard);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !shardStat.isDirectory() || shardStat.isSymbolicLink()) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    }
    const realRoot = await fs.realpath(this.root);
    const realShard = await fs.realpath(shard);
    if (dirname(realShard) !== realRoot) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    return join(realShard, key.slice(3));
  }

  private async readBounded(path: string, expectedSize: number): Promise<Buffer> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.readLimit) {
      throw new ObservabilityStorageError('INVALID_PAYLOAD_SIZE');
    }
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ObservabilityStorageError('INVALID_PAYLOAD_PATH');
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size !== expectedSize) {
        throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
      }
      const content = Buffer.alloc(expectedSize);
      let position = 0;
      while (position < content.length) {
        const result = await handle.read(content, position, content.length - position, position);
        if (result.bytesRead === 0) throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
        position += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
        throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  private async publish(key: string, data: string, digest: string): Promise<{ created: boolean; temporaryAbsent: boolean }> {
    const path = await this.objectPath(key, true);
    const temporary = path + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    let created = false, temporaryAbsent = false;
    try {
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // A hard link publishes atomically without replacing immutable evidence.
        await fs.link(temporary, path);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = await this.readBounded(path, Buffer.byteLength(data, 'utf8'));
        if (contentHash(previous) !== digest) throw new ObservabilityStorageError('PAYLOAD_INTEGRITY_ERROR');
      }
      if (process.platform !== 'win32') {
        const directory = await fs.open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await fs.unlink(temporary).then(() => { temporaryAbsent = true; }).catch(error => {
        temporaryAbsent = (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
    }
    return { created, temporaryAbsent };
  }
}
