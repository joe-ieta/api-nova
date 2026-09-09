import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { RuntimeObservabilityIdempotencyEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { canonicalJson, contentHash } from './call-observability-storage';
import { CallObservabilityStore, ObservabilityWriteTransaction } from './call-observability.store';

export function observabilityEtag(resourceId: string, version: number): string {
  if (!resourceId || resourceId.length > 500 || !Number.isSafeInteger(version) || version < 1) {
    throw new ObservabilityApiError('INVALID_QUERY', 'version');
  }
  return '"obs.' + contentHash(resourceId).slice(0, 32) + '.' + version + '"';
}

/** Call inside the same locked transaction that reads and changes the resource. */
export function requireObservabilityIfMatch(header: unknown, resourceId: string, version: number): void {
  if (header === undefined || header === null) throw new ObservabilityApiError('PRECONDITION_REQUIRED');
  if (typeof header !== 'string' || !/^"obs\.[a-f0-9]{32}\.[1-9][0-9]{0,15}"$/.test(header)) {
    throw new ObservabilityApiError('INVALID_QUERY', 'If-Match');
  }
  if (header !== observabilityEtag(resourceId, version)) throw new ObservabilityApiError('PRECONDITION_FAILED');
}

export function observabilityIdempotencyKey(header: unknown, required = false): string | null {
  if (header === undefined || header === null) {
    if (required) throw new ObservabilityApiError('INVALID_QUERY', 'Idempotency-Key');
    return null;
  }
  if (typeof header !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(header)) {
    throw new ObservabilityApiError('INVALID_QUERY', 'Idempotency-Key');
  }
  return header;
}

/** Store only safe operation references, never a subscription secret or raw response. */
export interface ObservabilityCommandResult {
  statusCode: 200 | 201 | 202 | 204;
  resourceId: string;
  version: number | null;
  operationId?: string;
}
export interface ObservabilityIdempotentCommand {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  key: string;
  request: unknown;
}

function safeResult(result: ObservabilityCommandResult): ObservabilityCommandResult {
  if (!result || ![200,201,202,204].includes(result.statusCode) ||
    typeof result.resourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(result.resourceId) ||
    (result.version !== null && (!Number.isSafeInteger(result.version) || result.version < 1)) ||
    (result.operationId !== undefined && (typeof result.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(result.operationId))) ||
    Object.keys(result).some(key => !['statusCode','resourceId','version','operationId'].includes(key))) {
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
  return { statusCode: result.statusCode, resourceId: result.resourceId, version: result.version,
    ...(result.operationId ? { operationId: result.operationId } : {}) };
}

@Injectable()
export class ObservabilityCommandStore {
  constructor(private readonly store: CallObservabilityStore, private readonly config: ConfigService) {}

  async execute(
    authorization: ObservabilityAuthorization,
    command: ObservabilityIdempotentCommand,
    /** Must check current object ownership/permissions even on a replay. No external I/O. */
    authorize: (tx: ObservabilityWriteTransaction, previous: ObservabilityCommandResult | null) => Promise<void>,
    /** DB-only mutation, audit/outbox writes and idempotency receipt share one commit. */
    operation: (tx: ObservabilityWriteTransaction) => Promise<ObservabilityCommandResult>,
  ): Promise<{ result: ObservabilityCommandResult; replayed: boolean }> {
    const key = observabilityIdempotencyKey(command.key, true);
    if (!['POST','PATCH','DELETE'].includes(command.method) ||
      !/^\/api\/v1\/monitoring\/observability\/[A-Za-z0-9_./:-]{1,500}$/.test(command.path) ||
      command.path.split('/').some(part => part === '.' || part === '..')) {
      throw new ObservabilityApiError('INVALID_QUERY');
    }
    const secret = this.config.get<string>('API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET');
    if (!secret || Buffer.byteLength(secret) < 32) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
    const hash = (domain: string, value: unknown) => createHmac('sha256', secret).update(domain + '.' + canonicalJson(value)).digest('hex');
    const id = contentHash(canonicalJson(['observability.idempotency.identity.v1', authorization.principalId, command.method, command.path, key]));
    const body = canonicalJson(command.request);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new ObservabilityApiError('QUERY_TOO_LARGE');
    const requestHash = hash('observability.idempotency.request.v1', body);
    return this.store.transaction(async tx => {
      const repository = tx.manager.getRepository(RuntimeObservabilityIdempotencyEntity);
      const previous = await repository.findOne({ where: { id } });
      if (previous && previous.expiresAt > tx.now) {
        if (previous.ownerId !== authorization.principalId ||
          previous.response?.scopeFingerprint !== authorization.fingerprint) throw new ObservabilityApiError('FORBIDDEN');
        const result = safeResult(previous.response?.result);
        await authorize(tx, result);
        if (previous.requestHash !== requestHash) throw new ObservabilityApiError('IDEMPOTENCY_CONFLICT');
        return { result, replayed: true };
      }
      await authorize(tx, null);
      if (previous) await repository.delete(id);
      const result = safeResult(await operation(tx));
      await repository.save(repository.create({
        id, ownerId: authorization.principalId, requestHash,
        response: { scopeFingerprint: authorization.fingerprint, result },
        expiresAt: new Date(Date.parse(tx.now) + 86400000).toISOString(),
      }));
      return { result, replayed: false };
    });
  }
}
