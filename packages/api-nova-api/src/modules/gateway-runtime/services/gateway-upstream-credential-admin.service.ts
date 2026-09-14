import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { UpstreamCredentialRegistry, UpstreamCredentialRegistryError } from 'api-nova-parser';
import { AuditAction, AuditLevel, AuditStatus } from '../../../database/entities/audit-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { GATEWAY_UPSTREAM_CREDENTIAL_CONFIG, GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY } from './gateway-upstream-credential.providers';

@Injectable()
export class GatewayUpstreamCredentialAdminService {
  private readonly file: unknown;
  private readonly format: unknown;
  private busy = false;

  constructor(@Inject(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY) private readonly registry: UpstreamCredentialRegistry | null,
    config: ConfigService, private readonly audit: AuditService) {
    // Capture the trusted configured source once; HTTP callers cannot replace it.
    this.file = config.get(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.file);
    this.format = config.get(GATEWAY_UPSTREAM_CREDENTIAL_CONFIG.format);
  }

  status() {
    if (!this.registry) return { configured: false, state: 'disabled', generation: 0, reloading: false };
    const state = this.registry.getStatus();
    return { configured: true, state: state.state, generation: state.generation,
      environment: state.environment, revision: state.revision, reloading: state.reloading || this.busy,
      lastReloadError: state.lastReloadError };
  }

  async reload(body: unknown, actorId: string) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['expectedGeneration', 'reason'].includes(key)) ||
      typeof (body as any).reason !== 'string' || !(body as any).reason.trim() || (body as any).reason.length > 500 ||
      /[\u0000-\u001f\u007f]/.test((body as any).reason) ||
      !Number.isSafeInteger((body as any).expectedGeneration) || (body as any).expectedGeneration < 0) {
      throw new BadRequestException({ code: 'INVALID_RELOAD_REQUEST' });
    }
    if (typeof actorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) {
      throw new BadRequestException({ code: 'INVALID_RELOAD_ACTOR' });
    }
    if (!this.registry || typeof this.file !== 'string' || !this.file ||
      (this.format !== 'json' && this.format !== 'yaml')) {
      throw new ServiceUnavailableException({ code: 'UPSTREAM_CREDENTIALS_NOT_CONFIGURED' });
    }
    if (this.busy || this.registry.getStatus().reloading) throw new ConflictException({ code: 'RELOAD_IN_PROGRESS' });
    this.busy = true;
    const operationId = randomUUID();
    const reasonDigest = createHash('sha256').update((body as any).reason.trim()).digest('hex');
    const before = this.registry.getStatus().generation;
    try {
      if ((body as any).expectedGeneration !== before) {
        await this.record(actorId, operationId, AuditStatus.FAILED, before, 'GENERATION_CONFLICT', reasonDigest);
        throw new ConflictException({ code: 'GENERATION_CONFLICT' });
      }
      // Fail before activation if the intent cannot be durably recorded.
      await this.record(actorId, operationId, AuditStatus.PENDING, before, 'requested', reasonDigest);
      try { await this.registry.reloadFile(this.file, this.format); }
      catch (error) {
        const code = error instanceof UpstreamCredentialRegistryError ? error.code : 'RELOAD_FAILED';
        await this.record(actorId, operationId, AuditStatus.FAILED, before, code, reasonDigest);
        throw new BadRequestException({ code, operationId, generation: this.registry.getStatus().generation });
      }
      await this.record(actorId, operationId, AuditStatus.SUCCESS, before, 'activated', reasonDigest);
      return { ...this.status(), reloading: false, operationId };
    } finally { this.busy = false; }
  }

  private async record(actorId: string, operationId: string, status: AuditStatus, beforeGeneration: number, result: string, reasonDigest: string) {
    try {
      await this.audit.log({ action: AuditAction.CONFIG_UPDATED, level: AuditLevel.INFO, status,
        userId: actorId, resource: 'upstream_credential_registry', resourceId: operationId,
        details: { operation: 'upstream_credentials.reload', operationId, beforeGeneration,
          generation: this.registry!.getStatus().generation, result, reasonProvided: true, reasonDigest } });
    } catch {
      throw new ServiceUnavailableException({ code: 'RELOAD_AUDIT_UNAVAILABLE', operationId,
        generation: this.registry!.getStatus().generation });
    }
  }
}
