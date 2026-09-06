import { RuntimeGovernanceInvalidationService } from './runtime-governance-invalidation.service';

describe('RuntimeGovernanceInvalidationService', () => {
  const runtimeAssetRepository = {
    find: jest.fn(),
    save: jest.fn(),
  };
  const membershipRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const upstreamBindingRepository = { find: jest.fn() };
  const candidateRepository = { find: jest.fn() };
  const service = new RuntimeGovernanceInvalidationService(
    runtimeAssetRepository as any,
    membershipRepository as any,
    upstreamBindingRepository as any,
    candidateRepository as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeAssetRepository.find.mockResolvedValue([
      { id: 'runtime-1', metadata: { activeRevision: 'rev-1' } },
    ]);
    runtimeAssetRepository.save.mockImplementation(async value => value);
  });

  it('marks the runtime asset when its membership binding changes', async () => {
    membershipRepository.findOne.mockResolvedValue({
      id: 'membership-1',
      runtimeAssetId: 'runtime-1',
    });

    const result = await service.invalidateForMembership(
      'membership-1',
      'runtime_upstream_binding_changed',
    );

    expect(result[0].metadata).toEqual(expect.objectContaining({
      activeRevision: 'rev-1',
      verificationRequired: true,
      verificationRequiredReason: 'runtime_upstream_binding_changed',
      verificationRequiredContext: { runtimeMembershipId: 'membership-1' },
    }));
  });

  it('finds all published assets using a changed source instance', async () => {
    candidateRepository.find.mockResolvedValue([
      { runtimeUpstreamBindingId: 'binding-1', sourceServiceInstanceId: 'instance-1' },
    ]);
    upstreamBindingRepository.find.mockResolvedValue([
      { id: 'binding-1', runtimeAssetEndpointBindingId: 'membership-1' },
    ]);
    membershipRepository.find.mockResolvedValue([
      { id: 'membership-1', runtimeAssetId: 'runtime-1' },
    ]);

    await service.invalidateForSourceInstance('instance-1', 'source_service_instance_changed');

    expect(runtimeAssetRepository.find).toHaveBeenCalledWith({
      where: expect.anything(),
    });
    expect(runtimeAssetRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'runtime-1', metadata: expect.objectContaining({ verificationRequired: true }) }),
    );
  });
});
