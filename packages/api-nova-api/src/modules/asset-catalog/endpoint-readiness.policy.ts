import {
  EndpointDefinitionEntity,
  EndpointDefinitionStatus,
} from '../../database/entities/endpoint-definition.entity';
import { PublicationProfileStatus } from '../../database/entities/publication-profile.entity';

type EndpointMetadata = Record<string, unknown>;

export type GovernanceReadinessEvaluation = {
  ready: boolean;
  reasons: string[];
  checks: {
    testingPassed: boolean;
    lifecycleReady: boolean;
    probeReady: boolean;
    publishEnabledReady: boolean;
  };
};

export type PublicationReadinessEvaluation = GovernanceReadinessEvaluation & {
  routeConfigured: boolean;
  checks: GovernanceReadinessEvaluation['checks'] & {
    endpointReady: boolean;
    profileReady: boolean;
    intentReady: boolean;
    llmDescriptionReady: boolean;
    routeReady: boolean | null;
  };
  endpointReasons: string[];
  profileReasons: string[];
  routeReasons: string[];
};

type PublicationProfileSnapshot = {
  status?: PublicationProfileStatus | string;
  intentName?: string | null;
  descriptionForLlm?: string | null;
};

export function evaluateEndpointGovernanceReadiness(
  endpointDefinition: EndpointDefinitionEntity,
): GovernanceReadinessEvaluation {
  const metadata = getEndpointMetadata(endpointDefinition);
  const reasons: string[] = [];
  const testingPassed = metadata.testStatus === 'passed';
  const lifecycleReady = isLifecycleReady(endpointDefinition.status);
  const probeReady = metadata.lastProbeStatus === 'healthy';
  const publishEnabledReady =
    endpointDefinition.publishEnabled ||
    endpointDefinition.status === EndpointDefinitionStatus.OFFLINE;

  if (!lifecycleReady) {
    reasons.push(
      `status is ${endpointDefinition.status}, expected verified, published, or offline`,
    );
  }
  if (!publishEnabledReady) {
    reasons.push('publishEnabled=false');
  }
  if (!probeReady) {
    reasons.push(
      `lastProbeStatus is ${String(metadata.lastProbeStatus || 'unknown')}, expected healthy`,
    );
  }
  if (!testingPassed) {
    reasons.push(
      `testStatus is ${String(metadata.testStatus || 'untested')}, expected passed`,
    );
  }

  return {
    ready: reasons.length === 0,
    reasons,
    checks: {
      testingPassed,
      lifecycleReady,
      probeReady,
      publishEnabledReady,
    },
  };
}

export function evaluatePublicationReadiness(
  endpointDefinition: EndpointDefinitionEntity,
  profile: PublicationProfileSnapshot,
  options: {
    routeRequired?: boolean;
    routeConfigured?: boolean;
  } = {},
): PublicationReadinessEvaluation {
  const governance = evaluateEndpointGovernanceReadiness(endpointDefinition);
  const endpointReasons = [...governance.reasons];
  const profileReasons: string[] = [];
  const routeReasons: string[] = [];
  const routeRequired = Boolean(options.routeRequired);
  const routeConfigured = Boolean(options.routeConfigured);
  const profileReady =
    profile.status === PublicationProfileStatus.REVIEWED ||
    profile.status === PublicationProfileStatus.PUBLISHED;
  const intentReady = Boolean(profile.intentName);
  const llmDescriptionReady = Boolean(profile.descriptionForLlm);

  if (!profileReady) {
    profileReasons.push(
      `profile status is ${String(profile.status || 'draft')}, expected reviewed or published`,
    );
  }
  if (!intentReady) {
    profileReasons.push('intentName is empty');
  }
  if (!llmDescriptionReady) {
    profileReasons.push('descriptionForLlm is empty');
  }
  if (routeRequired && !routeConfigured) {
    routeReasons.push('gateway route binding is missing');
  }

  const reasons = [...endpointReasons, ...profileReasons, ...routeReasons];

  return {
    ready: reasons.length === 0,
    reasons,
    routeConfigured,
    checks: {
      endpointReady: endpointReasons.length === 0,
      ...governance.checks,
      profileReady,
      intentReady,
      llmDescriptionReady,
      routeReady: routeRequired ? routeConfigured : null,
    },
    endpointReasons,
    profileReasons,
    routeReasons,
  };
}

function getEndpointMetadata(
  endpointDefinition: EndpointDefinitionEntity,
): EndpointMetadata {
  return (endpointDefinition.metadata || {}) as EndpointMetadata;
}

function isLifecycleReady(status: EndpointDefinitionStatus | string): boolean {
  return (
    status === EndpointDefinitionStatus.VERIFIED ||
    status === EndpointDefinitionStatus.PUBLISHED ||
    status === EndpointDefinitionStatus.OFFLINE
  );
}
