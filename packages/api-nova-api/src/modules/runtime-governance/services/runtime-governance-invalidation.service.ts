import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeUpstreamBindingInstanceEntity } from '../../../database/entities/runtime-upstream-binding-instance.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';

export interface RuntimeGovernanceMutationContext {
  actorId?: string;
  reason?: string;
}

@Injectable()
export class RuntimeGovernanceInvalidationService {
  constructor(
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly membershipRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(RuntimeUpstreamBindingEntity)
    private readonly upstreamBindingRepository: Repository<RuntimeUpstreamBindingEntity>,
    @InjectRepository(RuntimeUpstreamBindingInstanceEntity)
    private readonly candidateRepository: Repository<RuntimeUpstreamBindingInstanceEntity>,
  ) {}

  async invalidateForMembership(
    runtimeMembershipId: string,
    reason: string,
    context: RuntimeGovernanceMutationContext = {},
  ) {
    const membership = await this.membershipRepository.findOne({
      where: { id: runtimeMembershipId },
    });
    if (!membership) return [];
    return this.invalidateAssets([membership.runtimeAssetId], reason, {
      ...context,
      runtimeMembershipId,
    });
  }

  async invalidateForSourceInstance(
    sourceServiceInstanceId: string,
    reason: string,
    context: RuntimeGovernanceMutationContext = {},
  ) {
    const candidates = await this.candidateRepository.find({
      where: { sourceServiceInstanceId },
    });
    const bindingIds = Array.from(
      new Set(candidates.map(candidate => candidate.runtimeUpstreamBindingId)),
    );
    if (bindingIds.length === 0) return [];
    const bindings = await this.upstreamBindingRepository.find({
      where: bindingIds.map(id => ({ id })),
    });
    const membershipIds = bindings.map(binding => binding.runtimeAssetEndpointBindingId);
    if (membershipIds.length === 0) return [];
    const memberships = await this.membershipRepository.find({
      where: membershipIds.map(id => ({ id })),
    });
    return this.invalidateAssets(
      memberships.map(membership => membership.runtimeAssetId),
      reason,
      { ...context, sourceServiceInstanceId },
    );
  }

  private async invalidateAssets(
    runtimeAssetIds: string[],
    reason: string,
    context: RuntimeGovernanceMutationContext & Record<string, unknown>,
  ) {
    const ids = Array.from(new Set(runtimeAssetIds.filter(Boolean)));
    if (ids.length === 0) return [];
    const assets = await this.runtimeAssetRepository.find({
      where: { id: In(ids) },
    });
    const invalidatedAt = new Date().toISOString();
    const results: RuntimeAssetEntity[] = [];
    for (const asset of assets) {
      asset.metadata = {
        ...(asset.metadata || {}),
        verificationRequired: true,
        verificationRequiredAt: invalidatedAt,
        verificationRequiredReason: reason,
        verificationRequiredContext: context,
      };
      results.push(await this.runtimeAssetRepository.save(asset));
    }
    return results;
  }
}
