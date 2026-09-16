import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { Dir } from 'fs';
import { dirname, join } from 'path';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

const SHARDS = 256;
const MAX_BATCH_ENTRIES = 1000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_SHARD = /^[a-f0-9]{2}$/;
const FINAL_OBJECT = /^([a-f0-9]{64})\.body$/;

type DirectoryStamp = { identity: string; realPath: string };

export interface PayloadInventoryShardCheckpoint {
  shard: number;
  state: 'present' | 'absent';
  directoryIdentity: string | null;
  observedBytes: number;
  observedFiles: number;
  scannedEntries: number;
}

/** Persist the complete prefix only. A partial shard contributes no durable bytes. */
export interface PayloadInventoryResumeEvidence {
  rootIdentity: string;
  completedShards: PayloadInventoryShardCheckpoint[];
}

export interface PayloadInventoryBatch {
  sessionId: string;
  rootIdentity: string;
  startShard: number;
  nextShard: number;
  inProgressShard: number | null;
  coverage: 'incomplete' | 'complete';
  rangeComplete: boolean;
  prefixVerified: boolean;
  writerFenceRequired: true;
  baselineReady: false;
  scannedEntries: number;
  checkpointedBytes: number;
  checkpointedFiles: number;
  completedShards: PayloadInventoryShardCheckpoint[];
}

const incomplete = (): never => { throw new ObservabilityStorageError('PAYLOAD_INVENTORY_INCOMPLETE'); };

async function stampDirectory(path: string): Promise<DirectoryStamp> {
  const stat = await fs.lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return incomplete();
  const realPath = await fs.realpath(path);
  return { realPath, identity: contentHash(canonicalJson([
    realPath, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.ctimeNs), String(stat.mtimeNs),
  ])) };
}

/** Read-only bounded inventory of one managed payload root. This is not a
 * baseline or a filesystem snapshot. A later coordinator must hold a writer/GC
 * fence across the session and persist completed-shard checkpoints atomically. */
export class PayloadInventorySession {
  readonly sessionId = randomUUID();
  private readonly checkpoints: PayloadInventoryShardCheckpoint[] = [];
  private current?: { shard: number; stamp: DirectoryStamp; directory: Dir; bytes: number; files: number; entries: number };
  private nextShard: number;
  private busy = false;
  private invalid = false;
  private closed = false;
  private prefixVerified: boolean;

  private constructor(private readonly root: string, private readonly rootStamp: DirectoryStamp,
    private readonly pathFor: (key: string) => Promise<string>,
    private readonly assertOwner: () => Promise<void>, readonly startShard: number) {
    this.nextShard = startShard;
    this.prefixVerified = startShard === 0;
  }

  static async open(root: string, pathFor: (key: string) => Promise<string>,
    assertOwner: () => Promise<void>, startShard = 0,
    resume?: PayloadInventoryResumeEvidence): Promise<PayloadInventorySession> {
    if (!Number.isInteger(startShard) || startShard < 0 || startShard > SHARDS) return incomplete();
    await assertOwner();
    const session = new PayloadInventorySession(root, await stampDirectory(root), pathFor, assertOwner, startShard);
    await session.validateRoot();
    if (resume) {
      if (resume.rootIdentity !== session.rootStamp.identity || !Array.isArray(resume.completedShards) ||
        resume.completedShards.length !== startShard) return incomplete();
      for (let index = 0; index < startShard; index++) {
        const row = resume.completedShards[index];
        if (!row || row.shard !== index || !['present', 'absent'].includes(row.state) ||
          !Number.isSafeInteger(row.observedBytes) || row.observedBytes < 0 ||
          !Number.isSafeInteger(row.observedFiles) || row.observedFiles < 0 ||
          !Number.isSafeInteger(row.scannedEntries) || row.scannedEntries < 0 ||
          row.observedFiles > row.scannedEntries ||
          (row.state === 'absent' && (row.directoryIdentity !== null || row.observedBytes !== 0 ||
            row.observedFiles !== 0 || row.scannedEntries !== 0)) ||
          (row.state === 'present' && !/^[a-f0-9]{64}$/.test(row.directoryIdentity || ''))) return incomplete();
      }
      session.checkpoints.push(...resume.completedShards.map(row => ({ ...row })));
      await session.verifyCompletedShards();
      session.prefixVerified = true;
    }
    return session;
  }

  async scanBatch(maxEntries: number): Promise<PayloadInventoryBatch> {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_BATCH_ENTRIES) return incomplete();
    if (this.busy || this.closed || this.invalid) return incomplete();
    this.busy = true;
    try {
      await this.validateRoot();
      await this.verifyCompletedShards();
      if (this.current) await this.verifyCurrentShard();
      const completedShards: PayloadInventoryShardCheckpoint[] = [];
      let scannedEntries = 0;
      while (scannedEntries < maxEntries && this.nextShard < SHARDS) {
        if (!this.current) {
          const stamp = await this.shardStamp(this.nextShard);
          if (!stamp) {
            const checkpoint: PayloadInventoryShardCheckpoint = { shard: this.nextShard, state: 'absent',
              directoryIdentity: null, observedBytes: 0, observedFiles: 0, scannedEntries: 0 };
            this.checkpoints.push(checkpoint); completedShards.push(checkpoint); this.nextShard++;
            continue;
          }
          this.current = { shard: this.nextShard, stamp, directory: await fs.opendir(join(this.root,
            this.nextShard.toString(16).padStart(2, '0'))), bytes: 0, files: 0, entries: 0 };
        }
        const entry = await this.current.directory.read();
        if (!entry) {
          const finished = this.current;
          await finished.directory.close(); this.current = undefined;
          const stamp = await this.shardStamp(finished.shard);
          if (!stamp || stamp.identity !== finished.stamp.identity) return incomplete();
          const checkpoint: PayloadInventoryShardCheckpoint = { shard: finished.shard, state: 'present',
            directoryIdentity: stamp.identity, observedBytes: finished.bytes,
            observedFiles: finished.files, scannedEntries: finished.entries };
          this.checkpoints.push(checkpoint); completedShards.push(checkpoint); this.nextShard++;
          continue;
        }
        if (!Number.isSafeInteger(this.current.entries + 1) ||
          !Number.isSafeInteger(this.current.files + 1)) return incomplete();
        scannedEntries++; this.current.entries++;
        const match = FINAL_OBJECT.exec(entry.name);
        const shard = this.current.shard.toString(16).padStart(2, '0');
        if (!match || match[1].slice(0, 2) !== shard || !entry.isFile() || entry.isSymbolicLink()) return incomplete();
        const path = await this.pathFor(shard + '/' + entry.name);
        const stat = await fs.lstat(path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < BigInt(0) || stat.size > MAX_SAFE ||
          BigInt(this.current.bytes) + stat.size > MAX_SAFE) return incomplete();
        this.current.bytes += Number(stat.size); this.current.files++;
      }
      await this.validateRoot();
      await this.verifyCompletedShards();
      if (this.current) await this.verifyCurrentShard();
      const checkpointedBytes = completedShards.reduce((sum, row) => sum + row.observedBytes, 0);
      const checkpointedFiles = completedShards.reduce((sum, row) => sum + row.observedFiles, 0);
      if (!Number.isSafeInteger(checkpointedBytes) || !Number.isSafeInteger(checkpointedFiles)) return incomplete();
      return { sessionId: this.sessionId, rootIdentity: this.rootStamp.identity, startShard: this.startShard,
        nextShard: this.nextShard, inProgressShard: this.current?.shard ?? null,
        coverage: this.prefixVerified && this.nextShard === SHARDS ? 'complete' : 'incomplete',
        rangeComplete: this.nextShard === SHARDS, prefixVerified: this.prefixVerified,
        writerFenceRequired: true, baselineReady: false,
        scannedEntries, checkpointedBytes, checkpointedFiles, completedShards: completedShards.map(row => ({ ...row })) };
    } catch {
      this.invalid = true;
      await this.closeCurrent().catch(() => undefined);
      return incomplete();
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeCurrent();
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (current) await current.directory.close();
  }

  private async validateRoot(): Promise<void> {
    await this.assertOwner();
    const current = await stampDirectory(this.root);
    if (current.identity !== this.rootStamp.identity) return incomplete();
    const directory = await fs.opendir(this.root);
    let owner = false, entries = 0;
    try {
      for (;;) {
        const entry = await directory.read();
        if (!entry) break;
        if (++entries > SHARDS + 1) return incomplete();
        if (entry.name === '.owner.json' && entry.isFile() && !entry.isSymbolicLink()) owner = true;
        else if (!HEX_SHARD.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) return incomplete();
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (!owner) return incomplete();
    await this.assertOwner();
    if ((await stampDirectory(this.root)).identity !== this.rootStamp.identity) return incomplete();
  }

  private async shardStamp(shard: number): Promise<DirectoryStamp | null> {
    const label = shard.toString(16).padStart(2, '0');
    try {
      const path = await this.pathFor(label + '/' + label + '0'.repeat(62) + '.body');
      return stampDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A missing shard is evidence only while the owner and root identity hold.
        await this.assertOwner();
        if ((await stampDirectory(this.root)).identity !== this.rootStamp.identity) return incomplete();
        return null;
      }
      throw error;
    }
  }

  private async verifyCurrentShard(): Promise<void> {
    const stamp = await this.shardStamp(this.current!.shard);
    if (!stamp || stamp.identity !== this.current!.stamp.identity) return incomplete();
  }

  private async verifyCompletedShards(): Promise<void> {
    for (const checkpoint of this.checkpoints) {
      const stamp = await this.shardStamp(checkpoint.shard);
      if (checkpoint.state === 'absent' ? stamp !== null : !stamp || stamp.identity !== checkpoint.directoryIdentity) {
        return incomplete();
      }
    }
  }
}