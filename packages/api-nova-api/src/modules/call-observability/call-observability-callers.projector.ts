import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import {
  RuntimeAccessSourceEntity, RuntimeCallerCredentialEntity, RuntimeCallerEntity,
  RuntimeCallerObservationEntity, RuntimePipelineStateEntity,
} from '../../database/entities/runtime-call-observability.entity';
import { ProjectionHook } from './call-observability.store';
import { canonicalJson, contentHash, ObservabilityStorageError } from './call-observability-storage';

@Injectable()
export class CallObservabilityCallersProjector {
  constructor(private readonly config: ConfigService) {}

  readonly project: ProjectionHook = async (tx, before, after) => {
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
    let source = await sources.findOneBy({ sourceId });
    let overflow = false;
    if (!source) {
      const query = sources.createQueryBuilder('source').where('source.day = :day', { day })
        .andWhere('source.authState = :authState', { authState });
      if (row.runtimeAssetId) query.andWhere('source.runtimeAssetId = :asset', { asset: row.runtimeAssetId });
      else query.andWhere('source.runtimeAssetId IS NULL');
      if (await query.getCount() >= cap) {
        overflow = true;
        sourceId = idFor([...scope, 'overflow']);
        source = await sources.findOneBy({ sourceId });
      }
    }
    const sourceFirst = source ? first(source.firstSeenAt, row.startedAt) : row.startedAt;
    const sourceLast = source ? last(source.lastSeenAt, seenAt) : seenAt;
    await sources.save(sources.create({
      sourceId, runtimeAssetId: row.runtimeAssetId, authState,
      clientIp: overflow ? null : clientIp, peerIp: overflow ? null : peerIp,
      ipSource: overflow ? 'overflow' : ipSource, proxyTrusted: overflow ? false : proxyTrusted,
      day, firstSeenAt: sourceFirst, lastSeenAt: sourceLast,
    }));
    after.sourceId = sourceId;
    after.record = { ...row, sourceId, sourceOverflow: overflow,
      clientIp, peerIp, ipSource, proxyTrusted };
    if (overflow && !before) {
      const repository = tx.manager.getRepository(RuntimePipelineStateEntity);
      const id = 'call-observability:caller-diagnostics';
      const previous = await repository.findOneBy({ id });
      await repository.save(repository.create({ id, updatedAt: tx.now, value: {
        ...previous?.value, sourceOverflowInvocations: Math.min(Number.MAX_SAFE_INTEGER,
          Number(previous?.value?.sourceOverflowInvocations || 0) + 1),
      } }));
    }
    if (callerId) {
      const callers = tx.manager.getRepository(RuntimeCallerEntity);
      const previous = await callers.findOneBy({ callerId });
      const firstSeenAt = previous ? first(previous.firstSeenAt, row.startedAt) : row.startedAt;
      const lastSeenAt = previous ? last(previous.lastSeenAt, seenAt) : seenAt;
      const changed = !previous || previous.firstSeenAt !== firstSeenAt || previous.lastSeenAt !== lastSeenAt;
      if (changed) {
        if ((previous?.version || 0) >= 2147483647) throw new ObservabilityStorageError('CALLER_VERSION_EXHAUSTED');
        await callers.save(callers.create({ ...previous, callerId, identitySource: 'authenticated',
          displayName: previous?.displayName || null, note: previous?.note || null,
          labels: previous?.labels || [], firstSeenAt, lastSeenAt, version: (previous?.version || 0) + 1 }));
      }
      if (row.credentialId) {
        const credentials = tx.manager.getRepository(RuntimeCallerCredentialEntity);
        const id = contentHash(canonicalJson([callerId, row.credentialId]));
        const credential = await credentials.findOneBy({ id });
        await credentials.save(credentials.create({ id, callerId, credentialId: row.credentialId,
          firstSeenAt: credential ? first(credential.firstSeenAt, row.startedAt) : row.startedAt,
          lastSeenAt: credential ? last(credential.lastSeenAt, seenAt) : seenAt }));
      }
    }
    const observations = tx.manager.getRepository(RuntimeCallerObservationEntity);
    const protocolTransport = ['http', 'stdio', 'sse', 'streamable'].includes(row.transport)
      ? row.transport : 'unknown';
    const id = contentHash(canonicalJson([callerId, sourceId, row.runtimeAssetId, row.serverType, protocolTransport]));
    const observation = await observations.findOneBy({ id });
    await observations.save(observations.create({ id, callerId, sourceId,
      runtimeAssetId: row.runtimeAssetId, serverType: row.serverType, protocolTransport,
      firstSeenAt: observation ? first(observation.firstSeenAt, row.startedAt) : row.startedAt,
      lastSeenAt: observation ? last(observation.lastSeenAt, seenAt) : seenAt }));
  };
}
