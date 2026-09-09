import { Injectable } from '@nestjs/common';
import { InvocationBody, redactAuditValue } from 'api-nova-parser';
import { AuditAction, AuditLevel, AuditStatus } from '../../database/entities/audit-log.entity';
import { RuntimeInvocationEntity, RuntimePayloadEntity } from '../../database/entities/runtime-call-observability.entity';
import { AuditService } from '../security/services/audit.service';
import { UserService } from '../security/services/user.service';
import { assertObservabilityAsset, authorizeObservability, ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityPayloadStore } from './call-observability-payload.store';
import { ObservabilityStorageError } from './call-observability-storage';
import { parseObservabilityQuery } from './call-observability-query';
import { ObservabilityPayloadDto } from './call-observability-payloads.dto';

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeText(value: unknown, maximum = 500): string | null {
  return typeof value === 'string' && value.length <= maximum
    ? String(redactAuditValue(value)).replace(/[\u0000-\u001f\u007f]/g, '') : null;
}
function size(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
function expiry(payload: RuntimePayloadEntity | null): void {
  if (!payload) return;
  if (!Number.isFinite(Date.parse(payload.expiresAt))) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  if (payload.state === 'expired' || Date.parse(payload.expiresAt) <= Date.now()) {
    throw new ObservabilityApiError('PAYLOAD_EXPIRED', undefined,
      { state: 'expired', expiredAt: new Date(payload.expiresAt).toISOString() });
  }
}

@Injectable()
export class CallObservabilityPayloadsService {
  private activeReads = 0;
  constructor(
    private readonly store: CallObservabilityStore,
    private readonly payloads: CallObservabilityPayloadStore,
    private readonly audit: AuditService,
    private readonly users: UserService,
  ) {}

  async get(id: string, side: string, query: Record<string, unknown>,
    authorization: ObservabilityAuthorization, requestId: string) {
    if (!validId(id)) throw new ObservabilityApiError('INVALID_QUERY', 'id');
    if (side !== 'request' && side !== 'response') throw new ObservabilityApiError('INVALID_QUERY', 'side');
    parseObservabilityQuery(query, []);
    if (!authorization.requiredPermissions.includes('monitoring:payload:read')) {
      throw new ObservabilityApiError('FORBIDDEN');
    }
    let row: RuntimeInvocationEntity | null = null;
    let payload: RuntimePayloadEntity | null = null;
    let reserved = false;
    try {
      // Bound service-level file reads. Response buffering/quota remains TP-14/15.
      if (this.activeReads >= 4) throw new ObservabilityApiError('RATE_LIMITED');
      this.activeReads++;
      reserved = true;
      const snapshot = await this.store.readSnapshot(async tx => {
        const find = tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('inv')
          .where('inv.invocationId = :id', { id })
          .andWhere('inv.expiresAt > :now', { now: tx.now });
        if (authorization.runtimeAssetIds !== null) {
          if (!authorization.runtimeAssetIds.length) find.andWhere('1 = 0');
          else find.andWhere('inv.runtimeAssetId IN (:...assets)', { assets: [...authorization.runtimeAssetIds] });
        }
        const invocation = await find.getOne();
        if (!invocation) throw new ObservabilityApiError('NOT_FOUND');
        const payloadId = side === 'request' ? invocation.requestPayloadId : invocation.responsePayloadId;
        const object = payloadId ? await tx.manager.getRepository(RuntimePayloadEntity)
          .findOneBy({ id: payloadId, invocationId: invocation.invocationId, side }) : null;
        return { row: invocation, payload: object, snapshotSeq: tx.snapshotSeq };
      });
      row = snapshot.row; payload = snapshot.payload;
      expiry(payload);
      let data: ObservabilityPayloadDto;
      if (!payload) {
        data = { invocationId: id, recordVersion: row.recordVersion, side,
          state: 'unavailable', reason: 'payload_metadata_unavailable', contentType: '',
          encoding: 'text', observedBytes: null, capturedBytes: 0, storedBytes: 0,
          redacted: false, readRedacted: false, redactionPolicyVersion: 'unknown',
          capturedDigest: null, digestScope: 'unavailable', content: null, expiresAt: null };
      } else {
        const body = await this.payloads.read(payload);
        data = this.present(row, side, payload, body);
      }
      // Re-check current account/roles after potentially slow file I/O.
      let user;
      try { user = await this.users.findUserById(authorization.principalId); }
      catch (error) {
        if (error?.getStatus?.() === 404) throw new ObservabilityApiError('UNAUTHENTICATED');
        throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      }
      const currentScope = authorizeObservability(user, ['monitoring:payload:read']);
      assertObservabilityAsset(currentScope, row.runtimeAssetId);
      expiry(payload);
      await this.recordRead(authorization, requestId, side, row, 'prepared', data.state);
      // Audit latency must not extend the body retention window.
      expiry(payload);
      return observabilitySuccess(data, { snapshotSeq: snapshot.snapshotSeq,
        isPartial: ['incomplete', 'omitted', 'unavailable'].includes(data.state) });
    } catch (error) {
      const failure = error instanceof ObservabilityApiError ? error :
        error instanceof ObservabilityStorageError && error.code === 'PAYLOAD_EXPIRED' && payload
          ? new ObservabilityApiError('PAYLOAD_EXPIRED', undefined, {
            state: 'expired', expiredAt: new Date(payload.expiresAt).toISOString(),
          }) : new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      await this.recordRead(authorization, requestId, side, row, failure.code);
      throw failure;
    } finally {
      if (reserved) this.activeReads--;
    }
  }

  private async recordRead(authorization: ObservabilityAuthorization, requestId: string,
    side: 'request' | 'response', row: RuntimeInvocationEntity | null, result: string, state?: string): Promise<void> {
    try {
      await this.store.transaction(async tx => {
        await this.audit.log({
          action: AuditAction.API_CALLED, level: AuditLevel.INFO,
          status: result === 'prepared' ? AuditStatus.SUCCESS : AuditStatus.FAILED,
          userId: authorization.principalId, resource: 'observability.payload',
          resourceId: row?.invocationId,
          details: { operation: 'obsGetInvocationPayload', requestId, side, result,
            ...(row ? { runtimeAssetId: row.runtimeAssetId, recordVersion: row.recordVersion } : {}),
            ...(state ? { state } : {}) },
          metadata: { tags: ['observability', 'sensitive-read'], schemaVersion: '1.0' },
        }, tx.manager);
      });
    } catch { throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE'); }
  }

  private present(row: RuntimeInvocationEntity, side: 'request' | 'response',
    payload: RuntimePayloadEntity, body: InvocationBody): ObservabilityPayloadDto {
    if (!['captured', 'incomplete', 'omitted', 'unavailable'].includes(body.state)) {
      throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    }
    let encoding: ObservabilityPayloadDto['encoding'] = 'text';
    let content: unknown = null;
    let readRedacted = false;
    if ((body.state === 'captured' || body.state === 'incomplete') && body.data !== undefined) {
      if (body.encoding === 'base64') {
        encoding = 'base64';
        if (Buffer.from(body.data, 'base64').toString('base64') !== body.data) {
          throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
        }
        content = body.data;
      } else if (/multipart\//i.test(body.contentType)) {
        encoding = 'multipart';
        const parts = JSON.parse(body.data);
        if (!parts || !Array.isArray(parts.parts) || parts.parts.length > 1000) {
          throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
        }
        content = redactAuditValue(parts);
        readRedacted = JSON.stringify(content) !== body.data;
      } else if (/json/i.test(body.contentType) && body.data !== '') {
        encoding = 'json';
        const parsed = JSON.parse(body.data);
        content = redactAuditValue(parsed);
        readRedacted = JSON.stringify(content) !== JSON.stringify(parsed);
      } else {
        content = redactAuditValue(body.data);
        readRedacted = content !== body.data;
      }
    } else {
      encoding = body.encoding === 'base64' ? 'base64' : /multipart\//i.test(body.contentType)
        ? 'multipart' : /json/i.test(body.contentType) ? 'json' : 'text';
    }
    return {
      invocationId: row.invocationId, recordVersion: row.recordVersion, side,
      state: body.state, reason: safeText(body.reason, 200), contentType: safeText(body.contentType) || '',
      encoding, observedBytes: size(body.observedBytes), capturedBytes: size(body.capturedBytes) ?? 0,
      storedBytes: size(body.storedBytes) ?? 0, redacted: body.redacted === true || readRedacted, readRedacted,
      redactionPolicyVersion: safeText(body.redactionPolicyVersion) || 'unknown',
      capturedDigest: typeof body.capturedDigest === 'string' && /^[a-f0-9]{64}$/.test(body.capturedDigest)
        ? body.capturedDigest : null,
      digestScope: body.state === 'incomplete' ? 'partial'
        : ['observed_raw', 'partial', 'unavailable'].includes(body.digestScope) ? body.digestScope : 'unavailable',
      content, expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }
}
