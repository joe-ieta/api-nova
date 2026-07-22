import { BadRequestException, NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  SourceServiceInstanceStatus,
} from '../../../database/entities/source-service-instance.entity';
import { SourceServiceInstancesService } from './source-service-instances.service';

describe('SourceServiceInstancesService', () => {
  const transactionRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
  };
  const instanceRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };
  const sourceServiceRepository = {
    findOne: jest.fn(),
  };
  const httpService = {
    head: jest.fn(),
  };
  const service = new SourceServiceInstancesService(
    instanceRepository as any,
    sourceServiceRepository as any,
    httpService as any,
  );

  const instance = {
    id: 'instance-1',
    sourceServiceAssetId: 'source-1',
    name: 'orders-prod-1',
    environment: 'production',
    scheme: 'https',
    host: 'orders.internal',
    port: 443,
    basePath: '/api',
    enabled: true,
    status: SourceServiceInstanceStatus.DRAFT,
    priority: 100,
    weight: 100,
    isDefault: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sourceServiceRepository.findOne.mockResolvedValue({ id: 'source-1' });
    instanceRepository.create.mockImplementation((value: unknown) => value);
    instanceRepository.save.mockImplementation(async (value: unknown) => value);
    transactionRepository.save.mockImplementation(async (value: unknown) => value);
    transactionRepository.update.mockResolvedValue({ affected: 1 });
    instanceRepository.manager.transaction.mockImplementation(
      async (callback: (manager: { getRepository: () => unknown }) => Promise<unknown>) =>
        callback({ getRepository: () => transactionRepository }),
    );
  });

  it('creates a normalized instance only after validating its source service asset', async () => {
    instanceRepository.findOne.mockResolvedValue(null);

    const result = await service.create('source-1', {
      name: ' Orders Prod 1 ',
      environment: 'production',
      scheme: 'HTTPS',
      host: 'Orders.Internal',
      port: 443,
      basePath: 'api/',
    });

    expect(sourceServiceRepository.findOne).toHaveBeenCalledWith({ where: { id: 'source-1' } });
    expect(instanceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceServiceAssetId: 'source-1',
        name: 'Orders Prod 1',
        scheme: 'https',
        host: 'orders.internal',
        basePath: '/api',
        status: SourceServiceInstanceStatus.DRAFT,
      }),
    );
    expect(result).toEqual(expect.objectContaining({ sourceServiceAssetId: 'source-1' }));
  });

  it('validates environment-backed credentials before saving the instance reference', async () => {
    instanceRepository.findOne.mockResolvedValue(null);
    process.env.UPSTREAM_ORDER_TOKEN = 'Bearer runtime-secret';
    try {
      await service.create('source-1', {
        name: 'Orders Secured',
        environment: 'production',
        scheme: 'https',
        host: 'orders.internal',
        port: 443,
        credentialRef: 'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
      });
      expect(instanceRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        credentialRef: 'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
      }));
    } finally {
      delete process.env.UPSTREAM_ORDER_TOKEN;
    }

    await expect(service.create('source-1', {
      name: 'Orders Missing Secret',
      environment: 'production',
      scheme: 'https',
      host: 'orders.internal',
      port: 443,
      credentialRef: 'env-headers:Authorization=UPSTREAM_MISSING_TOKEN',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears an existing credential reference when update explicitly sends null', async () => {
    instanceRepository.findOne.mockResolvedValue({
      ...instance,
      credentialRef: 'env-headers:Authorization=UPSTREAM_ORDER_TOKEN',
    });

    const result = await service.update('source-1', instance.id, { credentialRef: null });

    expect(result.credentialRef).toBeUndefined();
    expect(instanceRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      credentialRef: undefined,
    }));
  });

  it('keeps imported instance creation idempotent for repeated registration', async () => {
    const imported = {
      ...instance,
      name: 'imported-default',
      environment: 'imported',
    };
    instanceRepository.findOne.mockResolvedValue(imported);
    const createSpy = jest.spyOn(service, 'create');

    const result = await service.ensureImportedInstance('source-1', {
      scheme: 'https',
      host: 'orders.internal',
      port: 443,
      basePath: '/api',
    });

    expect(result).toBe(imported);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects an instance id that belongs to a different source service asset', async () => {
    instanceRepository.findOne.mockResolvedValue(null);

    await expect(service.get('source-2', 'instance-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(instanceRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'instance-1', sourceServiceAssetId: 'source-2' },
    });
  });

  it('clears the existing environment default and sets the selected instance atomically', async () => {
    instanceRepository.findOne.mockResolvedValue({ ...instance });
    transactionRepository.findOne.mockResolvedValue({ ...instance });

    const result = await service.setDefault('source-1', 'instance-1');

    expect(transactionRepository.update).toHaveBeenCalledWith(
      {
        sourceServiceAssetId: 'source-1',
        environment: 'production',
        isDefault: true,
      },
      { isDefault: false },
    );
    expect(result.isDefault).toBe(true);
  });

  it('archives an instance by disabling and taking it offline', async () => {
    instanceRepository.findOne.mockResolvedValue({ ...instance, isDefault: true });

    const result = await service.archive('source-1', 'instance-1');

    expect(result).toEqual(
      expect.objectContaining({
        enabled: false,
        isDefault: false,
        status: SourceServiceInstanceStatus.OFFLINE,
        archivedAt: expect.any(Date),
      }),
    );
  });

  it('persists a healthy HTTP probe result without issuing a request body', async () => {
    instanceRepository.findOne.mockResolvedValue({ ...instance });
    httpService.head.mockReturnValue(of({ status: 404 }));

    const result = await service.probe('source-1', 'instance-1', { timeoutMs: 1000 });

    expect(httpService.head).toHaveBeenCalledWith(
      'https://orders.internal/api',
      expect.objectContaining({ timeout: 1000, maxRedirects: 0 }),
    );
    expect(result.probe.status).toBe(SourceServiceInstanceStatus.HEALTHY);
    expect(instanceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SourceServiceInstanceStatus.HEALTHY,
        lastProbeStatus: SourceServiceInstanceStatus.HEALTHY,
      }),
    );
  });

  it('persists probe transport failures as unhealthy evidence', async () => {
    instanceRepository.findOne.mockResolvedValue({ ...instance });
    httpService.head.mockReturnValue(throwError(() => new Error('connect refused')));

    const result = await service.probe('source-1', 'instance-1');

    expect(result.probe).toEqual(
      expect.objectContaining({
        status: SourceServiceInstanceStatus.UNHEALTHY,
        errorMessage: 'connect refused',
      }),
    );
  });

  it('blocks default selection for a disabled instance', async () => {
    instanceRepository.findOne.mockResolvedValue({ ...instance, enabled: false });

    await expect(service.setDefault('source-1', 'instance-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(instanceRepository.manager.transaction).not.toHaveBeenCalled();
  });
});
