import { Injectable } from '@nestjs/common';
import { constants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join, resolve } from 'path';
import type { Stats } from 'fs';
import { auditDirectory, isRuntimeAuditSourceId } from 'api-nova-parser';
import {
  RuntimeIngestCheckpointEntity,
  RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { checkpointBoundaryId, isCallSourceFile } from './call-observability.collector';
import {
  SOURCE_EXIT_PREFIX,
  SOURCE_FILE_SEAL_PREFIX,
} from './call-observability-source-lifecycle.service';
import { matchesOpenedSource } from './call-observability-source-identity';
import {
  canonicalJson,
  contentHash,
  ObservabilityStorageError,
  publicSequence,
} from './call-observability-storage';

export const STAGED_SOURCE_RECOVERY_STATE_ID = 'call-observability:staged-source-recovery';
/** Approved recovery window; never lowered by implementation or configuration. */
export const STAGED_SOURCE_MIN_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface StagedSourceRecoveryOptions {
  scanLimit: number;
  deleteLimit: number;
  retentionMs: number;
  now?: Date;
}

export type StagedSourceRetentionReason =
  | 'unsafe_entry'
  | 'identity_mismatch'
  | 'checkpoint_missing'
  | 'incomplete_import'
  | 'boundary_mismatch'
  | 'seal_mismatch'
  | 'source_not_closed'
  | 'incomplete_line'
  | 'retention_anchor_invalid'
  | 'within_retention_window';

export interface StagedSourceRecoveryReport {
  status: 'completed' | 'waiting';
  scanned: number;
  deleted: number;
  missing: number;
  retained: number;
  retainedReasons: Record<string, number>;
  cutoff: string;
  nextAfterName: string | null;
  hasMore: boolean;
  snapshotSeq: string;
}

interface StagedCandidate {
  retain?: StagedSourceRetentionReason;
  delete?: boolean;
  expected?: { ino: number; birthtimeMs: number; size: number };
}

interface CheckpointView {
  id: string;
  fileIdentity: string;
  byteOffset: string;
  updatedAt: Date | string;
  fileName: string;
}

/**
 * Bounded recovery of fully imported staged source files. The collector remains
 * the only import path; this service only consumes its durable identity,
 * committed-offset, boundary, seal and closed-source evidence. Ambiguity always
 * retains the file. Cleanup never touches checkpoints, receipts, events or
 * business rows and never allocates a business sequence.
 */
@Injectable()
export class CallObservabilityStagedSourceRecoveryService {
  private readonly root = resolve(auditDirectory());

  constructor(private readonly store: CallObservabilityStore) {}

  async collect(options: StagedSourceRecoveryOptions): Promise<StagedSourceRecoveryReport> {
    const { scanLimit, deleteLimit, retentionMs } = options;
    if (!Number.isSafeInteger(scanLimit) || !Number.isSafeInteger(deleteLimit)
      || scanLimit < 1 || deleteLimit < 1 || deleteLimit > scanLimit) {
      throw new ObservabilityStorageError('INVALID_STAGED_SOURCE_RECOVERY_CONFIGURATION');
    }
    if (!Number.isSafeInteger(retentionMs) || retentionMs < STAGED_SOURCE_MIN_RETENTION_MS) {
      throw new ObservabilityStorageError('STAGED_SOURCE_RETENTION_BELOW_MINIMUM');
    }
    const now = options.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new ObservabilityStorageError('INVALID_STAGED_SOURCE_RECOVERY_CONFIGURATION');
    }
    const cutoff = new Date(now.getTime() - retentionMs);
    const root = await this.lstatSafe(this.root);
    if (!root || !root.isDirectory() || root.isSymbolicLink()
      || resolve(await fs.realpath(this.root)) !== this.root) {
      throw new ObservabilityStorageError('UNSAFE_SOURCE_DIRECTORY');
    }
    const previous = await this.store.transaction(tx =>
      tx.manager.getRepository(RuntimePipelineStateEntity)
        .findOneBy({ id: STAGED_SOURCE_RECOVERY_STATE_ID }));
    const afterName = typeof previous?.value?.checkpoint?.afterName === 'string'
      ? previous.value.checkpoint.afterName : null;
    const names = (await fs.readdir(this.root, { withFileTypes: true }))
      .filter(entry => isCallSourceFile(entry.name))
      .map(entry => entry.name)
      .sort();
    const remaining = names.filter(name => afterName === null || name > afterName);
    const page = remaining.slice(0, scanLimit);

    let deleted = 0;
    let missing = 0;
    let retained = 0;
    let examined: string | null = afterName;
    let hasMore = remaining.length > page.length;
    const retainedReasons: Record<string, number> = {};
    for (const name of page) {
      if (deleted >= deleteLimit) {
        // Bounded batch: leave the rest of the page for the next run.
        hasMore = true;
        break;
      }
      const candidate = await this.inspect(name, cutoff, now);
      if (candidate.delete) {
        try {
          await this.deleteCandidate(name, candidate.expected!);
          deleted += 1;
        } catch (error: any) {
          if (error?.code === 'ENOENT') missing += 1;
          else throw error;
        }
      } else {
        retained += 1;
        const reason = candidate.retain || 'unknown';
        retainedReasons[reason] = (retainedReasons[reason] || 0) + 1;
      }
      examined = name;
    }
    const exhausted = !hasMore && remaining.length <= page.length;
    const nextAfterName = exhausted ? null : examined;
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const snapshotSeq = publicSequence(tx.currentSequence());
      const report: StagedSourceRecoveryReport = {
        status: nextAfterName === null ? 'completed' : 'waiting',
        scanned: page.length,
        deleted,
        missing,
        retained,
        retainedReasons,
        cutoff: cutoff.toISOString(),
        nextAfterName,
        hasMore: nextAfterName !== null,
        snapshotSeq,
      };
      const state = await repository.findOneBy({ id: STAGED_SOURCE_RECOVERY_STATE_ID });
      const value = {
        ...(state?.value || {}),
        checkpoint: nextAfterName === null ? null : { afterName: nextAfterName },
        lastReport: report,
        lastCollectionAt: now.toISOString(),
        stateVersion: Number(state?.value?.stateVersion || 0) + 1,
        snapshotSeq,
      };
      await repository.save(repository.create({
        id: STAGED_SOURCE_RECOVERY_STATE_ID,
        value,
        updatedAt: tx.now,
      }));
      return report;
    });
  }

  private async inspect(name: string, cutoff: Date, now: Date): Promise<StagedCandidate> {
    const path = join(this.root, name);
    const expected = await this.lstatSafe(path);
    if (!expected || !expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1
      || !Number.isInteger(expected.ino) || expected.ino <= 0) {
      return { retain: 'unsafe_entry' };
    }
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!Number.isSafeInteger(opened.size) || opened.size < 1 || opened.ino <= 0
        || !await matchesOpenedSource(path, expected, opened, process.platform, handle)) {
        return { retain: 'identity_mismatch' };
      }
      const identity = canonicalJson([opened.dev, opened.ino, opened.birthtimeMs]);
      const checkpointId = contentHash(canonicalJson([this.root, identity]));
      const state = await this.store.transaction(async tx => ({
        checkpoint: await tx.manager.getRepository(RuntimeIngestCheckpointEntity)
          .findOneBy({ id: checkpointId }),
        boundary: await tx.manager.getRepository(RuntimePipelineStateEntity)
          .findOneBy({ id: checkpointBoundaryId(checkpointId) }),
        seal: await tx.manager.getRepository(RuntimePipelineStateEntity)
          .findOneBy({ id: SOURCE_FILE_SEAL_PREFIX + checkpointId }),
      }));
      const checkpoint = state.checkpoint as CheckpointView | null | undefined;
      if (!checkpoint) return { retain: 'checkpoint_missing' };
      if (checkpoint.fileIdentity !== identity) return { retain: 'identity_mismatch' };
      if (BigInt(checkpoint.byteOffset) !== BigInt(opened.size)) return { retain: 'incomplete_import' };
      const boundaryHash = contentHash(await this.tail(handle, opened.size));
      if (!state.boundary || state.boundary.value?.hash !== boundaryHash) {
        return { retain: 'boundary_mismatch' };
      }
      const seal = state.seal?.value;
      if (!seal) return { retain: 'source_not_closed' };
      if (seal.fileIdentity !== identity || seal.finalSize !== String(opened.size)
        || seal.boundaryHash !== boundaryHash || !isRuntimeAuditSourceId(seal.sourceInstanceId)) {
        return { retain: 'seal_mismatch' };
      }
      const proof = await this.store.transaction(tx =>
        tx.manager.getRepository(RuntimePipelineStateEntity)
          .findOneBy({ id: SOURCE_EXIT_PREFIX + seal.sourceInstanceId }));
      if (!proof || proof.value?.state !== 'closed'
        || proof.value?.sourceInstanceId !== seal.sourceInstanceId) {
        return { retain: 'source_not_closed' };
      }
      const last = await this.lastByte(handle, opened.size);
      if (last !== 0x0a) return { retain: 'incomplete_line' };
      const importedAt = Math.max(
        this.parseTime(checkpoint.updatedAt),
        this.parseTime(proof.value?.observedAt),
      );
      if (!Number.isFinite(importedAt)) return { retain: 'retention_anchor_invalid' };
      if (importedAt > cutoff.getTime()) return { retain: 'within_retention_window' };
      return {
        delete: true,
        expected: {
          ino: opened.ino,
          birthtimeMs: opened.birthtimeMs,
          size: opened.size,
        },
      };
    } finally {
      await handle?.close();
    }
  }

  private async deleteCandidate(
    name: string,
    expected: { ino: number; birthtimeMs: number; size: number },
  ): Promise<void> {
    const path = join(this.root, name);
    const current = await this.lstatSafe(path);
    if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.ino !== expected.ino || current.birthtimeMs !== expected.birthtimeMs
      || current.size !== expected.size) {
      throw new ObservabilityStorageError('SOURCE_FILE_CHANGED');
    }
    await fs.unlink(path);
  }

  private async lstatSafe(path: string): Promise<Stats | undefined> {
    try {
      return await fs.lstat(path);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async tail(handle: FileHandle, offset: number): Promise<Buffer> {
    const length = Math.min(64, offset);
    const bytes = Buffer.alloc(length);
    if (length && (await handle.read(bytes, 0, length, offset - length)).bytesRead !== length) {
      throw new ObservabilityStorageError('SOURCE_FILE_TRUNCATED');
    }
    return bytes;
  }

  private async lastByte(handle: FileHandle, size: number): Promise<number> {
    const byte = Buffer.alloc(1);
    if ((await handle.read(byte, 0, 1, size - 1)).bytesRead !== 1) {
      throw new ObservabilityStorageError('SOURCE_FILE_TRUNCATED');
    }
    return byte[0];
  }

  private parseTime(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
  }
}
