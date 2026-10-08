import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { ObjectLiteral, Repository } from 'typeorm';
import {
  RuntimeAccessSourceEntity, RuntimeCallerCredentialEntity, RuntimeCallerEntity,
  RuntimeCallerObservationEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityWriteTransaction, ProjectionBatch, ProjectionHook } from './call-observability.store';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

interface Rows<T> { loaded: Map<string, T | null>; dirty: Map<string, T>; }
const rows = <T>(): Rows<T> => ({ loaded: new Map(), dirty: new Map() });
interface CallerBatch {
  sources: Rows<RuntimeAccessSourceEntity>;
  callers: Rows<RuntimeCallerEntity>;
  credentials: Rows<RuntimeCallerCredentialEntity>;
  observations: Rows<RuntimeCallerObservationEntity>;
  diagnostics: Rows<RuntimePipelineStateEntity>;
  counts: Map<string, number>;
}

@Injectable()
export class CallObservabilityCallersProjector {
  constructor(private readonly config: ConfigService) {}

  readonly project: ProjectionHook = Object.assign(
    ((tx, before, after) => this.projectRecord(tx, before, after)) as ProjectionHook,
    { createBatch: (): ProjectionBatch => this.createBatch() },
  );

  private createBatch(): ProjectionBatch {
    const state: CallerBatch = { sources: rows(), callers: rows(), credentials: rows(),
      observations: rows(), diagnostics: rows(), counts: new Map() };
    let owner: ObservabilityWriteTransaction | undefined, processed = 0, closed = false;
    const claim = (tx: ObservabilityWriteTransaction) => {
      if (closed || owner && owner !== tx) throw new ObservabilityStorageError('INVALID_PROJECTION_BATCH');
      owner = tx;
    };
    return {
      project: async (tx, before, after) => {
        claim(tx);
        if (++processed > 16) throw new ObservabilityStorageError('INVALID_PROJECTION_BATCH');
        await this.projectRecord(tx, before, after, state);
      },
      flush: async tx => {
        claim(tx);
        await this.flushBatch(tx, state);
      },
      dispose: () => {
        closed = true; owner = undefined;
        for (const cache of [state.sources, state.callers, state.credentials, state.observations, state.diagnostics]) {
          cache.loaded.clear(); cache.dirty.clear();
        }
        state.counts.clear();
      },
    };
  }

  private async flushBatch(tx: ObservabilityWriteTransaction, state: CallerBatch): Promise<void> {
    const upsert = async <T extends ObjectLiteral>(entity: new () => T, values: Rows<T>, key: string) => {
      const pending = [...values.dirty.values()];
      for (let offset = 0; offset < pending.length; offset += 16) {
        await tx.manager.getRepository(entity).upsert(pending.slice(offset, offset + 16) as any[], [key]);
      }
    };
    await upsert(RuntimeAccessSourceEntity, state.sources, 'sourceId');
    if (state.callers.dirty.size) {
      // Caller management also owns the counter lock. Excluding its fields from
      // conflict updates additionally prevents a cached profile overwriting them.
      await tx.manager.getRepository(RuntimeCallerEntity).createQueryBuilder().insert()
        .values([...state.callers.dirty.values()]).orUpdate(
          ['identitySource', 'firstSeenAt', 'lastSeenAt'], ['callerId']).execute();
    }
    await upsert(RuntimeCallerCredentialEntity, state.credentials, 'id');
    await upsert(RuntimeCallerObservationEntity, state.observations, 'id');
    await upsert(RuntimePipelineStateEntity, state.diagnostics, 'id');
  }

  private async read<T extends ObjectLiteral>(repository: Repository<T>, key: string, id: string,
    cache?: Rows<T>): Promise<T | null> {
    if (cache?.loaded.has(id)) return cache.loaded.get(id)!;
    const value = await repository.findOneBy({ [key]: id } as any);
    cache?.loaded.set(id, value);
    return value;
  }

  private async write<T extends ObjectLiteral>(repository: Repository<T>, key: string, value: T,
    cache?: Rows<T>): Promise<void> {
    if (!cache) { await repository.save(value); return; }
    cache.loaded.set(String(value[key]), value); cache.dirty.set(String(value[key]), value);
  }

  private async projectRecord(tx: ObservabilityWriteTransaction,
    before: Parameters<ProjectionHook>[1], after: Parameters<ProjectionHook>[2], batch?: CallerBatch): Promise<void> {
    const row = after.record;
    // Outbound attempts and maintenance work do not create external visitors.
    if (row.origin !== 'external' || row.spanKind === 'upstream_api') return;
    const secret = this.config.get<string>('API_NOVA_OBSERVABILITY_SOURCE_ID_SECRET');
    const keyId = this.config.get<string>('API_NOVA_OBSERVABILITY_SOURCE_ID_KEY_ID') || 'v1';
    const cap = Number(this.config.get('API_NOVA_OBSERVABILITY_SOURCES_PER_DAY') ?? 10000);
    if (!secret || Buffer.byteLength(secret) < 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
      !Number.isSafeInteger(cap) || cap < 1 || cap > 100000) {
      throw new ObservabilityStorageError('SOURCE_ID_CONFIGURATION_REQUIRED');
    }
    const idFor = (value: unknown) => 'src-' + keyId + '-' + createHmac('sha256', secret)
      .update('observability.source.v1.' + canonicalJson(value)).digest('hex');
    const seenAt = row.completedAt || row.startedAt;
    const first = (a: string, b: string) => a < b ? a : b;
    const last = (a: string, b: string) => a > b ? a : b;
    const trusted = row.identitySource === 'authenticated' && row.authState === 'authenticated' &&
      typeof row.callerId === 'string' && row.callerId.length > 0;
    const callerId: string | null = trusted ? row.callerId : null;
    const authState = trusted ? 'authenticated' : row.authState === 'authentication_failed'
      ? 'authentication_failed' : row.authState === 'anonymous' ? 'anonymous' : 'unknown';
    const peerIp = typeof row.peerIp === 'string' && isIP(row.peerIp) ? row.peerIp : null;
    const proxyTrusted = row.proxyTrusted === true && row.ipSource === 'trusted_proxy' &&
      typeof row.clientIp === 'string' && !!isIP(row.clientIp);
    const clientIp = proxyTrusted ? row.clientIp : peerIp;
    const ipSource = proxyTrusted ? 'trusted_proxy' : peerIp ? 'peer' : 'unknown';
    const day = row.startedAt.slice(0, 10);
    const scope = [row.runtimeAssetId, row.serverType, authState, day];
    let sourceId = idFor([...scope, clientIp, peerIp, ipSource, proxyTrusted]);
    const sources = tx.manager.getRepository(RuntimeAccessSourceEntity);
    let source = await this.read(sources, 'sourceId', sourceId, batch?.sources);
    let overflow = false;
    // The historical cap counts all server types, including overflow rows.
    const countKey = canonicalJson([row.runtimeAssetId || null, authState, day]);
    if (!source) {
      const query = sources.createQueryBuilder('source').where('source.day = :day', { day })
        .andWhere('source.authState = :authState', { authState });
      if (row.runtimeAssetId) query.andWhere('source.runtimeAssetId = :asset', { asset: row.runtimeAssetId });
      else query.andWhere('source.runtimeAssetId IS NULL');
      let count = batch?.counts.get(countKey);
      if (count === undefined) { count = await query.getCount(); batch?.counts.set(countKey, count); }
      if (count >= cap) {
        overflow = true;
        sourceId = idFor([...scope, 'overflow']);
        source = await this.read(sources, 'sourceId', sourceId, batch?.sources);
      }
    }
    const sourceFirst = source ? first(source.firstSeenAt, row.startedAt) : row.startedAt;
    const sourceLast = source ? last(source.lastSeenAt, seenAt) : seenAt;
    await this.write(sources, 'sourceId', sources.create({
      sourceId, runtimeAssetId: row.runtimeAssetId, authState,
      clientIp: overflow ? null : clientIp, peerIp: overflow ? null : peerIp,
      ipSource: overflow ? 'overflow' : ipSource, proxyTrusted: overflow ? false : proxyTrusted,
      day, firstSeenAt: sourceFirst, lastSeenAt: sourceLast,
    }), batch?.sources);
    if (!source && batch) batch.counts.set(countKey, batch.counts.get(countKey)! + 1);
    after.sourceId = sourceId;
    after.record = { ...row, sourceId, sourceOverflow: overflow,
      clientIp, peerIp, ipSource, proxyTrusted };
    if (overflow && !before) {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const id = 'call-observability:caller-diagnostics';
      const previous = await this.read(repository, 'id', id, batch?.diagnostics);
      await this.write(repository, 'id', repository.create({ id, updatedAt: tx.now, value: {
        ...previous?.value, sourceOverflowInvocations: Math.min(Number.MAX_SAFE_INTEGER,
          Number(previous?.value?.sourceOverflowInvocations || 0) + 1),
      } }), batch?.diagnostics);
    }
    if (callerId) {
      const callers = tx.manager.getRepository(RuntimeCallerEntity);
      const previous = await this.read(callers, 'callerId', callerId, batch?.callers);
      const firstSeenAt = previous ? first(previous.firstSeenAt, row.startedAt) : row.startedAt;
      const lastSeenAt = previous ? last(previous.lastSeenAt, seenAt) : seenAt;
      const changed = !previous || previous.firstSeenAt !== firstSeenAt || previous.lastSeenAt !== lastSeenAt;
      if (changed) {
        await this.write(callers, 'callerId', callers.create({ ...previous, callerId, identitySource: 'authenticated',
          displayName: previous?.displayName || null, note: previous?.note || null,
          labels: previous?.labels || [], firstSeenAt, lastSeenAt, version: previous?.version || 1 }), batch?.callers);
      }
      if (row.credentialId) {
        const credentials = tx.manager.getRepository(RuntimeCallerCredentialEntity);
        const id = contentHash(canonicalJson([callerId, row.credentialId]));
        const credential = await this.read(credentials, 'id', id, batch?.credentials);
        await this.write(credentials, 'id', credentials.create({ id, callerId, credentialId: row.credentialId,
          firstSeenAt: credential ? first(credential.firstSeenAt, row.startedAt) : row.startedAt,
          lastSeenAt: credential ? last(credential.lastSeenAt, seenAt) : seenAt }), batch?.credentials);
      }
    }
    const observations = tx.manager.getRepository(RuntimeCallerObservationEntity);
    const protocolTransport = ['http', 'stdio', 'sse', 'streamable'].includes(row.transport)
      ? row.transport : 'unknown';
    const id = contentHash(canonicalJson([callerId, sourceId, row.runtimeAssetId, row.serverType, protocolTransport]));
    const observation = await this.read(observations, 'id', id, batch?.observations);
    await this.write(observations, 'id', observations.create({ id, callerId, sourceId,
      runtimeAssetId: row.runtimeAssetId, serverType: row.serverType, protocolTransport,
      firstSeenAt: observation ? first(observation.firstSeenAt, row.startedAt) : row.startedAt,
      lastSeenAt: observation ? last(observation.lastSeenAt, seenAt) : seenAt }), batch?.observations);
  }
}
