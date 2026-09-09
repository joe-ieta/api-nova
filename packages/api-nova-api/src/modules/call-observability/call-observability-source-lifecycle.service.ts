import { Injectable } from '@nestjs/common';
import { constants, promises as fs } from 'fs';
import { join, resolve } from 'path';
import { TextDecoder } from 'util';
import { auditDirectory, isRuntimeAuditSourceId, normalizeRuntimeAuditSourceManifest } from 'api-nova-parser';
import { RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { CallObservabilityStore } from './call-observability.store';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

export const SOURCE_EXIT_PREFIX = 'call-observability:source-exit:';
export const SOURCE_FILE_SEAL_PREFIX = 'call-observability:source-seal:';
export interface SourceLifecycleObservation {
  sourceInstanceId: string | null;
  state: 'active' | 'closed' | 'unknown';
  reason: string | null;
  proofId?: string;
  manifestHash?: string;
  observedAt?: string;
}

/** A shell exit, an EOF, a timeout or EPERM is never proof of producer death. */
@Injectable()
export class CallObservabilitySourceLifecycle {
  private readonly root = resolve(auditDirectory());
  constructor(private readonly store: CallObservabilityStore) {}

  async observe(sourceInstanceId: string | null): Promise<SourceLifecycleObservation> {
    const unknown = (reason: string): SourceLifecycleObservation =>
      ({ sourceInstanceId, state: 'unknown', reason });
    if (!isRuntimeAuditSourceId(sourceInstanceId)) return unknown('unbound_source');
    let manifest;
    let manifestHash: string;
    try {
      const root = await fs.lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink() || resolve(await fs.realpath(this.root)) !== this.root) {
        return unknown('unsafe_source_directory');
      }
      const file = join(this.root, 'source-v2-' + sourceInstanceId + '.json');
      const expected = await fs.lstat(file);
      if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 ||
        expected.size < 1 || expected.size > 4096) return unknown('unsafe_source_manifest');
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const before = await handle.stat();
        if (before.ino !== expected.ino || before.dev !== expected.dev || before.size !== expected.size) {
          return unknown('source_manifest_changed');
        }
        const bytes = Buffer.alloc(before.size);
        if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) {
          return unknown('source_manifest_changed');
        }
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return unknown('source_manifest_changed');
        manifest = normalizeRuntimeAuditSourceManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (manifest.sourceInstanceId !== sourceInstanceId) return unknown('source_manifest_mismatch');
        manifestHash = contentHash(bytes);
      } finally { await handle.close(); }
    } catch (error: any) {
      return unknown(error?.code === 'ENOENT' ? 'source_manifest_missing' : 'source_manifest_unavailable');
    }
    const proofId = SOURCE_EXIT_PREFIX + sourceInstanceId;
    const previous = await this.store.transaction(tx => tx.manager.getRepository(RuntimePipelineStateEntity)
      .findOneBy({ id: proofId }));
    if (previous) {
      if (previous.value.manifestHash !== manifestHash) return unknown('source_manifest_changed');
      return { sourceInstanceId, state: 'closed', reason: null, proofId,
        manifestHash, observedAt: previous.value.observedAt };
    }
    const status = this.probeProcess(manifest.pid);
    if (status === 'active') return { sourceInstanceId, state: 'active', reason: null };
    if (status === 'unknown') return unknown('process_probe_inconclusive');
    const proof = await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const existing = await repository.findOneBy({ id: proofId });
      if (existing && existing.value.manifestHash !== manifestHash) {
        throw new ObservabilityStorageError('SOURCE_EXIT_PROOF_CONFLICT');
      }
      if (existing) return existing.value;
      const value = { sourceInstanceId, state: 'closed', pid: manifest.pid, manifestHash,
        observedAt: tx.now, startedAt: manifest.startedAt, reason: 'pid_absent' };
      await repository.save(repository.create({ id: proofId, value, updatedAt: tx.now }));
      return value;
    });
    return { sourceInstanceId, state: 'closed', reason: null, proofId,
      manifestHash, observedAt: proof.observedAt };
  }

  async sealFile(checkpointId: string, fileIdentity: string, finalSize: number,
    boundaryHash: string, observation: SourceLifecycleObservation): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(checkpointId) || !/^[a-f0-9]{64}$/.test(boundaryHash) ||
      !Number.isSafeInteger(finalSize) || finalSize < 0 || fileIdentity.length > 500 ||
      observation.state !== 'closed' || !isRuntimeAuditSourceId(observation.sourceInstanceId) ||
      observation.proofId !== SOURCE_EXIT_PREFIX + observation.sourceInstanceId) {
      throw new ObservabilityStorageError('INVALID_SOURCE_SEAL');
    }
    await this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const proof = await repository.findOneBy({ id: observation.proofId });
      if (!proof || proof.value.state !== 'closed' || proof.value.manifestHash !== observation.manifestHash) {
        throw new ObservabilityStorageError('INVALID_SOURCE_SEAL');
      }
      const id = SOURCE_FILE_SEAL_PREFIX + checkpointId;
      const value = { sourceInstanceId: observation.sourceInstanceId, proofId: observation.proofId,
        fileIdentity, finalSize: String(finalSize), boundaryHash };
      const previous = await repository.findOneBy({ id });
      if (previous && canonicalJson(previous.value) !== canonicalJson(value)) {
        throw new ObservabilityStorageError('SOURCE_SEALED_FILE_CHANGED');
      }
      if (!previous) await repository.save(repository.create({ id, value, updatedAt: tx.now }));
    });
  }

  async persistedProofId(sourceInstanceId: string): Promise<string | undefined> {
    if (!isRuntimeAuditSourceId(sourceInstanceId)) return undefined;
    const id = SOURCE_EXIT_PREFIX + sourceInstanceId;
    const proof = await this.store.transaction(tx => tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id }));
    return proof?.value?.state === 'closed' ? id : undefined;
  }

  private probeProcess(pid: number): 'active' | 'absent' | 'unknown' {
    try { process.kill(pid, 0); return 'active'; }
    catch (error: any) { return error?.code === 'ESRCH' ? 'absent' : 'unknown'; }
  }
}
