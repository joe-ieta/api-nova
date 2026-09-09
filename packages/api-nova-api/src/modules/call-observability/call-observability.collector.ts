import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash, Hash } from 'crypto';
import { TextDecoder } from 'util';
import { auditDirectory, InvalidRuntimeAuditRecord } from 'api-nova-parser';
import {
  RuntimeIngestCheckpointEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore, IngestContext, ProjectionHook } from './call-observability.store';
import {
  canonicalJson, contentHash, ObservabilityStorageError, publicSequence, SerialStorageLane,
} from './call-observability-storage';

export const COLLECTOR_DATASET_ID = 'call-observability:dataset';
export const COLLECTOR_STATUS_ID = 'call-observability:collector';
export const checkpointBoundaryId = (id: string) => 'call-observability:boundary:' + id;
export const isCallSourceFile = (name: string) =>
  name.length <= 240 && /^calls-v2-[a-zA-Z0-9-]+\.jsonl$/.test(name);

export interface CollectorLimits {
  maxRecords?: number;
  maxReadBytes?: number;
  maxLineBytes?: number;
}
export interface CollectionReport {
  checkpointId: string;
  byteOffset: string;
  bytesRead: number;
  processedRecords: number;
  quarantinedRecords: number;
  duplicateRecords: number;
  partialBytes: number;
  pendingFileBytes: number;
  hasMore: boolean;
  snapshotSeq: string;
}
interface ReadSession {
  id: string;
  identity: string;
  committedOffset: number;
  readOffset: number;
  maxLineBytes: number;
  chunks: Buffer[];
  lineBytes: number;
  hash: Hash;
  tail: Buffer;
}

/**
 * Single-file bounded consumer. Directory discovery/scheduling are separate.
 * Only one unfinished line is kept in memory; restart always uses committed bytes.
 */
@Injectable()
export class CallObservabilityCollector implements OnModuleDestroy {
  readonly sourceDirectory = resolve(auditDirectory());
  private readonly lane = new SerialStorageLane(1);
  private session?: ReadSession;
  private dataset?: Promise<{ historyCompleteSince: string; eventLiveSince: string }>;
  private lastError: string | null = null;

  constructor(private readonly store: CallObservabilityStore) {}

  get volatileError(): string | null { return this.lastError; }

  initialize(): Promise<{ historyCompleteSince: string; eventLiveSince: string }> {
    if (!this.dataset) {
      this.dataset = this.store.transaction(async tx => {
        const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
        const existing = await repository.findOneBy({ id: COLLECTOR_DATASET_ID });
        if (existing) return existing.value;
        const value = { historyCompleteSince: tx.now, eventLiveSince: tx.now };
        await repository.save(repository.create({ id: COLLECTOR_DATASET_ID, value, updatedAt: tx.now }));
        return value;
      }).catch(error => { this.dataset = undefined; throw error; });
    }
    return this.dataset;
  }

  async collectFile(fileName: string, limits: CollectorLimits = {},
    project?: ProjectionHook): Promise<CollectionReport> {
    if (!isCallSourceFile(fileName)) throw new ObservabilityStorageError('INVALID_SOURCE_FILE');
    const maximumRecords = this.limit(limits.maxRecords, 128, 1000);
    const maximumRead = this.limit(limits.maxReadBytes, 4 * 1024 * 1024, 8 * 1024 * 1024);
    const maximumLine = this.limit(limits.maxLineBytes, 64 * 1024 * 1024, 128 * 1024 * 1024);
    return this.lane.run(async () => {
      let handle: FileHandle | undefined;
      try {
        const dataset = await this.initialize();
        const root = await fs.lstat(this.sourceDirectory);
        if (!root.isDirectory() || root.isSymbolicLink() ||
          resolve(await fs.realpath(this.sourceDirectory)) !== this.sourceDirectory) {
          throw new ObservabilityStorageError('UNSAFE_SOURCE_DIRECTORY');
        }
        const file = join(this.sourceDirectory, fileName);
        const expected = await fs.lstat(file);
        if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
          throw new ObservabilityStorageError('UNSAFE_SOURCE_FILE');
        }
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        const identity = this.identity(opened);
        if (identity !== this.identity(expected)) throw new ObservabilityStorageError('SOURCE_FILE_CHANGED');
        const id = contentHash(canonicalJson([this.sourceDirectory, identity]));
        const state = await this.store.transaction(async tx => ({
          checkpoint: await tx.manager.getRepository(RuntimeIngestCheckpointEntity).findOneBy({ id }),
          boundary: await tx.manager.getRepository(RuntimePipelineStateEntity)
            .findOneBy({ id: checkpointBoundaryId(id) }),
        }));
        const offset = Number(state.checkpoint?.byteOffset || '0');
        if (!Number.isSafeInteger(offset) || opened.size < offset) {
          throw new ObservabilityStorageError('SOURCE_FILE_TRUNCATED');
        }
        const boundary = await this.tail(handle, offset);
        if (state.checkpoint && offset > 0 &&
          (!state.boundary || state.boundary.value.hash !== contentHash(boundary))) {
          throw new ObservabilityStorageError('SOURCE_BOUNDARY_CHANGED');
        }
        if (!this.session || this.session.id !== id || this.session.committedOffset !== offset ||
          this.session.maxLineBytes !== maximumLine) {
          this.session = { id, identity, committedOffset: offset, readOffset: offset,
            maxLineBytes: maximumLine, chunks: [], lineBytes: 0, hash: createHash('sha256'), tail: boundary };
        } else if (opened.size < this.session.readOffset ||
          !this.session.tail.equals(await this.tail(handle, this.session.readOffset))) {
          throw new ObservabilityStorageError('SOURCE_BOUNDARY_CHANGED');
        }
        const session = this.session;
        const report: CollectionReport = {
          checkpointId: id, byteOffset: String(offset), bytesRead: 0, processedRecords: 0,
          quarantinedRecords: 0, duplicateRecords: 0, partialBytes: 0,
          pendingFileBytes: opened.size - offset, hasMore: false, snapshotSeq: await this.store.watermark(),
        };
        // Pin this pass to the opened size. New appends belong to the next pass.
        while (session.readOffset < opened.size && report.bytesRead < maximumRead &&
          report.processedRecords < maximumRecords) {
          const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, maximumRead - report.bytesRead,
            opened.size - session.readOffset));
          const read = await handle.read(bytes, 0, bytes.length, session.readOffset);
          if (read.bytesRead === 0) throw new ObservabilityStorageError('SOURCE_FILE_TRUNCATED');
          report.bytesRead += read.bytesRead;
          let cursor = 0;
          while (cursor < read.bytesRead && report.processedRecords < maximumRecords) {
            const newline = bytes.subarray(0, read.bytesRead).indexOf(10, cursor);
            const end = newline < 0 ? read.bytesRead : newline + 1;
            const part = bytes.subarray(cursor, end);
            session.readOffset += part.length;
            session.tail = Buffer.concat([session.tail, part]).subarray(-64);
            session.hash.update(part);
            session.lineBytes += part.length;
            if (session.lineBytes <= maximumLine) session.chunks.push(Buffer.from(part));
            else session.chunks = [];
            cursor = end;
            if (newline < 0) continue;
            const context: IngestContext = { checkpoint: {
              id, fileName, fileIdentity: identity, previousOffset: String(session.committedOffset),
              byteOffset: String(session.readOffset), boundaryHash: contentHash(session.tail),
            } };
            const hash = session.hash.digest('hex');
            let reason: string | undefined;
            let input: any;
            if (session.lineBytes > maximumLine) reason = 'SOURCE_LINE_TOO_LARGE';
            else {
              try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true })
                .decode(Buffer.concat(session.chunks))); }
              catch { reason = 'INVALID_JSON_OR_UTF8'; }
            }
            const finalStat = await handle.stat();
            if (finalStat.size < session.readOffset ||
              !session.tail.equals(await this.tail(handle, session.readOffset))) {
              throw new ObservabilityStorageError('SOURCE_BOUNDARY_CHANGED');
            }
            let result;
            if (reason) result = await this.store.rejectRecord(context, hash, reason);
            else {
              context.suppressEvent = Date.parse(input?.completedAt || input?.startedAt) <
                Date.parse(dataset.eventLiveSince);
              try { result = await this.store.ingest(input, context, project); }
              catch (error) {
                const invalid = error instanceof InvalidRuntimeAuditRecord ||
                  error instanceof ObservabilityStorageError && [
                    'INVALID_RECORD_VERSION', 'INVALID_ASSET_REFERENCE',
                    'INVALID_RECORD_DEPTH', 'INVALID_RECORD_VALUE',
                  ].includes(error.code);
                if (!invalid) throw error; // Busy/storage failures MUST NOT consume source bytes.
                result = await this.store.rejectRecord(context, hash, 'INVALID_SOURCE_SCHEMA');
              }
            }
            session.committedOffset = session.readOffset;
            session.chunks = [];
            session.lineBytes = 0;
            session.hash = createHash('sha256');
            report.processedRecords++;
            report.quarantinedRecords += Number(result.status === 'quarantined');
            report.duplicateRecords += Number(result.status === 'duplicate');
            report.snapshotSeq = result.snapshotSeq;
          }
        }
        report.byteOffset = String(session.committedOffset);
        report.partialBytes = session.lineBytes;
        report.pendingFileBytes = Math.max(0, opened.size - session.committedOffset);
        report.hasMore = session.readOffset < opened.size;
        // EOF fragments are uncommitted and reread when a producer appends their remainder.
        if (!report.hasMore) this.session = undefined;
        await this.store.transaction(async tx => {
          const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
          await repository.save(repository.create({
            id: COLLECTOR_STATUS_ID, updatedAt: tx.now,
            value: { ...report, state: report.quarantinedRecords ? 'degraded' : 'running',
              lastSuccessAt: tx.now, error: null, backlogScope: 'last_visited_file' },
          }));
        });
        this.lastError = null;
        return report;
      } catch (error) {
        this.session = undefined;
        this.lastError = error instanceof ObservabilityStorageError ? error.code : 'COLLECTION_FAILED';
        // Best effort only. If DB is down, its unchanged heartbeat is deliberately stale.
        await this.store.transaction(async tx => {
          const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
          const previous = await repository.findOneBy({ id: COLLECTOR_STATUS_ID });
          await repository.save(repository.create({ id: COLLECTOR_STATUS_ID, updatedAt: tx.now,
            value: { ...previous?.value, state: 'degraded', error: this.lastError } }));
        }).catch(() => undefined);
        throw error;
      } finally { await handle?.close(); }
    });
  }

  onModuleDestroy(): void { this.session = undefined; }

  private limit(value: number | undefined, fallback: number, maximum: number): number {
    const selected = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
      throw new ObservabilityStorageError('INVALID_COLLECTOR_LIMIT');
    }
    return selected;
  }

  private identity(stat: { dev: number; ino: number; birthtimeMs: number; size: number }): string {
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.ino === 0) {
      throw new ObservabilityStorageError('UNSUPPORTED_SOURCE_IDENTITY');
    }
    return canonicalJson([stat.dev, stat.ino, stat.birthtimeMs]);
  }

  private async tail(file: FileHandle, offset: number): Promise<Buffer> {
    const length = Math.min(64, offset);
    const bytes = Buffer.alloc(length);
    if (length && (await file.read(bytes, 0, length, offset - length)).bytesRead !== length) {
      throw new ObservabilityStorageError('SOURCE_FILE_TRUNCATED');
    }
    return bytes;
  }
}
