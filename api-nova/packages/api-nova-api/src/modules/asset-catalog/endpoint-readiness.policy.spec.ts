import { EndpointDefinitionStatus } from '../../database/entities/endpoint-definition.entity';
import { PublicationProfileStatus } from '../../database/entities/publication-profile.entity';
import {
  evaluateEndpointGovernanceReadiness,
  evaluatePublicationReadiness,
} from './endpoint-readiness.policy';

describe('endpoint-readiness.policy', () => {
  const createEndpointDefinition = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'endpoint-1',
      sourceServiceAssetId: 'source-1',
      method: 'GET',
      path: '/orders',
      status: EndpointDefinitionStatus.VERIFIED,
      publishEnabled: true,
      metadata: {
        lastProbeStatus: 'healthy',
        testStatus: 'passed',
      },
      ...overrides,
    }) as any;

  it('evaluates governance readiness from shared endpoint rules', () => {
    const readiness = evaluateEndpointGovernanceReadiness(createEndpointDefinition());

    expect(readiness.ready).toBe(true);
    expect(readiness.reasons).toEqual([]);
    expect(readiness.checks).toEqual({
      testingPassed: true,
      lifecycleReady: true,
      probeReady: true,
      publishEnabledReady: true,
    });
  });

  it('surfaces shared governance blockers consistently', () => {
    const readiness = evaluateEndpointGovernanceReadiness(
      createEndpointDefinition({
        status: EndpointDefinitionStatus.DRAFT,
        publishEnabled: false,
        metadata: {
          lastProbeStatus: 'unhealthy',
          testStatus: 'failed',
        },
      }),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      'status is draft, expected verified, published, or offline',
      'publishEnabled=false',
      'lastProbeStatus is unhealthy, expected healthy',
      'testStatus is failed, expected passed',
    ]);
  });

  it('extends governance readiness with publication-specific checks', () => {
    const readiness = evaluatePublicationReadiness(
      createEndpointDefinition(),
      {
        status: PublicationProfileStatus.REVIEWED,
        intentName: 'getOrders',
        descriptionForLlm: 'List orders',
      },
      {
        routeRequired: true,
        routeConfigured: true,
      },
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.endpointReasons).toEqual([]);
    expect(readiness.profileReasons).toEqual([]);
    expect(readiness.routeReasons).toEqual([]);
    expect(readiness.checks.routeReady).toBe(true);
  });

  it('blocks publication when profile or route requirements are missing', () => {
    const readiness = evaluatePublicationReadiness(
      createEndpointDefinition(),
      {
        status: PublicationProfileStatus.DRAFT,
        intentName: '',
        descriptionForLlm: '',
      },
      {
        routeRequired: true,
        routeConfigured: false,
      },
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.profileReasons).toEqual([
      'profile status is draft, expected reviewed or published',
      'intentName is empty',
      'descriptionForLlm is empty',
    ]);
    expect(readiness.routeReasons).toEqual(['gateway route binding is missing']);
  });
});
