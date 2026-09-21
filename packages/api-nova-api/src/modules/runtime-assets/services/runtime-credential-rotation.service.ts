import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateRuntimeAccessCredential } from 'api-nova-parser';
import { GatewayConsumerCredentialEntity, GatewayConsumerCredentialStatus } from '../../../database/entities/gateway-consumer-credential.entity';
import { AuditAction, AuditLevel, AuditStatus } from '../../../database/entities/audit-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { toRuntimeAccessCredential } from './runtime-access-credential';

@Injectable()
export class RuntimeCredentialRotationService {
  constructor(
    @InjectRepository(GatewayConsumerCredentialEntity) private readonly credentials: Repository<GatewayConsumerCredentialEntity>,
    private readonly audit: AuditService,
  ) {}

  async rotate(runtimeAssetId: string, credentialId: string, overlapSeconds: number, actorId?: string) {
    if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 86400)
      throw new BadRequestException('Overlap must be an integer between 0 and 86400 seconds');
    return this.credentials.manager.transaction('SERIALIZABLE', async manager => {
      const repo = manager.getRepository(GatewayConsumerCredentialEntity);
      const previous = await repo.findOneBy({ id: credentialId, runtimeAssetId });
      if (!previous) throw new NotFoundException('Runtime credential not found');
      const now = Math.floor(Date.now() / 1000);
      if (!previous.accessPolicy) throw new ConflictException('Legacy credentials must be replaced before rotation');
      const policy = toRuntimeAccessCredential(previous);
      validateRuntimeAccessCredential(policy);
      if (previous.status !== GatewayConsumerCredentialStatus.ACTIVE || policy.expiresAt <= now || policy.rotationSuccessorId ||
          (policy.validUntil !== undefined && policy.validUntil <= now))
        throw new ConflictException('Credential is inactive, expired or already rotated');
      const secret = randomBytes(32).toString('base64url');
      const familyId = policy.rotationFamilyId || previous.id;
      const successorId = randomUUID();
      const nextPolicy: Record<string, unknown> = { ...previous.accessPolicy, rotationFamilyId: familyId, ...(actorId ? { actorId } : {}) };
      delete nextPolicy.rotationSuccessorId;
      delete nextPolicy.validUntil;
      const successor = repo.create({ id: successorId, name: previous.name, label: previous.label,
        keyId: `rk_${randomBytes(18).toString('hex')}`, secretHash: createHash('sha256').update(secret).digest('hex'),
        status: GatewayConsumerCredentialStatus.ACTIVE, runtimeAssetId, routeBindingId: previous.routeBindingId,
        accessPolicy: nextPolicy });
      previous.accessPolicy = { ...previous.accessPolicy, rotationFamilyId: familyId,
        rotationSuccessorId: successorId, validUntil: Math.min(policy.expiresAt, now + overlapSeconds) };
      await repo.save(previous);
      await repo.save(successor);
      await this.audit.log({ action: AuditAction.API_KEY_CREATED, level: AuditLevel.INFO, status: AuditStatus.SUCCESS,
        userId: actorId, resource: 'runtime_access_credential', resourceId: successor.id,
        details: { operation: 'rotate', runtimeAssetId, predecessorId: previous.id, rotationFamilyId: familyId,
          overlapEndsAt: previous.accessPolicy.validUntil } }, manager);
      return { credential: { id: successor.id, keyId: successor.keyId, status: successor.status,
        runtimeAssetId, accessPolicy: successor.accessPolicy }, apiKey: `${successor.keyId}.${secret}`,
        predecessorId: previous.id, overlapEndsAt: previous.accessPolicy.validUntil };
    });
  }
}
