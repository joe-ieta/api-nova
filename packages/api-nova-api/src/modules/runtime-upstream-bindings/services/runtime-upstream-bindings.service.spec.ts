import {
  RuntimeUpstreamBindingStatus,
  RuntimeUpstreamSelectionMode,
} from '../../../database/entities/runtime-upstream-binding.entity';
import { SourceServiceInstanceStatus } from '../../../database/entities/source-service-instance.entity';
import { RuntimeUpstreamBindingsService } from './runtime-upstream-bindings.service';

describe('RuntimeUpstreamBindingsService', () => {
  const bindingRepository = {
    findOne: jest.fn(),
  };
  const candidateRepository = {
    find: jest.fn(),
  };
  const sourceInstanceRepository = {
    find: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn(),
  };

  const service = new RuntimeUpstreamBindingsService(
    bindingRepository as any,
    candidateRepository as any,
    sourceInstanceRepository as any,
    dataSource as any,
  );

  const binding = {
    id: 'upstream-binding-1',
    runtimeAssetEndpointBindingId: 'membership-1',
    sourceServiceAssetId: 'source-1',
    environment: 'production',
    selectionMode: RuntimeUpstreamSelectionMode.HEALTHY_PRIORITY,
    primaryInstanceId: 'instance-primary',
    status: RuntimeUpstreamBindingStatus.ACTIVE,
    revision: 3,
  };

  const candidate = (
    sourceServiceInstanceId: string,
    priority: number,
    orderIndex: number,
    enabled = true,
  ) => ({
    id: `candidate-${sourceServiceInstanceId}`,
    runtimeUpstreamBindingId: binding.id,
    sourceServiceInstanceId,
    priority,
    orderIndex,
    weight: 1,
    enabled,
  });

  const instance = (
    id: string,
    status = SourceServiceInstanceStatus.HEALTHY,
    enabled = true,
  ) => ({
    id,
    sourceServiceAssetId: 'source-1',
    environment: 'production',
    enabled,
    status,
    scheme: 'https',
    host: `${id}.example.com`,
    port: 443,
    basePath: '/',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    bindingRepository.findOne.mockResolvedValue(binding);
  });

  it('does not silently fail over when the fixed primary is unhealthy', async () => {
    bindingRepository.findOne.mockResolvedValue({
      ...binding,
      selectionMode: RuntimeUpstreamSelectionMode.FIXED_PRIMARY,
    });
    candidateRepository.find.mockResolvedValue([
      candidate('instance-primary', 0, 0),
      candidate('instance-backup', 1, 0),
    ]);
    sourceInstanceRepository.find.mockResolvedValue([
      instance('instance-primary', SourceServiceInstanceStatus.UNHEALTHY),
      instance('instance-backup'),
    ]);

    const result = await service.resolve('membership-1');

    expect(result).toEqual(
      expect.objectContaining({
        resolved: false,
        reason: 'fixed_primary_unavailable',
        instance: null,
      }),
    );
  });

  it('selects the first enabled healthy candidate by priority and order', async () => {
    candidateRepository.find.mockResolvedValue([
      candidate('instance-disabled-relation', 0, 0, false),
      candidate('instance-unhealthy', 1, 0),
      candidate('instance-selected', 1, 1),
      candidate('instance-later', 2, 0),
    ]);
    sourceInstanceRepository.find.mockResolvedValue([
      instance('instance-disabled-relation'),
      instance('instance-unhealthy', SourceServiceInstanceStatus.UNHEALTHY),
      instance('instance-selected'),
      instance('instance-later'),
    ]);

    const result = await service.resolve('membership-1');

    expect(result).toEqual(
      expect.objectContaining({
        resolved: true,
        reason: 'resolved',
        instance: expect.objectContaining({ id: 'instance-selected' }),
      }),
    );
  });

  it('does not resolve a draft binding', async () => {
    bindingRepository.findOne.mockResolvedValue({
      ...binding,
      status: RuntimeUpstreamBindingStatus.DRAFT,
    });

    const result = await service.resolve('membership-1');

    expect(result.reason).toBe('binding_not_active');
    expect(candidateRepository.find).not.toHaveBeenCalled();
  });

  it('rejects a stale expected revision before replacing candidates', async () => {
    sourceInstanceRepository.find.mockResolvedValue([instance('instance-primary')]);
    const transactionBindingRepository = {
      findOne: jest.fn().mockResolvedValue(binding),
    };
    const transactionCandidateRepository = {
      delete: jest.fn(),
      save: jest.fn(),
    };
    dataSource.transaction.mockImplementation(async (callback: (manager: any) => unknown) =>
      callback({
        getRepository: (entity: { name: string }) =>
          entity.name === 'RuntimeUpstreamBindingEntity'
            ? transactionBindingRepository
            : transactionCandidateRepository,
      }),
    );

    await expect(
      service.upsert('membership-1', {
        sourceServiceAssetId: 'source-1',
        environment: 'production',
        selectionMode: RuntimeUpstreamSelectionMode.FIXED_PRIMARY,
        primaryInstanceId: 'instance-primary',
        expectedRevision: 2,
        candidates: [{ sourceServiceInstanceId: 'instance-primary' }],
      }),
    ).rejects.toThrow('revision changed from 2 to 3');
    expect(transactionCandidateRepository.delete).not.toHaveBeenCalled();
  });
});
