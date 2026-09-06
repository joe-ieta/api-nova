import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { RuntimeUpstreamBindingInstanceEntity } from '../../../database/entities/runtime-upstream-binding-instance.entity';
import {
  RuntimeUpstreamBindingEntity,
  RuntimeUpstreamBindingStatus,
  RuntimeUpstreamSelectionMode,
} from '../../../database/entities/runtime-upstream-binding.entity';
import {
  SourceServiceInstanceEntity,
  SourceServiceInstanceStatus,
} from '../../../database/entities/source-service-instance.entity';
import { UpsertRuntimeUpstreamBindingDto } from '../dto/runtime-upstream-bindings.dto';
import { AuditAction, AuditLevel, AuditStatus } from '../../../database/entities/audit-log.entity';
import { AuditService } from '../../security/services/audit.service';
import { RuntimeGovernanceInvalidationService } from '../../runtime-governance/services/runtime-governance-invalidation.service';

export type RuntimeUpstreamResolutionReason =
  | 'resolved'
  | 'binding_not_active'
  | 'fixed_primary_unavailable'
  | 'no_healthy_candidate';

export interface RuntimeUpstreamMutationContext {
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class RuntimeUpstreamBindingsService {
  constructor(
    @InjectRepository(RuntimeUpstreamBindingEntity)
    private readonly bindingRepository: Repository<RuntimeUpstreamBindingEntity>,
    @InjectRepository(RuntimeUpstreamBindingInstanceEntity)
    private readonly candidateRepository: Repository<RuntimeUpstreamBindingInstanceEntity>,
    @InjectRepository(SourceServiceInstanceEntity)
    private readonly sourceInstanceRepository: Repository<SourceServiceInstanceEntity>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly governanceInvalidationService: RuntimeGovernanceInvalidationService,
  ) {}

  async getByMembership(runtimeMembershipId: string) {
    const binding = await this.requireBinding(runtimeMembershipId);
    const candidates = await this.candidateRepository.find({
      where: { runtimeUpstreamBindingId: binding.id },
      order: { priority: 'ASC', orderIndex: 'ASC', id: 'ASC' },
    });
    return { binding, candidates };
  }

  async upsert(
    runtimeMembershipId: string,
    dto: UpsertRuntimeUpstreamBindingDto,
    context: RuntimeUpstreamMutationContext = {},
  ) {
    const environment = dto.environment.trim().toLowerCase();
    if (!environment) {
      throw new BadRequestException('environment must not be blank');
    }

    const candidateIds = dto.candidates.map((item) => item.sourceServiceInstanceId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new BadRequestException('Candidate source service instances must be unique');
    }
    if (
      dto.selectionMode === RuntimeUpstreamSelectionMode.FIXED_PRIMARY &&
      !dto.primaryInstanceId
    ) {
      throw new BadRequestException('fixed_primary requires primaryInstanceId');
    }
    if (dto.primaryInstanceId && !candidateIds.includes(dto.primaryInstanceId)) {
      throw new BadRequestException('primaryInstanceId must be present in candidates');
    }

    const sourceInstances = await this.sourceInstanceRepository.find({
      where: { id: In(candidateIds) },
    });
    if (sourceInstances.length !== candidateIds.length) {
      const foundIds = new Set(sourceInstances.map((item) => item.id));
      const missing = candidateIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(`Source service instances not found: ${missing.join(', ')}`);
    }
    const invalid = sourceInstances.find(
      (item) =>
        item.sourceServiceAssetId !== dto.sourceServiceAssetId ||
        item.environment.trim().toLowerCase() !== environment,
    );
    if (invalid) {
      throw new BadRequestException(
        `Source service instance '${invalid.id}' does not belong to the selected asset and environment`,
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const bindingRepository = manager.getRepository(RuntimeUpstreamBindingEntity);
      const candidateRepository = manager.getRepository(RuntimeUpstreamBindingInstanceEntity);
      const existing = await bindingRepository.findOne({
        where: { runtimeAssetEndpointBindingId: runtimeMembershipId },
      });
      if (
        existing &&
        dto.expectedRevision !== undefined &&
        existing.revision !== dto.expectedRevision
      ) {
        throw new ConflictException(
          `Runtime upstream binding revision changed from ${dto.expectedRevision} to ${existing.revision}`,
        );
      }

      const binding = bindingRepository.create({
        ...(existing ?? {}),
        runtimeAssetEndpointBindingId: runtimeMembershipId,
        sourceServiceAssetId: dto.sourceServiceAssetId,
        environment,
        selectionMode: dto.selectionMode,
        primaryInstanceId: dto.primaryInstanceId,
        status: dto.status ?? existing?.status ?? RuntimeUpstreamBindingStatus.DRAFT,
        revision: existing ? existing.revision + 1 : 1,
      });
      const savedBinding = await bindingRepository.save(binding);
      await candidateRepository.delete({ runtimeUpstreamBindingId: savedBinding.id });
      const candidates = await candidateRepository.save(
        dto.candidates.map((item, index) =>
          candidateRepository.create({
            runtimeUpstreamBindingId: savedBinding.id,
            sourceServiceInstanceId: item.sourceServiceInstanceId,
            priority: item.priority ?? 0,
            orderIndex: item.order ?? index,
            weight: item.weight ?? 1,
            enabled: item.enabled ?? true,
          }),
        ),
      );
      return { binding: savedBinding, candidates };
    });
    await this.governanceInvalidationService.invalidateForMembership(
      runtimeMembershipId,
      'runtime_upstream_binding_changed',
      context,
    );
    await this.safeAudit({
      action: AuditAction.API_CONFIGURED,
      level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS,
      resource: 'runtime_upstream_binding',
      resourceId: runtimeMembershipId,
      userId: context.actorId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      details: {
        operation: 'upsert',
        reason: 'runtime_upstream_binding_changed',
        revision: result.binding.revision,
        after: result.binding,
        candidateCount: result.candidates.length,
      },
    });
    return result;
  }

  async resolve(runtimeMembershipId: string) {
    const binding = await this.requireBinding(runtimeMembershipId);
    if (binding.status !== RuntimeUpstreamBindingStatus.ACTIVE) {
      return this.unresolved(binding, 'binding_not_active');
    }

    const candidates = await this.candidateRepository.find({
      where: { runtimeUpstreamBindingId: binding.id, enabled: true },
      order: { priority: 'ASC', orderIndex: 'ASC', id: 'ASC' },
    });
    const instanceIds = candidates.map((item) => item.sourceServiceInstanceId);
    const instances = instanceIds.length
      ? await this.sourceInstanceRepository.find({ where: { id: In(instanceIds) } })
      : [];
    const instanceById = new Map(instances.map((item) => [item.id, item]));
    const healthyCandidates = candidates.filter((candidate) => {
      const instance = instanceById.get(candidate.sourceServiceInstanceId);
      return (
        candidate.enabled === true &&
        instance?.enabled === true &&
        instance.status === SourceServiceInstanceStatus.HEALTHY &&
        instance.sourceServiceAssetId === binding.sourceServiceAssetId &&
        instance.environment.trim().toLowerCase() === binding.environment.trim().toLowerCase()
      );
    });

    if (binding.selectionMode === RuntimeUpstreamSelectionMode.FIXED_PRIMARY) {
      const primary = healthyCandidates.find(
        (candidate) => candidate.sourceServiceInstanceId === binding.primaryInstanceId,
      );
      return primary
        ? this.resolved(binding, primary, instanceById.get(primary.sourceServiceInstanceId)!)
        : this.unresolved(binding, 'fixed_primary_unavailable');
    }

    const selected = healthyCandidates[0];
    return selected
      ? this.resolved(binding, selected, instanceById.get(selected.sourceServiceInstanceId)!)
      : this.unresolved(binding, 'no_healthy_candidate');
  }

  buildBaseUrl(instance: SourceServiceInstanceEntity) {
    const host = instance.host.includes(':') && !instance.host.startsWith('[')
      ? `[${instance.host}]`
      : instance.host;
    const defaultPort =
      (instance.scheme === 'http' && instance.port === 80) ||
      (instance.scheme === 'https' && instance.port === 443);
    const authority = `${instance.scheme}://${host}${defaultPort ? '' : `:${instance.port}`}`;
    return instance.basePath === '/' ? authority : `${authority}${instance.basePath}`;
  }

  async remove(
    runtimeMembershipId: string,
    context: RuntimeUpstreamMutationContext = {},
  ) {
    const binding = await this.requireBinding(runtimeMembershipId);
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(RuntimeUpstreamBindingInstanceEntity).delete({
        runtimeUpstreamBindingId: binding.id,
      });
      await manager.getRepository(RuntimeUpstreamBindingEntity).delete(binding.id);
    });
    await this.governanceInvalidationService.invalidateForMembership(
      runtimeMembershipId,
      'runtime_upstream_binding_removed',
      context,
    );
    await this.safeAudit({
      action: AuditAction.API_CONFIGURED,
      level: AuditLevel.WARNING,
      status: AuditStatus.SUCCESS,
      resource: 'runtime_upstream_binding',
      resourceId: runtimeMembershipId,
      userId: context.actorId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      details: {
        operation: 'remove',
        reason: 'runtime_upstream_binding_removed',
        revision: binding.revision,
        before: binding,
      },
    });
  }

  private async safeAudit(data: Parameters<AuditService['log']>[0]) {
    try {
      await this.auditService.log(data);
    } catch {
      // Audit persistence must not turn a completed configuration change into a failed request.
    }
  }

  private async requireBinding(runtimeMembershipId: string) {
    const binding = await this.bindingRepository.findOne({
      where: { runtimeAssetEndpointBindingId: runtimeMembershipId },
    });
    if (!binding) {
      throw new NotFoundException(
        `Runtime upstream binding for membership '${runtimeMembershipId}' was not found`,
      );
    }
    return binding;
  }

  private resolved(
    binding: RuntimeUpstreamBindingEntity,
    candidate: RuntimeUpstreamBindingInstanceEntity,
    instance: SourceServiceInstanceEntity,
  ) {
    return {
      resolved: true as const,
      reason: 'resolved' as RuntimeUpstreamResolutionReason,
      bindingId: binding.id,
      revision: binding.revision,
      selectionMode: binding.selectionMode,
      candidate,
      instance,
    };
  }

  private unresolved(
    binding: RuntimeUpstreamBindingEntity,
    reason: Exclude<RuntimeUpstreamResolutionReason, 'resolved'>,
  ) {
    return {
      resolved: false as const,
      reason,
      bindingId: binding.id,
      revision: binding.revision,
      selectionMode: binding.selectionMode,
      candidate: null,
      instance: null,
    };
  }
}
