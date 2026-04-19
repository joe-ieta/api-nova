import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../../database/entities/endpoint-definition.entity';
import {
  PublicationAuditAction,
  PublicationAuditStatus,
} from '../../../database/entities/publication-audit-event.entity';
import { RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { PublicationService } from './publication.service';

describe('PublicationService', () => {
  const endpointDefinitionRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const runtimeAssetRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const runtimeBindingRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const sourceServiceRepository = {
    findByIds: jest.fn(),
    findOne: jest.fn(),
  };
  const profileRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const historyRepository = {
    save: jest.fn(),
    create: jest.fn(),
  };
  const batchRunRepository = {
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const auditEventRepository = {
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const bindingRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const routeBindingRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const service = new PublicationService(
    endpointDefinitionRepository as any,
    runtimeAssetRepository as any,
    runtimeBindingRepository as any,
    sourceServiceRepository as any,
    profileRepository as any,
    historyRepository as any,
    batchRunRepository as any,
    auditEventRepository as any,
    bindingRepository as any,
    routeBindingRepository as any,
  );

  const sourceServiceAsset = {
    id: 'source-1',
    sourceKey: 'https://api.example.com:443/v1',
    displayName: 'Orders API',
  };
  const readyEndpoint: EndpointDefinitionEntity = {
    id: 'endpoint-1',
    sourceServiceAssetId: 'source-1',
    method: 'GET',
    path: '/orders',
    summary: 'List orders',
    status: EndpointDefinitionStatus.VERIFIED,
    publishEnabled: true,
    metadata: {
      lastProbeStatus: 'healthy',
      testStatus: 'passed',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as EndpointDefinitionEntity;

  beforeEach(() => {
    jest.clearAllMocks();
    endpointDefinitionRepository.find.mockResolvedValue([]);
    endpointDefinitionRepository.findOne.mockResolvedValue(readyEndpoint);
    runtimeAssetRepository.find.mockResolvedValue([]);
    runtimeAssetRepository.findOne.mockResolvedValue({
      id: 'runtime-1',
      type: RuntimeAssetType.MCP_SERVER,
      name: 'orders-runtime',
      displayName: 'Orders Runtime',
      status: RuntimeAssetStatus.DRAFT,
    });
    runtimeAssetRepository.save.mockImplementation(async (value: unknown) => value);
    runtimeBindingRepository.find.mockResolvedValue([]);
    runtimeBindingRepository.findOne.mockResolvedValue(null);
    runtimeBindingRepository.create.mockImplementation((value: Record<string, unknown>) => ({
      id: 'membership-1',
      ...value,
    }));
    runtimeBindingRepository.save.mockImplementation(async (value: unknown) => value);
    sourceServiceRepository.findByIds.mockResolvedValue([sourceServiceAsset]);
    sourceServiceRepository.findOne.mockResolvedValue(sourceServiceAsset);
    auditEventRepository.create.mockImplementation((value: unknown) => value);
    auditEventRepository.save.mockImplementation(async (value: unknown) => value);
  });

  it('filters blocked publication candidates unless explicitly requested', async () => {
    endpointDefinitionRepository.find.mockResolvedValue([
      readyEndpoint,
      {
        ...readyEndpoint,
        id: 'endpoint-2',
        metadata: {
          lastProbeStatus: 'unhealthy',
          testStatus: 'failed',
        },
      },
    ]);

    const result = await service.listPublicationCandidates();

    expect(result.total).toBe(1);
    expect(result.data[0].endpointDefinition.id).toBe('endpoint-1');
    expect(result.data[0].readiness.ready).toBe(true);
  });

  it('rejects adding non-ready endpoints into a publication runtime asset', async () => {
    endpointDefinitionRepository.findOne.mockResolvedValue({
      ...readyEndpoint,
      metadata: {
        lastProbeStatus: 'unhealthy',
        testStatus: 'failed',
      },
    });

    await expect(
      service.addPublicationRuntimeMemberships(
        'runtime-1',
        { endpointDefinitionIds: ['endpoint-1'] },
        'operator-1',
      ),
    ).rejects.toThrow(
      "Endpoint definition 'endpoint-1' is not ready for publication",
    );
  });

  it('creates memberships for ready endpoints and records audit history', async () => {
    const result = await service.addPublicationRuntimeMemberships(
      'runtime-1',
      { endpointDefinitionIds: ['endpoint-1'] },
      'operator-1',
    );

    expect(result.createdCount).toBe(1);
    expect(runtimeBindingRepository.save).toHaveBeenCalled();
    expect(auditEventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PublicationAuditAction.MEMBERSHIPS_ADDED,
        status: PublicationAuditStatus.SUCCESS,
        runtimeAssetId: 'runtime-1',
        operatorId: 'operator-1',
      }),
    );
  });
});
