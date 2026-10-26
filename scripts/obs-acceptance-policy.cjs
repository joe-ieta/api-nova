'use strict';
// Timing remains visible; only explicit strict benchmarking makes it a gate.
function assessObservabilityAcceptance(evidence, { enforceTimingGates = false } = {}) {
  const load = evidence.load || {}, visibility = evidence.visibility || {}, delivery = evidence.delivery || {};
  const source = evidence.sourceIntegrity || {}, health = evidence.producerFlushed?.health || {};
  const expected = load.expectedAttempts;
  const queries = evidence.queries || [];
  const checks = {
    formalCohort: load.smoke === false && load.requestsPerSecond === 100 && load.durationSeconds === 30 && expected === 3000,
    measurementCompleted: evidence.measurementComplete === true && !evidence.error && !evidence.producerFlushError,
    completeSuccessfulResponses: Number.isSafeInteger(expected) && expected > 0 && load.allAttemptsRecorded === true &&
      load.successRequestIdsUnique === true && load.successful === expected && load.failed === 0,
    completeTerminalVisibility: visibility.expected === expected && visibility.observed === expected && visibility.censored === 0,
    completeSignedDelivery: delivery.expected === expected && delivery.received === expected && delivery.censored === 0 &&
      evidence.receiverIntegrity?.allSignaturesValid === true && evidence.receiverIntegrity?.allEventsParsed === true,
    completeQueryCapacity: evidence.queryCapacity?.gatewayInvocations === expected && evidence.queryCapacity?.partialBacklog === false &&
      ['detail', 'list', 'summary'].every(name => queries.some(query => query.name === name && query.count >= 20 && query.correctnessPassed === true)),
    sourceIntegrity: source.successfulGatewayExpected === expected && source.successfulGatewayTerminalRecords === expected &&
      ['parseFailures', 'missingWithinObservedSequenceRange', 'missingThroughProducerSequence', 'duplicateSequences'].every(key => source[key] === 0),
    producerIntegrity: Number.isSafeInteger(health.currentSourceSequence) && health.currentSourceSequence > 0 &&
      ['droppedRecords', 'writeFailures', 'sourceManifestFailures', 'ioFailedRecords', 'callerWriteFailures', 'omittedBodies', 'activeCalls', 'pendingWrites'].every(key => health[key] === 0),
    cleanShutdown: evidence.gracefulShutdown === true && evidence.apiExit?.code === 0 && evidence.apiExit?.signal === null &&
      ['api', 'mcp', 'upstreamA', 'upstreamB', 'receiver'].every(key => evidence.cleanup?.[key] === true) &&
      (evidence.database?.type !== 'postgres' || evidence.postgresStopped === true),
  };
  const timingDiagnostics = {
    loadScheduling: load.scheduleWithinTolerance === true,
    visibility: visibility.pass === true,
    delivery: delivery.pass === true,
    queries: ['detail', 'list', 'summary'].every(name => queries.some(query => query.name === name && query.pass === true)),
  };
  const functionalAcceptancePassed = Object.values(checks).every(Boolean);
  const timingTargetsPassed = Object.values(timingDiagnostics).every(Boolean);
  return {
    acceptancePolicy: { timing: enforceTimingGates ? 'enforced-benchmark' : 'diagnostic-only',
      basis: 'User decision: timing thresholds do not independently block work-package closure; correctness remains required.' },
    functionalChecks: checks, timingDiagnostics, functionalAcceptancePassed, timingTargetsPassed,
    // Retain the old field as the strict benchmark result, never relabel a miss.
    thresholdsPassed: functionalAcceptancePassed && timingTargetsPassed,
    acceptancePassed: functionalAcceptancePassed && (!enforceTimingGates || timingTargetsPassed),
  };
}
module.exports = { assessObservabilityAcceptance };
