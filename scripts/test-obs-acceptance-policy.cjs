'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessObservabilityAcceptance: assess } = require('./obs-acceptance-policy.cjs');
function complete() {
  return { measurementComplete: true, database: { type: 'postgres' },
    load: { smoke: false, requestsPerSecond: 100, durationSeconds: 30, expectedAttempts: 3000, allAttemptsRecorded: true, successRequestIdsUnique: true, successful: 3000, failed: 0, scheduleWithinTolerance: false },
    visibility: { expected: 3000, observed: 3000, censored: 0, pass: false },
    delivery: { expected: 3000, received: 3000, censored: 0, pass: false },
    receiverIntegrity: { allSignaturesValid: true, allEventsParsed: true },
    queries: ['detail', 'list', 'summary'].map(name => ({ name, count: 20, correctnessPassed: true, pass: false })),
    queryCapacity: { gatewayInvocations: 3000, partialBacklog: false },
    sourceIntegrity: { successfulGatewayExpected: 3000, successfulGatewayTerminalRecords: 3000,
      parseFailures: 0, missingWithinObservedSequenceRange: 0, missingThroughProducerSequence: 0, duplicateSequences: 0 },
    producerFlushed: { health: { currentSourceSequence: 15000, droppedRecords: 0, writeFailures: 0, sourceManifestFailures: 0,
      ioFailedRecords: 0, callerWriteFailures: 0, omittedBodies: 0, activeCalls: 0, pendingWrites: 0 } },
    apiExit: { code: 0, signal: null }, gracefulShutdown: true, postgresStopped: true,
    cleanup: { api: true, mcp: true, upstreamA: true, upstreamB: true, receiver: true } };
}
test('a complete slow run passes functional acceptance while preserving missed timing targets', () => {
  const result = assess(complete());
  assert.equal(result.acceptancePassed, true); assert.equal(result.functionalAcceptancePassed, true);
  assert.equal(result.timingTargetsPassed, false); assert.equal(result.thresholdsPassed, false);
  assert.equal(assess(complete(), { enforceTimingGates: true }).acceptancePassed, false);
});
test('censored observations, incomplete deliveries and partial query capacity cannot pass', () => {
  for (const alter of [e => { e.visibility.observed--; e.visibility.censored++; },
    e => { e.delivery.received--; e.delivery.censored++; }, e => { e.queryCapacity.partialBacklog = true; },
    e => { e.queryCapacity.gatewayInvocations--; }, e => { e.queries.pop(); }]) {
    const evidence = complete(); alter(evidence); assert.equal(assess(evidence).acceptancePassed, false);
  }
});
test('source gaps, producer loss, omitted bodies and invalid signatures remain blocking', () => {
  for (const alter of [e => e.sourceIntegrity.missingThroughProducerSequence++, e => e.sourceIntegrity.parseFailures++,
    e => e.sourceIntegrity.duplicateSequences++, e => e.producerFlushed.health.callerWriteFailures++,
    e => e.producerFlushed.health.omittedBodies++, e => { e.receiverIntegrity.allSignaturesValid = false; }]) {
    const evidence = complete(); alter(evidence); assert.equal(assess(evidence).acceptancePassed, false);
  }
});
test('missing evidence, unsuccessful responses and unclean shutdown never become a diagnostic pass', () => {
  assert.equal(assess({}).acceptancePassed, false);
  for (const alter of [e => { delete e.producerFlushed; }, e => { e.load.failed = 1; },
    e => { e.gracefulShutdown = false; }, e => { e.postgresStopped = false; },
    e => { e.queries[0].correctnessPassed = false; }, e => { e.load.smoke = true; }, e => { e.load.durationSeconds = 10; }, e => { e.apiExit.code = 1; }, e => { e.cleanup.api = false; }, e => { e.error = 'request timeout'; }]) {
    const evidence = complete(); alter(evidence); assert.equal(assess(evidence).acceptancePassed, false);
  }
});
