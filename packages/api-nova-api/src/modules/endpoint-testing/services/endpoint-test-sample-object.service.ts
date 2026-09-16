import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { constants, promises as fs } from 'fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path';
import { createHash, randomBytes } from 'crypto';
import { auditDirectory } from 'api-nova-parser';
import { EndpointTestSampleObjectEntity as ObjectEntity } from '../../../database/entities/endpoint-test-sample-object.entity';

export class SampleObjectError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new SampleObjectError(code); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const overlaps = (a: string, b: string) => [relative(a, b), relative(b, a)].some(p => !p || (!p.startsWith('..') && !isAbsolute(p)));

/** Internal primitives only. Caller must authorize and resolve the sample; no HTTP exposure. */
@Injectable()
export class EndpointTestSampleObjectService {
  private readonly root = process.env.ENDPOINT_TEST_SAMPLE_BINARY_DIR?.trim();
  private readonly maxBytes = Number(process.env.ENDPOINT_TEST_SAMPLE_MAX_BYTES || 256 * 1024);
  private rootIdentity?: string;
  private busy = 0;

  constructor(@InjectRepository(ObjectEntity) private readonly objects: Repository<ObjectEntity>) {}

  private async guardRoot(): Promise<string> {
    if (!this.root || !isAbsolute(this.root) || resolve(this.root) === parse(this.root).root) fail('OBJECT_ROOT_INVALID');
    const root = resolve(this.root);
    const obs = resolve(process.env.API_NOVA_OBSERVABILITY_DATA_DIR || join(auditDirectory(), 'observability'));
    if (overlaps(root, obs) || root.split(sep).some(p => ['public', 'static', 'dist'].includes(p.toLowerCase()))) fail('OBJECT_ROOT_INVALID');
    for (let current = root; ; current = dirname(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('OBJECT_ROOT_INVALID');
      if (current === dirname(current)) break;
    }
    const stat = await fs.lstat(root);
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.rootIdentity && identity !== this.rootIdentity) fail('OBJECT_ROOT_CHANGED');
    this.rootIdentity = identity;
    return root;
  }

  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy >= 4) fail('OBJECT_BUSY');
    this.busy++;
    try { return await work(); }
    catch (error) { if (error instanceof SampleObjectError) throw error; throw new SampleObjectError('OBJECT_STORAGE_FAILED'); }
    finally { this.busy--; }
  }

  async prepare(sampleId: string, bytes: Uint8Array, mediaType: string, measurement: ObjectEntity['measurement']) {
    if (!(bytes instanceof Uint8Array)) fail('OBJECT_BYTES_INVALID');
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 128 * 1024 * 1024) fail('OBJECT_LIMIT_INVALID');
    if (bytes.byteLength > this.maxBytes) return { captureState: 'too_large' as const, observedBytes: bytes.byteLength, isComplete: true, sha256: null };
    if (!/^[a-zA-Z0-9-]{1,36}$/.test(sampleId)) fail('OBJECT_OWNER_INVALID');
    const type = mediaType.split(';')[0].trim().toLowerCase();
    if (type.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) fail('OBJECT_MEDIA_INVALID');
    if (!['decoded_response_body', 'encoded_response_body'].includes(measurement)) fail('OBJECT_MEASUREMENT_INVALID');
    // Snapshot before awaiting: caller mutation cannot change measured/stored bytes.
    const content = Buffer.from(bytes);
    const sha256 = digest(content);
    if (!this.root) return { captureState: 'metadata_only' as const, observedBytes: content.length, isComplete: true, sha256 };
    return this.bounded(async () => {
      const root = await this.guardRoot();
      const record = await this.objects.save(this.objects.create({ sampleId, side: 'response', objectKey: randomBytes(32).toString('hex'), state: 'staged', mediaType: type, measurement, observedBytes: content.length, sha256 }));
      // Persist staging ownership before any file creation. Failures remain discoverable.
      const handle = await fs.open(join(root, record.objectKey + '.stage'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await this.guardRoot();
      return { captureState: 'staged' as const, objectId: record.id, observedBytes: content.length, isComplete: true, sha256 };
    });
  }

  private async row(sampleId: string, objectId: string, state?: ObjectEntity['state']) {
    const row = await this.objects.findOneBy({ id: objectId, sampleId, side: 'response', ...(state ? { state } : {}) });
    if (!row || !/^[a-f0-9]{64}$/.test(row.objectKey) || !Number.isSafeInteger(row.observedBytes) || row.observedBytes < 0 || row.observedBytes > this.maxBytes || !/^[a-f0-9]{64}$/.test(row.sha256)) fail('OBJECT_UNAVAILABLE');
    return row;
  }

  private async readFile(row: ObjectEntity, staged: boolean): Promise<Buffer> {
    const root = await this.guardRoot();
    const path = join(root, row.objectKey + (staged ? '.stage' : '.raw'));
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== row.observedBytes) fail('OBJECT_INTEGRITY_FAILED');
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail('OBJECT_INTEGRITY_FAILED');
      bytes = Buffer.alloc(row.observedBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset !== row.observedBytes) fail('OBJECT_INTEGRITY_FAILED');
      bytes = bytes.subarray(0, offset);
    } finally { await handle.close(); }
    await this.guardRoot();
    if (digest(bytes) !== row.sha256) fail('OBJECT_INTEGRITY_FAILED');
    return bytes;
  }

  async publish(sampleId: string, objectId: string): Promise<void> {
    return this.bounded(async () => {
      const row = await this.row(sampleId, objectId);
      if (row.state === 'ready') { await this.readFile(row, false); return; }
      if (row.state !== 'staged') fail('OBJECT_UNAVAILABLE');
      const root = await this.guardRoot();
      const stage = join(root, row.objectKey + '.stage');
      const published = join(root, row.objectKey + '.raw');
      const exists = async (path: string) => {
        try { await fs.lstat(path); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      };
      const stageExists = await exists(stage);
      const publishedExists = await exists(published);
      if (stageExists && publishedExists) fail('OBJECT_DESTINATION_EXISTS');
      if (stageExists) {
        await this.readFile(row, true);
        if (await exists(published)) fail('OBJECT_DESTINATION_EXISTS');
        await fs.rename(stage, published);
      } else if (!publishedExists) {
        fail('OBJECT_UNAVAILABLE');
      }
      // A valid final file with no staged file is recoverable after rename
      // succeeded but the ready-state database update failed.
      await this.readFile(row, false);
      const result = await this.objects.update({ id: objectId, sampleId, state: 'staged' }, { state: 'ready' });
      if (result.affected !== 1) {
        const current = await this.row(sampleId, objectId, 'ready');
        if (current.objectKey !== row.objectKey || current.sha256 !== row.sha256 || current.observedBytes !== row.observedBytes) fail('OBJECT_UNAVAILABLE');
        await this.readFile(current, false);
      }
    });
  }

  async read(sampleId: string, objectId: string): Promise<Buffer> {
    return this.bounded(async () => {
      const row = await this.row(sampleId, objectId, 'ready');
      const bytes = await this.readFile(row, false);
      const current = await this.row(sampleId, objectId, 'ready');
      if (current.objectKey !== row.objectKey || current.sha256 !== row.sha256 || current.observedBytes !== row.observedBytes) fail('OBJECT_UNAVAILABLE');
      return bytes;
    });
  }
}
