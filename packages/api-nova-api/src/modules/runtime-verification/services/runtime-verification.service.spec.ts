import { EndpointTestSampleStatus } from '../../../database/entities/endpoint-test-sample.entity';
import { RuntimeVerificationRunStatus } from '../../../database/entities/runtime-verification-run.entity';
import { RuntimeVerificationResultStatus } from '../../../database/entities/runtime-verification-result.entity';
import { RuntimeUpstreamBindingStatus } from '../../../database/entities/runtime-upstream-binding.entity';
import { RuntimeVerificationService } from './runtime-verification.service';

describe('RuntimeVerificationService', () => {
  const runtimeAssetRepository = { findOne: jest.fn(), save: jest.fn(async value => value) };
  const membershipRepository = { find: jest.fn() };
  const sampleRepository = { find: jest.fn() };
  const runRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ id: 'verification-run-1', ...value })),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const resultRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    find: jest.fn(),
  };
  const upstreamBindingsService = {
    getByMembership: jest.fn(),
    resolve: jest.fn(),
  };
  const gatewayRouteSnapshotService = {
    prepareCandidate: jest.fn(),
    discardCandidate: jest.fn(),
    activateCandidate: jest.fn(),
    rollbackRuntimeAsset: jest.fn(),
  };
  const gatewayCandidateReplayService = { replay: jest.fn() };
  const mcpCandidateReplayService = { replay: jest.fn() };
  const responseAssertionService = { assert: jest.fn() };
  const service = new RuntimeVerificationService(
    runtimeAssetRepository as any,
    membershipRepository as any,
    sampleRepository as any,
    runRepository as any,
    resultRepository as any,
    upstreamBindingsService as any,
    gatewayRouteSnapshotService as any,
    gatewayCandidateReplayService as any,
    mcpCandidateReplayService as any,
    responseAssertionService as any,
  );

  const runtimeAsset = {
    id: 'runtime-1',
    type: 'gateway_service',
    servicePrefix: 'orders',
    policyBindingRef: null,
    metadata: {},
  };
  const membership = {
    id: 'membership-1',
    runtimeAssetId: 'runtime-1',
    endpointDefinitionId: 'endpoint-1',
    publicationRevision: 4,
    enabled: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeAssetRepository.findOne.mockResolvedValue(runtimeAsset);
    membershipRepository.find.mockResolvedValue([membership]);
    upstreamBindingsService.getByMembership.mockResolvedValue({
      binding: {
        id: 'binding-1',
        revision: 3,
        status: RuntimeUpstreamBindingStatus.ACTIVE,
      },
      candidates: [],
    });
    upstreamBindingsService.resolve.mockResolvedValue({
      resolved: true,
      instance: { id: 'instance-1' },
    });
    gatewayRouteSnapshotService.prepareCandidate.mockResolvedValue({
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'candidate-revision',
      routeCount: 1,
      runtimeMembershipIds: ['membership-1'],
    });
    gatewayRouteSnapshotService.activateCandidate.mockReturnValue({
      runtimeAssetId: 'runtime-1',
      activeRouteCount: 1,
      previousRouteCount: 0,
    });
    runRepository.update.mockResolvedValue({ affected: 1 });
    responseAssertionService.assert.mockReturnValue({
      passed: true,
      mode: 'schema',
      mismatches: [],
    });
  });

  it('blocks a candidate when a membership has no smoke sample', async () => {
    sampleRepository.find.mockResolvedValue([]);

    const result = await service.planCandidate('runtime-1');

    expect(result.canExecute).toBe(false);
    expect(result.run.status).toBe(RuntimeVerificationRunStatus.BLOCKED);
    expect(result.run.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'smoke_sample_missing',
          runtimeMembershipId: 'membership-1',
        }),
      ]),
    );
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: RuntimeVerificationResultStatus.BLOCKED,
          blockerCode: 'smoke_sample_missing',
        }),
      ]),
    );
  });

  it('records an authorized no-smoke waiver as passed evidence instead of silently bypassing the gate', async () => {
    sampleRepository.find.mockResolvedValue([]);
    upstreamBindingsService.getByMembership.mockResolvedValue({
      binding: {
        id: 'binding-1',
        revision: 3,
        environment: 'production',
        status: RuntimeUpstreamBindingStatus.ACTIVE,
      },
      candidates: [],
    });

    const result = await service.planCandidate(
      'runtime-1',
      { missingSmokeWaiverReason: 'Emergency production activation approved by operations.' },
      { waiverActorId: 'operator-1' },
    );

    expect(result.canExecute).toBe(true);
    expect(result.run.status).toBe(RuntimeVerificationRunStatus.PLANNED);
    expect(result.run.passedCount).toBe(1);
    expect(result.run.blockers).toEqual([]);
    expect(result.run.metadata.waivers).toEqual([expect.objectContaining({
      runtimeMembershipId: 'membership-1',
      environment: 'production',
      actorId: 'operator-1',
      reason: 'Emergency production activation approved by operations.',
    })]);
    expect(result.results).toEqual([expect.objectContaining({
      kind: 'waiver',
      status: RuntimeVerificationResultStatus.PASSED,
      evidence: {
        waiver: expect.objectContaining({ actorId: 'operator-1' }),
      },
    })]);
  });

  it('plans smoke and optional regression samples with binding revision evidence', async () => {
    sampleRepository.find.mockResolvedValue([
      {
        id: 'sample-smoke',
        endpointDefinitionId: 'endpoint-1',
        status: EndpointTestSampleStatus.ACTIVE,
        enabled: true,
        tags: ['smoke'],
        responseStatusCode: 200,
        fingerprint: 'smoke-fingerprint',
        capturedAt: new Date('2026-07-21T00:00:00.000Z'),
      },
      {
        id: 'sample-regression',
        endpointDefinitionId: 'endpoint-1',
        status: EndpointTestSampleStatus.ACTIVE,
        enabled: true,
        tags: ['regression'],
        responseStatusCode: 201,
        fingerprint: 'regression-fingerprint',
        capturedAt: new Date('2026-07-21T00:01:00.000Z'),
      },
    ]);

    const result = await service.planCandidate('runtime-1', { includeRegression: true });

    expect(result.canExecute).toBe(true);
    expect(result.run.status).toBe(RuntimeVerificationRunStatus.PLANNED);
    expect(result.run.candidateRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.run.upstreamBindingRevisions).toEqual([
      {
        runtimeMembershipId: 'membership-1',
        bindingId: 'binding-1',
        revision: 3,
        resolvedSourceServiceInstanceId: 'instance-1',
      },
    ]);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointTestSampleId: 'sample-smoke', kind: 'smoke' }),
        expect.objectContaining({ endpointTestSampleId: 'sample-regression', kind: 'regression' }),
      ]),
    );
  });

  it('changes candidate identity when the selected instance credential reference changes', async () => {
    sampleRepository.find.mockResolvedValue([{
      id: 'sample-smoke',
      endpointDefinitionId: 'endpoint-1',
      tags: ['smoke'],
      responseStatusCode: 200,
      fingerprint: 'fingerprint',
      capturedAt: new Date(),
    }]);
    upstreamBindingsService.resolve.mockResolvedValue({
      resolved: true,
      instance: {
        id: 'instance-1',
        credentialRef: 'env-headers:Authorization=UPSTREAM_TOKEN_A',
      },
    });
    const first = await service.planCandidate('runtime-1');
    upstreamBindingsService.resolve.mockResolvedValue({
      resolved: true,
      instance: {
        id: 'instance-1',
        credentialRef: 'env-headers:Authorization=UPSTREAM_TOKEN_B',
      },
    });
    const second = await service.planCandidate('runtime-1');

    expect(second.run.candidateRevision).not.toBe(first.run.candidateRevision);
    expect(first.run.upstreamBindingRevisions[0]).toEqual(expect.objectContaining({
      resolvedSourceServiceInstanceId: 'instance-1',
      credentialRefFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(first.run)).not.toContain('UPSTREAM_TOKEN_A');
  });

  it('blocks an unresolved upstream even when smoke evidence exists', async () => {
    sampleRepository.find.mockResolvedValue([
      {
        id: 'sample-smoke',
        endpointDefinitionId: 'endpoint-1',
        tags: ['smoke'],
        responseStatusCode: 200,
        fingerprint: 'fingerprint',
        capturedAt: new Date(),
      },
    ]);
    upstreamBindingsService.resolve.mockResolvedValue({
      resolved: false,
      reason: 'no_healthy_candidate',
    });

    const result = await service.planCandidate('runtime-1');

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.BLOCKED);
    expect(result.run.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'upstream_no_healthy_candidate' }),
      ]),
    );
  });

  it('blocks and discards a Gateway candidate when a membership route is missing', async () => {
    sampleRepository.find.mockResolvedValue([
      {
        id: 'sample-smoke',
        endpointDefinitionId: 'endpoint-1',
        tags: ['smoke'],
        responseStatusCode: 200,
        fingerprint: 'fingerprint',
        capturedAt: new Date(),
      },
    ]);
    gatewayRouteSnapshotService.prepareCandidate.mockResolvedValue({
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'candidate-revision',
      routeCount: 0,
      runtimeMembershipIds: [],
    });

    const result = await service.planCandidate('runtime-1');

    expect(result.canExecute).toBe(false);
    expect(result.run.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'gateway_candidate_route_missing' }),
      ]),
    );
    expect(gatewayRouteSnapshotService.discardCandidate).toHaveBeenCalledWith(
      result.run.candidateRevision,
    );
  });

  it('can activate a waiver-only Gateway run while retaining auditable passed evidence', async () => {
    const run = {
      id: 'run-waiver-only',
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'revision-waiver-only',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    };
    const waiverResult = {
      id: 'result-waiver-only',
      verificationRunId: run.id,
      runtimeMembershipId: 'membership-1',
      endpointDefinitionId: 'endpoint-1',
      kind: 'waiver',
      status: RuntimeVerificationResultStatus.PASSED,
      evidence: {
        waiver: {
          actorId: 'operator-1',
          reason: 'Emergency production activation approved by operations.',
        },
      },
    };
    runRepository.findOne.mockResolvedValue(run);
    resultRepository.find.mockResolvedValue([waiverResult]);

    const result = await service.executeGatewayCandidate('runtime-1', run.id);

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.PASSED);
    expect(result.run.activationStatus).toBe('activated');
    expect(result.run.passedCount).toBe(1);
    expect(gatewayCandidateReplayService.replay).not.toHaveBeenCalled();
    expect(gatewayRouteSnapshotService.activateCandidate).toHaveBeenCalledWith(
      'revision-waiver-only',
    );
  });

  it('executes pending Gateway samples and activates only after all pass', async () => {
    const run = {
      id: 'run-1',
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'revision-1',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    };
    const verificationResult = {
      id: 'result-1',
      verificationRunId: 'run-1',
      runtimeMembershipId: 'membership-1',
      endpointDefinitionId: 'endpoint-1',
      endpointTestSampleId: 'sample-1',
      expectedStatusCode: 200,
      status: RuntimeVerificationResultStatus.PENDING,
      evidence: {},
    };
    runRepository.findOne.mockResolvedValue(run);
    resultRepository.find.mockResolvedValue([verificationResult]);
    sampleRepository.find.mockResolvedValue([{ id: 'sample-1' }]);
    gatewayCandidateReplayService.replay.mockResolvedValue({
      statusCode: 200,
      durationMs: 12,
      routePath: '/orders/pets',
      method: 'GET',
      headers: { authorization: 'must-redact' },
      body: { token: 'must-redact', ok: true },
      bodyBytes: 24,
      truncated: false,
    });

    const result = await service.executeGatewayCandidate('runtime-1', 'run-1');

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.PASSED);
    expect(result.run.activationStatus).toBe('activated');
    expect(verificationResult.status).toBe(RuntimeVerificationResultStatus.PASSED);
    expect(verificationResult.evidence).toEqual(
      expect.objectContaining({
        responseHeaders: { authorization: '[REDACTED]' },
        responsePayload: { token: '[REDACTED]', ok: true },
      }),
    );
    expect(gatewayRouteSnapshotService.activateCandidate).toHaveBeenCalledWith('revision-1');
    expect(runtimeAssetRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ activeRevision: 'revision-1' }),
      }),
    );
  });

  it('retains the previous revision and discards the candidate after replay failure', async () => {
    runRepository.findOne.mockResolvedValue({
      id: 'run-2',
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'revision-2',
      previousActiveRevision: 'revision-1',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    });
    resultRepository.find.mockResolvedValue([
      {
        id: 'result-2',
        verificationRunId: 'run-2',
        runtimeMembershipId: 'membership-1',
        endpointDefinitionId: 'endpoint-1',
        endpointTestSampleId: 'sample-1',
        expectedStatusCode: 200,
        status: RuntimeVerificationResultStatus.PENDING,
      },
    ]);
    sampleRepository.find.mockResolvedValue([{ id: 'sample-1' }]);
    gatewayCandidateReplayService.replay.mockResolvedValue({
      statusCode: 503,
      durationMs: 5,
      routePath: '/orders/pets',
      method: 'GET',
      headers: {},
      body: { error: 'unavailable' },
      bodyBytes: 23,
      truncated: false,
    });

    const result = await service.executeGatewayCandidate('runtime-1', 'run-2');

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.FAILED);
    expect(result.run.activationStatus).toBe('retained_previous');
    expect(gatewayRouteSnapshotService.discardCandidate).toHaveBeenCalledWith('revision-2');
    expect(gatewayRouteSnapshotService.activateCandidate).not.toHaveBeenCalled();
  });

  it('retains the previous Gateway revision when the response schema assertion fails', async () => {
    const run = {
      id: 'run-schema-failure',
      runtimeAssetId: 'runtime-1',
      candidateRevision: 'revision-schema-failure',
      previousActiveRevision: 'revision-stable',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    };
    const verificationResult = {
      id: 'result-schema-failure',
      verificationRunId: run.id,
      runtimeMembershipId: 'membership-1',
      endpointDefinitionId: 'endpoint-1',
      endpointTestSampleId: 'sample-schema',
      expectedStatusCode: 200,
      status: RuntimeVerificationResultStatus.PENDING,
      evidence: {} as Record<string, unknown>,
      errorMessage: undefined as string | undefined,
    };
    runRepository.findOne.mockResolvedValue(run);
    resultRepository.find.mockResolvedValue([verificationResult]);
    sampleRepository.find.mockResolvedValue([{
      id: 'sample-schema',
      responsePayload: { customer: { name: 'Ada' } },
    }]);
    gatewayCandidateReplayService.replay.mockResolvedValue({
      statusCode: 200,
      durationMs: 7,
      routePath: '/orders/customer',
      method: 'GET',
      headers: {},
      body: { customer: {} },
      bodyBytes: 15,
      truncated: false,
    });
    responseAssertionService.assert.mockReturnValue({
      passed: false,
      mode: 'schema',
      mismatches: [{ path: '$.customer.name', expected: 'string', actual: 'missing' }],
    });

    const result = await service.executeGatewayCandidate('runtime-1', run.id);

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.FAILED);
    expect(result.run.activationStatus).toBe('retained_previous');
    expect(verificationResult.errorMessage).toBe(
      'Response assertion failed (schema): $.customer.name expected string, received missing',
    );
    expect(verificationResult.evidence).toEqual(expect.objectContaining({
      responseAssertion: expect.objectContaining({ passed: false, mode: 'schema' }),
    }));
    expect(gatewayRouteSnapshotService.discardCandidate).toHaveBeenCalledWith(
      'revision-schema-failure',
    );
    expect(gatewayRouteSnapshotService.activateCandidate).not.toHaveBeenCalled();
  });

  it('retains the previous MCP revision when the response assertion fails', async () => {
    const mcpAsset = {
      id: 'runtime-mcp-schema',
      type: 'mcp_server',
      metadata: { activeRevision: 'revision-mcp-stable' },
    };
    const run = {
      id: 'run-mcp-schema',
      runtimeAssetId: mcpAsset.id,
      candidateRevision: 'revision-mcp-candidate',
      previousActiveRevision: 'revision-mcp-stable',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    };
    const verificationResult = {
      id: 'result-mcp-schema',
      verificationRunId: run.id,
      runtimeMembershipId: 'membership-1',
      endpointDefinitionId: 'endpoint-1',
      endpointTestSampleId: 'sample-mcp-schema',
      expectedStatusCode: 200,
      status: RuntimeVerificationResultStatus.PENDING,
      evidence: {} as Record<string, unknown>,
      errorMessage: undefined as string | undefined,
    };
    runtimeAssetRepository.findOne.mockResolvedValue(mcpAsset);
    runRepository.findOne.mockResolvedValue(run);
    resultRepository.find.mockResolvedValue([verificationResult]);
    sampleRepository.find.mockResolvedValue([{
      id: 'sample-mcp-schema',
      responsePayload: { state: 'ready' },
    }]);
    mcpCandidateReplayService.replay.mockResolvedValue({
      statusCode: 200,
      durationMs: 6,
      isError: false,
      body: { state: 1 },
      toolName: 'getState',
    });
    responseAssertionService.assert.mockReturnValue({
      passed: false,
      mode: 'exact',
      mismatches: [{ path: '$.state', expected: '"ready"', actual: '1' }],
    });

    const result = await service.executeMcpCandidate(mcpAsset.id, run.id, [
      { runtimeMembershipId: 'membership-1', tool: { name: 'getState' } },
    ]);

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.FAILED);
    expect(result.run.activationStatus).toBe('retained_previous');
    expect(verificationResult.errorMessage).toBe(
      'Response assertion failed (exact): $.state expected "ready", received 1',
    );
    expect(verificationResult.evidence).toEqual(expect.objectContaining({
      responseAssertion: expect.objectContaining({ passed: false, mode: 'exact' }),
    }));
  });

  it('executes MCP candidate tools without activating failed or untested server state', async () => {
    const mcpAsset = {
      id: 'runtime-mcp-1',
      type: 'mcp_server',
      metadata: { activeRevision: 'revision-old' },
    };
    const run = {
      id: 'run-mcp-1',
      runtimeAssetId: mcpAsset.id,
      candidateRevision: 'revision-mcp-2',
      previousActiveRevision: 'revision-old',
      status: RuntimeVerificationRunStatus.PLANNED,
      activationStatus: 'not_attempted',
      blockers: [],
    };
    const verificationResult = {
      id: 'result-mcp-1',
      verificationRunId: run.id,
      runtimeMembershipId: 'membership-1',
      endpointDefinitionId: 'endpoint-1',
      endpointTestSampleId: 'sample-1',
      expectedStatusCode: 200,
      status: RuntimeVerificationResultStatus.PENDING,
      evidence: {} as Record<string, unknown>,
    };
    runtimeAssetRepository.findOne.mockResolvedValue(mcpAsset);
    runRepository.findOne.mockResolvedValue(run);
    resultRepository.find.mockResolvedValue([verificationResult]);
    sampleRepository.find.mockResolvedValue([{ id: 'sample-1', requestPayload: { id: 7 } }]);
    mcpCandidateReplayService.replay.mockResolvedValue({
      statusCode: 200,
      durationMs: 8,
      isError: false,
      body: { token: 'secret', ok: true },
      toolName: 'getOrder',
    });

    const result = await service.executeMcpCandidate(mcpAsset.id, run.id, [
      { runtimeMembershipId: 'membership-1', tool: { name: 'getOrder' } },
    ]);

    expect(result.run.status).toBe(RuntimeVerificationRunStatus.PASSED);
    expect(result.run.activationStatus).toBe('not_attempted');
    expect(verificationResult.evidence).toEqual(expect.objectContaining({
      toolName: 'getOrder',
      response: { token: '[REDACTED]', ok: true },
    }));
    expect(runtimeAssetRepository.save).not.toHaveBeenCalled();
  });


  it('finalizes MCP activation through the caller transaction repositories', async () => {
    const run = {
      id: 'run-mcp-tx',
      runtimeAssetId: 'runtime-mcp-tx',
      candidateRevision: 'revision-mcp-tx',
      status: RuntimeVerificationRunStatus.PASSED,
      activationStatus: 'not_attempted',
      upstreamBindingRevisions: [],
    };
    const asset = {
      id: 'runtime-mcp-tx',
      type: 'mcp_server',
      metadata: { managedServerId: 'server-tx' },
    };
    const txRunRepository = {
      findOne: jest.fn().mockResolvedValue(run),
      save: jest.fn(async value => value),
    };
    const txAssetRepository = {
      findOne: jest.fn().mockResolvedValue(asset),
      save: jest.fn(async value => value),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity.name === 'RuntimeVerificationRunEntity' ? txRunRepository : txAssetRepository,
      ),
    };

    const result = await service.activateMcpCandidate(asset.id, run.id, manager as any);

    expect(txAssetRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ activeRevision: 'revision-mcp-tx' }),
    }));
    expect(txRunRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      activationStatus: 'activated',
    }));
    expect(result.run.activationStatus).toBe('activated');
  });

});
