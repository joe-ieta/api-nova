import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { EntityManager, In, Repository } from 'typeorm';
import { EndpointTestSampleEntity, EndpointTestSampleStatus } from '../../../database/entities/endpoint-test-sample.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import {
  RuntimeVerificationActivationStatus,
  RuntimeVerificationRunEntity,
  RuntimeVerificationRunStatus,
  RuntimeVerificationTrigger,
} from '../../../database/entities/runtime-verification-run.entity';
import {
  RuntimeVerificationCaseKind,
  RuntimeVerificationResultEntity,
  RuntimeVerificationResultStatus,
} from '../../../database/entities/runtime-verification-result.entity';
import { RuntimeUpstreamBindingStatus } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeUpstreamBindingsService } from '../../runtime-upstream-bindings/services/runtime-upstream-bindings.service';
import { GatewayRouteSnapshotService } from '../../gateway-runtime/services/gateway-route-snapshot.service';
import { GatewayCandidateReplayService } from './gateway-candidate-replay.service';
import { McpCandidateReplayService } from './mcp-candidate-replay.service';
import { RuntimeResponseAssertionService } from './runtime-response-assertion.service';
import { PlanRuntimeVerificationDto } from '../dto/runtime-verification.dto';

type VerificationBlocker = {
  code: string;
  runtimeMembershipId?: string;
  message: string;
};

@Injectable()
export class RuntimeVerificationService {
  constructor(
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly membershipRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(EndpointTestSampleEntity)
    private readonly sampleRepository: Repository<EndpointTestSampleEntity>,
    @InjectRepository(RuntimeVerificationRunEntity)
    private readonly runRepository: Repository<RuntimeVerificationRunEntity>,
    @InjectRepository(RuntimeVerificationResultEntity)
    private readonly resultRepository: Repository<RuntimeVerificationResultEntity>,
    private readonly upstreamBindingsService: RuntimeUpstreamBindingsService,
    private readonly gatewayRouteSnapshotService: GatewayRouteSnapshotService,
    private readonly gatewayCandidateReplayService: GatewayCandidateReplayService,
    private readonly mcpCandidateReplayService: McpCandidateReplayService,
    private readonly responseAssertionService: RuntimeResponseAssertionService,
  ) {}

  async planCandidate(
    runtimeAssetId: string,
    dto: PlanRuntimeVerificationDto = {},
    candidateContext: { behaviorFingerprint?: string; waiverActorId?: string } = {},
  ) {
    const runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { id: runtimeAssetId },
    });
    if (!runtimeAsset) {
      throw new NotFoundException(`Runtime asset '${runtimeAssetId}' not found`);
    }

    const memberships = await this.membershipRepository.find({
      where: { runtimeAssetId, enabled: true },
      order: { id: 'ASC' },
    });
    const endpointIds = memberships.map((item) => item.endpointDefinitionId);
    const samples = endpointIds.length
      ? await this.sampleRepository.find({
          where: {
            endpointDefinitionId: In(endpointIds),
            enabled: true,
            status: EndpointTestSampleStatus.ACTIVE,
          },
          order: { capturedAt: 'ASC', id: 'ASC' },
        })
      : [];
    const samplesByEndpoint = new Map<string, EndpointTestSampleEntity[]>();
    for (const sample of samples) {
      const list = samplesByEndpoint.get(sample.endpointDefinitionId) || [];
      list.push(sample);
      samplesByEndpoint.set(sample.endpointDefinitionId, list);
    }

    const blockers: VerificationBlocker[] = [];
    const bindingEnvironmentByMembership = new Map<string, string>();
    const waiverReason = String(dto.missingSmokeWaiverReason || '').trim();
    const waivers: Array<{
      runtimeMembershipId: string;
      environment: string;
      reason: string;
      actorId?: string;
    }> = [];
    const bindingRevisions: Array<{
      runtimeMembershipId: string;
      bindingId: string;
      revision: number;
      resolvedSourceServiceInstanceId?: string;
      credentialRefFingerprint?: string;
    }> = [];
    const resultPlans: Array<Partial<RuntimeVerificationResultEntity>> = [];

    if (memberships.length === 0) {
      blockers.push({
        code: 'no_enabled_membership',
        message: 'Runtime asset has no enabled publication membership',
      });
    }

    for (const membership of memberships) {
      try {
        const { binding } = await this.upstreamBindingsService.getByMembership(membership.id);
        bindingEnvironmentByMembership.set(membership.id, binding.environment);
        const bindingRevision: {
          runtimeMembershipId: string;
          bindingId: string;
          revision: number;
          resolvedSourceServiceInstanceId?: string;
          credentialRefFingerprint?: string;
        } = {
          runtimeMembershipId: membership.id,
          bindingId: binding.id,
          revision: binding.revision,
        };
        bindingRevisions.push(bindingRevision);
        if (binding.status !== RuntimeUpstreamBindingStatus.ACTIVE) {
          this.addBlockedPrecondition(
            resultPlans,
            blockers,
            membership,
            'upstream_binding_not_active',
            `Runtime upstream binding is '${binding.status}', expected 'active'`,
          );
        } else {
          const resolution = await this.upstreamBindingsService.resolve(membership.id);
          if (resolution.resolved && resolution.instance) {
            bindingRevision.resolvedSourceServiceInstanceId = resolution.instance.id;
            if (resolution.instance.credentialRef) {
              bindingRevision.credentialRefFingerprint = createHash('sha256')
                .update(resolution.instance.credentialRef)
                .digest('hex');
            }
          } else {
            this.addBlockedPrecondition(
              resultPlans,
              blockers,
              membership,
              `upstream_${resolution.reason}`,
              `Runtime upstream cannot be resolved: ${resolution.reason}`,
            );
          }
        }
      } catch (error) {
        this.addBlockedPrecondition(
          resultPlans,
          blockers,
          membership,
          'upstream_binding_missing',
          error instanceof Error ? error.message : 'Runtime upstream binding is missing',
        );
      }

      const endpointSamples = samplesByEndpoint.get(membership.endpointDefinitionId) || [];
      const smokeSamples = endpointSamples.filter((sample) => this.hasTag(sample, 'smoke'));
      if (smokeSamples.length === 0) {
        if (waiverReason) {
          const waiver = {
            runtimeMembershipId: membership.id,
            environment: bindingEnvironmentByMembership.get(membership.id) || '',
            reason: waiverReason,
            actorId: candidateContext.waiverActorId,
          };
          waivers.push(waiver);
          resultPlans.push({
            runtimeMembershipId: membership.id,
            endpointDefinitionId: membership.endpointDefinitionId,
            kind: RuntimeVerificationCaseKind.WAIVER,
            status: RuntimeVerificationResultStatus.PASSED,
            evidence: { waiver },
          });
        } else {
          this.addBlockedPrecondition(
            resultPlans,
            blockers,
            membership,
            'smoke_sample_missing',
            'No enabled active sample tagged smoke is available for this membership',
          );
        }
      } else {
        for (const sample of smokeSamples) {
          resultPlans.push(this.sampleResultPlan(membership, sample, RuntimeVerificationCaseKind.SMOKE));
        }
      }

      if (dto.includeRegression !== false) {
        for (const sample of endpointSamples.filter((item) => this.hasTag(item, 'regression') && !this.hasTag(item, 'smoke'))) {
          resultPlans.push(
            this.sampleResultPlan(membership, sample, RuntimeVerificationCaseKind.REGRESSION),
          );
        }
      }
    }

    bindingRevisions.sort((left, right) =>
      left.runtimeMembershipId.localeCompare(right.runtimeMembershipId),
    );
    const candidateRevision = createHash('sha256')
      .update(JSON.stringify({
        runtimeAsset: {
          id: runtimeAsset.id,
          type: runtimeAsset.type,
          servicePrefix: runtimeAsset.servicePrefix || null,
          policyBindingRef: runtimeAsset.policyBindingRef || null,
        },
        memberships: memberships.map((item) => ({
          id: item.id,
          endpointDefinitionId: item.endpointDefinitionId,
          publicationRevision: item.publicationRevision,
        })),
        bindingRevisions,
        sampleIds: resultPlans
          .map((item) => item.endpointTestSampleId)
          .filter(Boolean)
          .sort(),
        behaviorFingerprint: candidateContext.behaviorFingerprint || null,
        waivers,
      }))
      .digest('hex');

    let candidateSnapshot: Record<string, unknown> | undefined;
    if (runtimeAsset.type === RuntimeAssetType.GATEWAY_SERVICE && blockers.length === 0) {
      try {
        const prepared = await this.gatewayRouteSnapshotService.prepareCandidate(
          runtimeAssetId,
          candidateRevision,
        );
        candidateSnapshot = prepared;
        const stagedMembershipIds = new Set(prepared.runtimeMembershipIds);
        for (const membership of memberships) {
          if (!stagedMembershipIds.has(membership.id)) {
            this.addBlockedPrecondition(
              resultPlans,
              blockers,
              membership,
              'gateway_candidate_route_missing',
              'The publication membership was not assembled into the Gateway candidate snapshot',
            );
          }
        }
        if (blockers.length > 0) {
          this.gatewayRouteSnapshotService.discardCandidate(candidateRevision);
          candidateSnapshot = undefined;
        }
      } catch (error) {
        for (const membership of memberships) {
          this.addBlockedPrecondition(
            resultPlans,
            blockers,
            membership,
            'gateway_candidate_assembly_failed',
            error instanceof Error ? error.message : 'Gateway candidate assembly failed',
          );
        }
        this.gatewayRouteSnapshotService.discardCandidate(candidateRevision);
      }
    }

    const blockedCount = resultPlans.filter(
      (item) => item.status === RuntimeVerificationResultStatus.BLOCKED,
    ).length;
    const run = await this.runRepository.save(
      this.runRepository.create({
        runtimeAssetId,
        candidateRevision,
        previousActiveRevision: this.previousActiveRevision(runtimeAsset),
        trigger: dto.trigger || RuntimeVerificationTrigger.DEPLOY,
        status: blockers.length
          ? RuntimeVerificationRunStatus.BLOCKED
          : RuntimeVerificationRunStatus.PLANNED,
        activationStatus: blockers.length
          ? RuntimeVerificationActivationStatus.BLOCKED
          : RuntimeVerificationActivationStatus.NOT_ATTEMPTED,
        totalCount: resultPlans.length,
        passedCount: resultPlans.filter(
          item => item.status === RuntimeVerificationResultStatus.PASSED,
        ).length,
        failedCount: 0,
        blockedCount,
        upstreamBindingRevisions: bindingRevisions,
        blockers,
        metadata: {
          includeRegression: dto.includeRegression !== false,
          behaviorFingerprint: candidateContext.behaviorFingerprint,
          waivers,
          candidateSnapshot,
        },
        completedAt: blockers.length ? new Date() : undefined,
      }),
    );
    const results = resultPlans.length
      ? await this.resultRepository.save(
          resultPlans.map((item) =>
            this.resultRepository.create({ ...item, verificationRunId: run.id }),
          ),
        )
      : [];

    return { run, results, canExecute: run.status === RuntimeVerificationRunStatus.PLANNED };
  }

  async list(runtimeAssetId: string) {
    const data = await this.runRepository.find({
      where: { runtimeAssetId },
      order: { createdAt: 'DESC' },
    });
    return { total: data.length, data };
  }

  async get(runtimeAssetId: string, verificationRunId: string) {
    const run = await this.runRepository.findOne({
      where: { id: verificationRunId, runtimeAssetId },
    });
    if (!run) {
      throw new NotFoundException(`Runtime verification run '${verificationRunId}' not found`);
    }
    const results = await this.resultRepository.find({
      where: { verificationRunId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return { run, results };
  }

  async executeGatewayCandidate(runtimeAssetId: string, verificationRunId: string) {
    const runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { id: runtimeAssetId },
    });
    if (!runtimeAsset) {
      throw new NotFoundException(`Runtime asset '${runtimeAssetId}' not found`);
    }
    if (runtimeAsset.type !== RuntimeAssetType.GATEWAY_SERVICE) {
      throw new ConflictException('Only Gateway runtime assets use Gateway candidate replay');
    }
    const run = await this.runRepository.findOne({
      where: { id: verificationRunId, runtimeAssetId },
    });
    if (!run) {
      throw new NotFoundException(`Runtime verification run '${verificationRunId}' not found`);
    }
    const claim = await this.runRepository.update(
      { id: verificationRunId, runtimeAssetId, status: RuntimeVerificationRunStatus.PLANNED },
      { status: RuntimeVerificationRunStatus.RUNNING, startedAt: new Date() },
    );
    if (claim.affected !== 1) {
      throw new ConflictException(
        `Runtime verification run '${verificationRunId}' is not available for execution`,
      );
    }
    run.status = RuntimeVerificationRunStatus.RUNNING;
    run.startedAt = new Date();

    const results = await this.resultRepository.find({
      where: { verificationRunId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const pendingResults = results.filter(
      item => item.status === RuntimeVerificationResultStatus.PENDING,
    );
    const sampleIds = pendingResults
      .map(item => item.endpointTestSampleId)
      .filter((id): id is string => Boolean(id));
    const samples = sampleIds.length
      ? await this.sampleRepository.find({ where: { id: In(sampleIds) } })
      : [];
    const sampleById = new Map(samples.map(sample => [sample.id, sample]));

    for (const result of pendingResults) {
      const sample = result.endpointTestSampleId
        ? sampleById.get(result.endpointTestSampleId)
        : undefined;
      if (!sample) {
        result.status = RuntimeVerificationResultStatus.FAILED;
        result.errorMessage = 'The selected endpoint test sample no longer exists';
        await this.resultRepository.save(result);
        continue;
      }
      try {
        const replay = await this.gatewayCandidateReplayService.replay({
          candidateRevision: run.candidateRevision,
          runtimeMembershipId: result.runtimeMembershipId,
          verificationRunId: run.id,
          sample,
        });
        result.actualStatusCode = replay.statusCode;
        result.durationMs = replay.durationMs;
        const responseAssertion = this.responseAssertionService.assert(sample, replay.body);
        result.evidence = {
          ...(result.evidence || {}),
          routePath: replay.routePath,
          method: replay.method,
          responseHeaders: this.sanitizeValue(replay.headers),
          responsePayload: this.sanitizeValue(replay.body),
          responseBodyBytes: replay.bodyBytes,
          responseTruncated: replay.truncated,
          responseAssertion: this.sanitizeValue(responseAssertion),
        };
        if (replay.statusCode === result.expectedStatusCode && responseAssertion.passed) {
          result.status = RuntimeVerificationResultStatus.PASSED;
          result.errorMessage = undefined;
        } else if (replay.statusCode !== result.expectedStatusCode) {
          result.status = RuntimeVerificationResultStatus.FAILED;
          result.errorMessage =
            `Expected HTTP ${result.expectedStatusCode}, received ${replay.statusCode}`;
        } else {
          result.status = RuntimeVerificationResultStatus.FAILED;
          result.errorMessage = this.responseAssertionError(responseAssertion);
        }
      } catch (error) {
        result.status = RuntimeVerificationResultStatus.FAILED;
        result.errorMessage = error instanceof Error ? error.message : 'Gateway replay failed';
      }
      await this.resultRepository.save(result);
    }

    run.passedCount = results.filter(
      item => item.status === RuntimeVerificationResultStatus.PASSED,
    ).length;
    run.failedCount = results.filter(
      item => item.status === RuntimeVerificationResultStatus.FAILED,
    ).length;
    run.blockedCount = results.filter(
      item => item.status === RuntimeVerificationResultStatus.BLOCKED,
    ).length;
    run.completedAt = new Date();

    let activation: Record<string, unknown>;
    if (run.failedCount === 0 && run.blockedCount === 0 && run.passedCount > 0) {
      try {
        const activated = await this.gatewayRouteSnapshotService.activateCandidate(run.candidateRevision);
        activation = activated;
        runtimeAsset.status = 'active' as any;
        runtimeAsset.metadata = {
          ...(runtimeAsset.metadata || {}),
          previousActiveRevision: run.previousActiveRevision,
          activeRevision: run.candidateRevision,
          activeGatewaySnapshotFingerprint: activated.snapshotFingerprint,
          activeUpstreamBindingRevisions: run.upstreamBindingRevisions || [],
          lastVerificationRunId: run.id,
          activatedAt: new Date().toISOString(),
        };
        await this.runtimeAssetRepository.save(runtimeAsset);
        run.status = RuntimeVerificationRunStatus.PASSED;
        run.activationStatus = RuntimeVerificationActivationStatus.ACTIVATED;
      } catch (error) {
        this.gatewayRouteSnapshotService.rollbackRuntimeAsset(runtimeAssetId);
        run.status = RuntimeVerificationRunStatus.FAILED;
        run.activationStatus = run.previousActiveRevision
          ? RuntimeVerificationActivationStatus.RETAINED_PREVIOUS
          : RuntimeVerificationActivationStatus.BLOCKED;
        run.blockers = [
          ...(run.blockers || []),
          {
            code: 'gateway_candidate_activation_failed',
            message: error instanceof Error ? error.message : 'Gateway activation failed',
          },
        ];
        activation = { activated: false, error: run.blockers.at(-1)?.message };
      }
    } else {
      this.gatewayRouteSnapshotService.discardCandidate(run.candidateRevision);
      run.status = RuntimeVerificationRunStatus.FAILED;
      run.activationStatus = run.previousActiveRevision
        ? RuntimeVerificationActivationStatus.RETAINED_PREVIOUS
        : RuntimeVerificationActivationStatus.BLOCKED;
      activation = {
        activated: false,
        retainedPrevious: Boolean(run.previousActiveRevision),
      };
    }
    const savedRun = await this.runRepository.save(run);
    return { run: savedRun, results, activation };
  }

  async executeMcpCandidate(
    runtimeAssetId: string,
    verificationRunId: string,
    candidateTools: Array<{ runtimeMembershipId: string; tool: any }>,
  ) {
    const runtimeAsset = await this.runtimeAssetRepository.findOne({ where: { id: runtimeAssetId } });
    if (!runtimeAsset || runtimeAsset.type !== RuntimeAssetType.MCP_SERVER) {
      throw new NotFoundException(`MCP runtime asset '${runtimeAssetId}' not found`);
    }
    const run = await this.runRepository.findOne({
      where: { id: verificationRunId, runtimeAssetId },
    });
    if (!run) throw new NotFoundException(`Runtime verification run '${verificationRunId}' not found`);
    const claimed = await this.runRepository.update(
      { id: verificationRunId, runtimeAssetId, status: RuntimeVerificationRunStatus.PLANNED },
      { status: RuntimeVerificationRunStatus.RUNNING, startedAt: new Date() },
    );
    if (claimed.affected !== 1) {
      throw new ConflictException(
        `Runtime verification run '${verificationRunId}' is not available for execution`,
      );
    }
    run.status = RuntimeVerificationRunStatus.RUNNING;
    run.startedAt = new Date();
    const results = await this.resultRepository.find({ where: { verificationRunId } });
    const pending = results.filter(item => item.status === RuntimeVerificationResultStatus.PENDING);
    const sampleIds = pending.map(item => item.endpointTestSampleId).filter(Boolean) as string[];
    const samples = sampleIds.length
      ? await this.sampleRepository.find({ where: { id: In(sampleIds) } })
      : [];
    const sampleMap = new Map(samples.map(sample => [sample.id, sample]));
    const toolMap = new Map(candidateTools.map(item => [item.runtimeMembershipId, item.tool]));

    for (const result of pending) {
      const sample = result.endpointTestSampleId
        ? sampleMap.get(result.endpointTestSampleId)
        : undefined;
      const tool = toolMap.get(result.runtimeMembershipId);
      if (!sample || !tool) {
        result.status = RuntimeVerificationResultStatus.FAILED;
        result.errorMessage = !sample
          ? 'Verification sample was not found'
          : 'MCP candidate tool was not assembled for this membership';
        await this.resultRepository.save(result);
        continue;
      }
      const startedAt = Date.now();
      try {
        const replay = await this.mcpCandidateReplayService.replay({ tool, sample });
        result.actualStatusCode = replay.statusCode;
        result.durationMs = replay.durationMs;
        const responseAssertion = this.responseAssertionService.assert(sample, replay.body);
        result.evidence = this.sanitizeValue({
          toolName: replay.toolName,
          isError: replay.isError,
          response: replay.body,
          responseAssertion,
        }) as Record<string, unknown>;
        if (replay.statusCode === result.expectedStatusCode && responseAssertion.passed) {
          result.status = RuntimeVerificationResultStatus.PASSED;
          result.errorMessage = undefined;
        } else if (replay.statusCode !== result.expectedStatusCode) {
          result.status = RuntimeVerificationResultStatus.FAILED;
          result.errorMessage =
            `Expected HTTP ${result.expectedStatusCode}, received ${replay.statusCode}`;
        } else {
          result.status = RuntimeVerificationResultStatus.FAILED;
          result.errorMessage = this.responseAssertionError(responseAssertion);
        }
      } catch (error) {
        result.status = RuntimeVerificationResultStatus.FAILED;
        result.durationMs = Date.now() - startedAt;
        result.errorMessage = error instanceof Error ? error.message : 'MCP replay failed';
      }
      await this.resultRepository.save(result);
    }

    run.passedCount = results.filter(item => item.status === RuntimeVerificationResultStatus.PASSED).length;
    run.failedCount = results.filter(item => item.status === RuntimeVerificationResultStatus.FAILED).length;
    run.blockedCount = results.filter(item => item.status === RuntimeVerificationResultStatus.BLOCKED).length;
    run.completedAt = new Date();
    run.status = run.failedCount === 0 && run.blockedCount === 0 && run.passedCount > 0
      ? RuntimeVerificationRunStatus.PASSED
      : RuntimeVerificationRunStatus.FAILED;
    run.activationStatus = run.status === RuntimeVerificationRunStatus.PASSED
      ? RuntimeVerificationActivationStatus.NOT_ATTEMPTED
      : run.previousActiveRevision
        ? RuntimeVerificationActivationStatus.RETAINED_PREVIOUS
        : RuntimeVerificationActivationStatus.BLOCKED;
    return { run: await this.runRepository.save(run), results };
  }

  async activateMcpCandidate(
    runtimeAssetId: string,
    verificationRunId: string,
    manager?: EntityManager,
  ) {
    const runRepository = manager?.getRepository(RuntimeVerificationRunEntity) || this.runRepository;
    const runtimeAssetRepository = manager?.getRepository(RuntimeAssetEntity) || this.runtimeAssetRepository;
    const run = await runRepository.findOne({
      where: { id: verificationRunId, runtimeAssetId },
    });
    if (!run || run.status !== RuntimeVerificationRunStatus.PASSED) {
      throw new ConflictException(`MCP verification run '${verificationRunId}' has not passed`);
    }
    const runtimeAsset = await runtimeAssetRepository.findOne({ where: { id: runtimeAssetId } });
    if (!runtimeAsset || runtimeAsset.type !== RuntimeAssetType.MCP_SERVER) {
      throw new NotFoundException(`MCP runtime asset '${runtimeAssetId}' not found`);
    }
    runtimeAsset.metadata = {
      ...(runtimeAsset.metadata || {}),
      previousActiveRevision: run.previousActiveRevision,
      activeRevision: run.candidateRevision,
      activeUpstreamBindingRevisions: run.upstreamBindingRevisions || [],
      activeMcpBehaviorFingerprint: run.metadata?.behaviorFingerprint,
      lastVerificationRunId: run.id,
      activatedAt: new Date().toISOString(),
    };
    await runtimeAssetRepository.save(runtimeAsset);
    run.activationStatus = RuntimeVerificationActivationStatus.ACTIVATED;
    return { run: await runRepository.save(run), runtimeAsset };
  }

  private sampleResultPlan(
    membership: RuntimeAssetEndpointBindingEntity,
    sample: EndpointTestSampleEntity,
    kind: RuntimeVerificationCaseKind,
  ): Partial<RuntimeVerificationResultEntity> {
    return {
      runtimeMembershipId: membership.id,
      endpointDefinitionId: membership.endpointDefinitionId,
      endpointTestSampleId: sample.id,
      kind,
      status: RuntimeVerificationResultStatus.PENDING,
      expectedStatusCode: sample.responseStatusCode,
      evidence: { fingerprint: sample.fingerprint, capturedAt: sample.capturedAt },
    };
  }

  private addBlockedPrecondition(
    results: Array<Partial<RuntimeVerificationResultEntity>>,
    blockers: VerificationBlocker[],
    membership: RuntimeAssetEndpointBindingEntity,
    code: string,
    message: string,
  ) {
    blockers.push({ code, runtimeMembershipId: membership.id, message });
    results.push({
      runtimeMembershipId: membership.id,
      endpointDefinitionId: membership.endpointDefinitionId,
      kind: RuntimeVerificationCaseKind.PRECONDITION,
      status: RuntimeVerificationResultStatus.BLOCKED,
      blockerCode: code,
      errorMessage: message,
    });
  }

  private hasTag(sample: EndpointTestSampleEntity, tag: string) {
    return (sample.tags || []).some((item) => item.trim().toLowerCase() === tag);
  }

  private previousActiveRevision(runtimeAsset: RuntimeAssetEntity) {
    const value = runtimeAsset.metadata?.activeRevision;
    return typeof value === 'string' && value ? value : undefined;
  }

  private responseAssertionError(assertion: {
    mode: string;
    mismatches: Array<{ path: string; expected: string; actual: string }>;
  }) {
    const mismatch = assertion.mismatches[0];
    return mismatch
      ? `Response assertion failed (${assertion.mode}): ${mismatch.path} expected ${mismatch.expected}, received ${mismatch.actual}`
      : `Response assertion failed (${assertion.mode})`;
  }

  private sanitizeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.sanitizeValue(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /authorization|cookie|token|secret|password|api[-_]?key/i.test(key)
          ? '[REDACTED]'
          : this.sanitizeValue(item),
      ]),
    );
  }
}
