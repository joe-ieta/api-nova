import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { resolveRuntimeCredentialRefHeaders } from 'api-nova-parser';
import { IsNull, Not, Repository } from 'typeorm';
import {
  SourceServiceInstanceEntity,
  SourceServiceInstanceStatus,
} from '../../../database/entities/source-service-instance.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import {
  CreateSourceServiceInstanceDto,
  ProbeSourceServiceInstanceDto,
  SourceServiceInstanceQueryDto,
  UpdateSourceServiceInstanceDto,
} from '../dto/source-service-instances.dto';

@Injectable()
export class SourceServiceInstancesService {
  constructor(
    @InjectRepository(SourceServiceInstanceEntity)
    private readonly instanceRepository: Repository<SourceServiceInstanceEntity>,
    @InjectRepository(SourceServiceAssetEntity)
    private readonly sourceServiceRepository: Repository<SourceServiceAssetEntity>,
    private readonly httpService: HttpService,
  ) {}

  async list(sourceServiceAssetId: string, query: SourceServiceInstanceQueryDto = {}) {
    await this.requireSourceServiceAsset(sourceServiceAssetId);
    const where: Record<string, unknown> = { sourceServiceAssetId };
    if (query.environment) where.environment = this.normalizeEnvironment(query.environment);
    if (query.status) where.status = query.status;
    if (query.enabled !== undefined) where.enabled = query.enabled;
    if (!query.includeArchived) where.archivedAt = IsNull();

    const instances = await this.instanceRepository.find({
      where,
      order: { environment: 'ASC', isDefault: 'DESC', priority: 'ASC', name: 'ASC' },
    });
    return { total: instances.length, data: instances };
  }

  async get(sourceServiceAssetId: string, instanceId: string) {
    return this.requireInstance(sourceServiceAssetId, instanceId);
  }

  async create(sourceServiceAssetId: string, input: CreateSourceServiceInstanceDto) {
    await this.requireSourceServiceAsset(sourceServiceAssetId);
    const normalized = this.normalizeInput(input);
    await this.ensureUniqueIdentity(
      sourceServiceAssetId,
      normalized.environment,
      normalized.name,
    );

    const instance = this.instanceRepository.create({
      ...normalized,
      sourceServiceAssetId,
      status: SourceServiceInstanceStatus.DRAFT,
      isDefault: false,
      archivedAt: undefined,
    });
    const saved = await this.instanceRepository.save(instance);
    return input.isDefault ? this.setDefault(sourceServiceAssetId, saved.id) : saved;
  }

  async ensureImportedInstance(
    sourceServiceAssetId: string,
    input: Pick<
      CreateSourceServiceInstanceDto,
      'scheme' | 'host' | 'port' | 'basePath'
    > & { provenance?: Record<string, unknown> },
  ) {
    await this.requireSourceServiceAsset(sourceServiceAssetId);
    const existing = await this.instanceRepository.findOne({
      where: {
        sourceServiceAssetId,
        environment: 'imported',
        name: 'imported-default',
      },
    });
    if (existing) {
      return existing;
    }

    return this.create(sourceServiceAssetId, {
      name: 'imported-default',
      environment: 'imported',
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      basePath: input.basePath,
      enabled: true,
      isDefault: true,
      priority: 100,
      metadata: {
        source: 'registration-import',
        ...(input.provenance || {}),
      },
    });
  }

  async update(
    sourceServiceAssetId: string,
    instanceId: string,
    input: UpdateSourceServiceInstanceDto,
  ) {
    const instance = await this.requireInstance(sourceServiceAssetId, instanceId);
    this.ensureNotArchived(instance);
    const normalized = this.normalizeInput(input, instance);
    if (normalized.environment !== instance.environment || normalized.name !== instance.name) {
      await this.ensureUniqueIdentity(
        sourceServiceAssetId,
        normalized.environment,
        normalized.name,
        instanceId,
      );
    }

    const shouldBeDefault = input.isDefault ?? instance.isDefault;
    Object.assign(instance, normalized, { isDefault: false });
    const saved = await this.instanceRepository.save(instance);
    return shouldBeDefault ? this.setDefault(sourceServiceAssetId, saved.id) : saved;
  }

  async archive(sourceServiceAssetId: string, instanceId: string) {
    const instance = await this.requireInstance(sourceServiceAssetId, instanceId);
    if (instance.archivedAt) return instance;
    instance.enabled = false;
    instance.isDefault = false;
    instance.status = SourceServiceInstanceStatus.OFFLINE;
    instance.archivedAt = new Date();
    return this.instanceRepository.save(instance);
  }

  async setDefault(sourceServiceAssetId: string, instanceId: string) {
    const instance = await this.requireInstance(sourceServiceAssetId, instanceId);
    this.ensureNotArchived(instance);
    if (!instance.enabled) {
      throw new BadRequestException('A disabled source service instance cannot be the default');
    }

    return this.instanceRepository.manager.transaction(async manager => {
      const repository = manager.getRepository(SourceServiceInstanceEntity);
      const current = await repository.findOne({
        where: { id: instanceId, sourceServiceAssetId },
      });
      if (!current) {
        throw new NotFoundException(
          `Source service instance '${instanceId}' not found for source service '${sourceServiceAssetId}'`,
        );
      }
      this.ensureNotArchived(current);
      if (!current.enabled) {
        throw new BadRequestException('A disabled source service instance cannot be the default');
      }
      await repository.update(
        {
          sourceServiceAssetId,
          environment: current.environment,
          isDefault: true,
        },
        { isDefault: false },
      );
      current.isDefault = true;
      return repository.save(current);
    });
  }

  async probe(
    sourceServiceAssetId: string,
    instanceId: string,
    input: ProbeSourceServiceInstanceDto = {},
  ) {
    const instance = await this.requireInstance(sourceServiceAssetId, instanceId);
    this.ensureNotArchived(instance);
    if (!instance.enabled) {
      throw new BadRequestException('A disabled source service instance cannot be probed');
    }

    const url = this.buildBaseUrl(instance);
    const startedAt = Date.now();
    const probedAt = new Date();
    try {
      const response = await firstValueFrom(
        this.httpService.head(url, {
          timeout: input.timeoutMs ?? 8000,
          maxRedirects: 0,
          validateStatus: () => true,
        }),
      );
      const healthy = response.status >= 200 && response.status < 500;
      instance.status = healthy
        ? SourceServiceInstanceStatus.HEALTHY
        : SourceServiceInstanceStatus.UNHEALTHY;
      instance.lastProbeStatus = instance.status;
      instance.lastProbeAt = probedAt;
      instance.lastProbeLatencyMs = Date.now() - startedAt;
      instance.lastError = healthy ? undefined : `HTTP ${response.status}`;
      const saved = await this.instanceRepository.save(instance);
      return {
        instance: saved,
        probe: {
          status: instance.status,
          httpStatus: response.status,
          latencyMs: instance.lastProbeLatencyMs,
          url,
          probedAt,
          errorMessage: instance.lastError,
        },
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      const errorMessage =
        axiosError.response?.status != null
          ? `HTTP ${axiosError.response.status}`
          : axiosError.message || 'Probe request failed';
      instance.status = SourceServiceInstanceStatus.UNHEALTHY;
      instance.lastProbeStatus = SourceServiceInstanceStatus.UNHEALTHY;
      instance.lastProbeAt = probedAt;
      instance.lastProbeLatencyMs = Date.now() - startedAt;
      instance.lastError = errorMessage;
      const saved = await this.instanceRepository.save(instance);
      return {
        instance: saved,
        probe: {
          status: SourceServiceInstanceStatus.UNHEALTHY,
          httpStatus: axiosError.response?.status,
          latencyMs: instance.lastProbeLatencyMs,
          url,
          probedAt,
          errorMessage,
        },
      };
    }
  }

  buildBaseUrl(instance: Pick<SourceServiceInstanceEntity, 'scheme' | 'host' | 'port' | 'basePath'>) {
    const host = instance.host.includes(':') && !instance.host.startsWith('[')
      ? `[${instance.host}]`
      : instance.host;
    const isDefaultPort =
      (instance.scheme === 'http' && instance.port === 80) ||
      (instance.scheme === 'https' && instance.port === 443);
    const authority = `${instance.scheme}://${host}${isDefaultPort ? '' : `:${instance.port}`}`;
    return instance.basePath === '/' ? authority : `${authority}${instance.basePath}`;
  }

  async resolveForExecution(
    sourceServiceAssetId: string,
    options: { instanceId?: string; environment?: string } = {},
  ) {
    await this.requireSourceServiceAsset(sourceServiceAssetId);
    if (options.instanceId) {
      const instance = await this.requireInstance(sourceServiceAssetId, options.instanceId);
      this.ensureNotArchived(instance);
      if (!instance.enabled) {
        throw new BadRequestException('The selected source service instance is disabled');
      }
      return instance;
    }

    const where: Record<string, unknown> = {
      sourceServiceAssetId,
      enabled: true,
      archivedAt: IsNull(),
    };
    if (options.environment) {
      where.environment = this.normalizeEnvironment(options.environment);
    }
    const instance = await this.instanceRepository.findOne({
      where,
      order: { isDefault: 'DESC', priority: 'ASC', name: 'ASC' },
    });
    if (!instance) {
      throw new BadRequestException(
        `No enabled runtime instance is configured for source service '${sourceServiceAssetId}'`,
      );
    }
    return instance;
  }

  private async requireSourceServiceAsset(sourceServiceAssetId: string) {
    const sourceServiceAsset = await this.sourceServiceRepository.findOne({
      where: { id: sourceServiceAssetId },
    });
    if (!sourceServiceAsset) {
      throw new NotFoundException(`Source service asset '${sourceServiceAssetId}' not found`);
    }
    return sourceServiceAsset;
  }

  private async requireInstance(sourceServiceAssetId: string, instanceId: string) {
    const instance = await this.instanceRepository.findOne({
      where: { id: instanceId, sourceServiceAssetId },
    });
    if (!instance) {
      throw new NotFoundException(
        `Source service instance '${instanceId}' not found for source service '${sourceServiceAssetId}'`,
      );
    }
    return instance;
  }

  private async ensureUniqueIdentity(
    sourceServiceAssetId: string,
    environment: string,
    name: string,
    exceptId?: string,
  ) {
    const existing = await this.instanceRepository.findOne({
      where: {
        sourceServiceAssetId,
        environment,
        name,
        ...(exceptId ? { id: Not(exceptId) } : {}),
      },
    });
    if (existing) {
      throw new ConflictException(
        `Source service instance '${name}' already exists in environment '${environment}'`,
      );
    }
  }

  private ensureNotArchived(instance: SourceServiceInstanceEntity) {
    if (instance.archivedAt) {
      throw new BadRequestException(`Source service instance '${instance.id}' is archived`);
    }
  }

  private normalizeInput(
    input: CreateSourceServiceInstanceDto | UpdateSourceServiceInstanceDto,
    current?: SourceServiceInstanceEntity,
  ) {
    const scheme = String(input.scheme ?? current?.scheme ?? '').trim().toLowerCase();
    if (!['http', 'https'].includes(scheme)) {
      throw new BadRequestException('Source service instance scheme must be http or https');
    }
    const host = String(input.host ?? current?.host ?? '').trim().toLowerCase();
    if (!host || /[\s\/?#@]/.test(host)) {
      throw new BadRequestException('Source service instance host is invalid');
    }
    const port = Number(input.port ?? current?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException('Source service instance port must be between 1 and 65535');
    }

    const credentialRef = input.credentialRef === null
      ? undefined
      : input.credentialRef ?? current?.credentialRef;
    if (credentialRef) {
      try {
        resolveRuntimeCredentialRefHeaders(credentialRef);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Source service credentialRef is invalid',
        );
      }
    }

    return {
      name: String(input.name ?? current?.name ?? '').trim(),
      environment: this.normalizeEnvironment(input.environment ?? current?.environment ?? ''),
      scheme,
      host: host.replace(/^\[|\]$/g, ''),
      port,
      basePath: this.normalizeBasePath(input.basePath ?? current?.basePath),
      enabled: input.enabled ?? current?.enabled ?? true,
      priority: input.priority ?? current?.priority ?? 100,
      weight: input.weight ?? current?.weight ?? 100,
      credentialRef,
      tlsPolicyRef: input.tlsPolicyRef ?? current?.tlsPolicyRef,
      metadata: input.metadata ?? current?.metadata,
    };
  }

  private normalizeEnvironment(value: string) {
    const environment = String(value || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,99}$/.test(environment)) {
      throw new BadRequestException('Source service instance environment is invalid');
    }
    return environment;
  }

  private normalizeBasePath(value?: string) {
    const raw = String(value || '/').trim() || '/';
    if (raw.includes('?') || raw.includes('#')) {
      throw new BadRequestException('Source service instance basePath cannot contain query or fragment');
    }
    const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
    return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : '/';
  }
}
