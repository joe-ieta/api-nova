import { Injectable } from '@nestjs/common';
import { STATISTICS_SCOPES, STATISTICS_SUMMARY_QUERY_KEYS } from './call-observability-statistics.service';
import { MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { User } from '../../database/entities/user.entity';
import { authorizeObservability, ObservabilityAuthorization, ObservabilityPermission } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { parseObservabilityQuery } from './call-observability-query';
import { CallObservabilityStore } from './call-observability.store';
import { INVOCATION_QUERY_KEYS, MAX_TRACE_NODES } from './call-observability-invocations.service';
import { CALLER_QUERY_KEYS, CALLER_DETAIL_QUERY_KEYS, SOURCE_QUERY_KEYS, MAX_VISITOR_QUERY_INVOCATIONS }
  from './call-observability-visitors.service';
import { ObservabilityCapabilitiesDto, ObservabilityEndpointCapabilityDto } from './call-observability-capabilities.dto';

function scopeMode(scope?: ObservabilityAuthorization): 'all' | 'scoped' | 'none' {
  return !scope ? 'none' : scope.runtimeAssetIds === null ? 'all' : scope.runtimeAssetIds.length ? 'scoped' : 'none';
}
function hasScope(scope?: ObservabilityAuthorization): boolean { return scopeMode(scope) !== 'none'; }

@Injectable()
export class CallObservabilityCapabilitiesService {
  constructor(private readonly store: CallObservabilityStore) {}

  async get(raw: Record<string, unknown>, user: User) {
    parseObservabilityQuery(raw, []);
    const read = authorizeObservability(user);
    const optional = (permission: ObservabilityPermission): ObservabilityAuthorization | undefined => {
      try { return authorizeObservability(user, [permission]); }
      catch (error) {
        if (error instanceof ObservabilityApiError && error.code === 'FORBIDDEN') return undefined;
        throw error;
      }
    };
    const payload = optional('monitoring:payload:read'), source = optional('monitoring:source:read');
    const manage = optional('monitoring:manage');
    const featureInputs: Array<{ name: string; implemented: boolean; grant?: ObservabilityAuthorization }> = [
      { name: 'capabilities', implemented: true, grant: read },
      { name: 'invocationQueries', implemented: true, grant: read },
      { name: 'traceQuery', implemented: true, grant: read },
      { name: 'callerQueries', implemented: true, grant: read },
      { name: 'sourceQuery', implemented: true, grant: read },
      { name: 'payloadRead', implemented: true, grant: payload },
      { name: 'sourceIpRead', implemented: true, grant: source },
      { name: 'callerProfileUpdate', implemented: true, grant: manage },
      { name: 'statistics', implemented: true, grant: read },
      ...['overview', 'statisticsTimeSeries', 'statisticsGroups', 'dependencies', 'serverStatus', 'eventHistory', 'webhook',
        'socketPush', 'pipelineStatus', 'policyManagement'].map(name => ({ name, implemented: false })),
    ];
    const features = featureInputs.map(feature => ({
      name: feature.name, state: !feature.implemented ? 'not_implemented'
        : feature.name === 'capabilities' || hasScope(feature.grant) ? 'enabled' : 'restricted',
      scopeMode: feature.implemented ? scopeMode(feature.grant) : null,
    }));
    const endpoints: ObservabilityEndpointCapabilityDto[] = [];
    const endpoint = (endpointId: string, operationId: string, method: string, path: string,
      query: readonly string[], authorization: ObservabilityAuthorization | undefined,
      rule = 'per_asset') => {
      if (rule !== 'capability_only' && !hasScope(authorization)) return;
      endpoints.push({ endpointId, operationId, method, path: '/api/v1/monitoring/observability' + path,
        queryParameters: [...query], requiredPermissions: [...authorization!.requiredPermissions],
        scopeMode: scopeMode(authorization), authorizationRule: rule });
    };
    endpoint('OBS-API-01', 'obsGetCapabilities', 'GET', '/capabilities', [], read, 'capability_only');
    endpoint('OBS-API-03', 'obsListInvocations', 'GET', '/invocations', INVOCATION_QUERY_KEYS, read);
    endpoint('OBS-API-04', 'obsGetInvocation', 'GET', '/invocations/{id}', ['timeBasis'], read);
    endpoint('OBS-API-05', 'obsGetInvocationPayload', 'GET', '/invocations/{id}/payloads/{side}', [], payload);
    endpoint('OBS-API-06', 'obsGetTrace', 'GET', '/traces/{traceId}', ['origin'], read);
    endpoint('OBS-API-07', 'obsListCallers', 'GET', '/callers', CALLER_QUERY_KEYS, read);
    endpoint('OBS-API-08', 'obsGetCaller', 'GET', '/callers/{id}', CALLER_DETAIL_QUERY_KEYS, read);
    endpoint('OBS-API-09', 'obsUpdateCallerLabels', 'PATCH', '/callers/{id}', [], manage, 'all_registered_caller_assets');
    endpoint('OBS-API-10', 'obsListSources', 'GET', '/sources', SOURCE_QUERY_KEYS, read);
    endpoint('OBS-API-11', 'obsGetStatisticsSummary', 'GET', '/statistics/summary', STATISTICS_SUMMARY_QUERY_KEYS, read);
    const day = 86400000;
    const data: ObservabilityCapabilitiesDto = {
      availabilitySemantics: 'implementation_and_scope_eligibility_not_runtime_health',
      resourceScope: scopeMode(read), schemaVersions: { sourceRecords: 2, http: '1.0' },
      endpoints, features, enabledFeatures: features.filter(feature => feature.state === 'enabled').map(feature => feature.name),
      // Validation primitives and stored events do not make an aggregation or event API available.
      supportedScopes: hasScope(read) ? [...STATISTICS_SCOPES] : [], supportedGroupByCombinations: [], maxBuckets: null,
      errorCategories: ['timeout', 'dns', 'tls', 'connection', 'cancelled', 'response_parse', 'authorization', 'other'],
      errorCategoryMode: 'suggested_values_free_text_filter',
      byteMeasurements: ['observed_body', 'serialized_payload', 'unavailable'],
      maxLimit: 200, defaultLimit: 50, maxQueryRange: 30 * day, defaultQueryWindowMs: 3600000,
      traceMaxNodes: MAX_TRACE_NODES, maxVisitorQueryInvocations: MAX_VISITOR_QUERY_INVOCATIONS,
      maxStatisticsQueryInvocations: MAX_METRIC_OBSERVATIONS, maxQueryCursorLifetimeMs: 900000,
      retentionWindows: { basis: 'storage_defaults_not_coverage_guarantees',
        invocationMetadataDefaultMs: 30 * day, payloadDefaultMs: hasScope(payload) ? 7 * day : null,
        aggregateRetentionMs: null, effectiveHistoryCompleteSince: null },
      payloadLimits: hasScope(payload) ? { readObjectMaxBytes: 128 * 1024 * 1024, effectiveCaptureBytes: null,
        capturePolicyState: 'not_reported_by_producers', readLimitScope: 'single_stored_object_not_total_http_memory' } : null,
      eventRetention: null, observationHealth: 'unknown',
    };
    // A genuine read snapshot, not a health check, source scan, or policy mutation.
    return this.store.readSnapshot(async tx => observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq,
      dataWatermark: tx.snapshotSeq, lagMs: null, historyCompleteSince: null, isPartial: true }));
  }
}
