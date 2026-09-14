'use strict';
const path = require('node:path');
const Module = require('node:module');
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
// Force every Server import to use the current Parser sources without rebuilding shared dist.
const resolve = Module._resolveFilename;
const parserSource = path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
Module._resolveFilename = function(name, ...rest) {
  return name === 'api-nova-parser' ? parserSource : resolve.call(this, name, ...rest);
};
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios').default;
const { Transformer } = require('../src/core/Transformer.ts');
const { transformOpenApiToMcpTools } = require('../src/transform/transformOpenApiToMcpTools.ts');
const { withRuntimeCallContext } = require('../../api-nova-parser/src/audit/runtime-call-audit.ts');
const agents = require('../../api-nova-parser/src/audit/runtime-http-agent.ts');
Module._resolveFilename = resolve;
const spec = () => ({ openapi: '3.0.3', info: { title: 'trusted fixture', version: '1' },
  servers: [{ url: 'https://fixture.invalid' }], paths: { '/items': { get: { operationId: 'items',
    'x-endpoint-definition-id': 'untrusted-endpoint', 'x-source-service-asset-id': 'untrusted-asset',
    responses: { '200': { description: 'ok' } } } } } });
const binding = () => ({ method: 'GET', path: '/items', endpointDefinitionId: 'trusted-endpoint', sourceServiceAssetId: 'trusted-asset' });
const context = { transport: 'mcp', requestId: 'server-mapping', identitySource: 'anonymous' };
async function fixture(t) {
  const oldAdapter = axios.defaults.adapter, oldAgents = agents.createRuntimeHttpAuditAgents;
  const oldLog = console.log, oldWarn = console.warn, oldError = console.error;
  const sent = [], identities = [];
  console.log = console.warn = console.error = () => {};
  axios.defaults.adapter = async config => { sent.push(config); return { config, status: 200, statusText: 'OK', headers: {}, data: { ok: true } }; };
  agents.createRuntimeHttpAuditAgents = (identity, names) => { identities.push(identity); return oldAgents(identity, names); };
  t.after(() => { axios.defaults.adapter = oldAdapter; agents.createRuntimeHttpAuditAgents = oldAgents;
    console.log = oldLog; console.warn = oldWarn; console.error = oldError; });
  return { sent, identities };
}

test('Server Transformer.transformFromSpec passes a trusted copied binding into its real Parser handler', async t => {
  const f = await fixture(t), input = binding();
  const [tool] = await new Transformer().transformFromSpec(spec(), { trustedOperationBindings: [input] });
  input.endpointDefinitionId = 'mutated-after-transform';
  await withRuntimeCallContext(context, () => tool.handler({ endpointDefinitionId: 'spoofed', sourceServiceAssetId: 'spoofed' }));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, 'https://fixture.invalid/items');
  assert.equal(f.sent[0].maxRedirects, 5);
  assert.equal(f.identities[0].endpointDefinitionId, 'trusted-endpoint'); assert.equal(f.identities[0].sourceServiceAssetId, 'trusted-asset');
});

test('legacy Server conversion function accepts only explicit programmatic binding argument', async t => {
  const f = await fixture(t);
  const [tool] = await transformOpenApiToMcpTools(undefined, undefined, spec(), undefined, undefined, false, undefined, undefined, [binding()]);
  await withRuntimeCallContext(context, () => tool.handler({ endpointDefinitionId: 'spoofed' }));
  assert.equal(f.identities[0].endpointDefinitionId, 'trusted-endpoint'); assert.equal(f.sent.length, 1);
});

test('Server main entry rejects missing registry identities before send while unmapped legacy entry still works', async t => {
  const f = await fixture(t), transformer = new Transformer();
  await assert.rejects(transformer.transformFromSpec(spec(), { trustedOperationBindings: [] }), /MISSING_TRUSTED_OPERATION_BINDING/);
  assert.equal(f.sent.length, 0);
  const [tool] = await transformer.transformFromSpec(spec());
  await withRuntimeCallContext(context, () => tool.handler({}));
  assert.equal(f.sent.length, 1); assert.equal(f.identities[0].endpointDefinitionId, 'untrusted-endpoint');
});

test('Server main and conversion entry forward explicit single-hop policy and fail closed on snapshot failure', async t => {
  const f = await fixture(t);
  const { validateUpstreamCredentialBindings } = require('../../api-nova-parser/src/credentials/schema.ts');
  const candidate = validateUpstreamCredentialBindings({
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision: 'server-fixture', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: {}, credentials: {}, sites: [{ id: 'site', sourceServiceAssetId: 'trusted-asset',
      match: { scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' }, allowedHosts: ['fixture.invalid'], credential: 'none' }],
  });
  let captures = 0;
  const policy = { mode: 'single-hop', captureSnapshot: () => { captures++; return Object.freeze({ generation: 1, candidate, resolveSecret: async () => { throw Error('should-not-resolve'); } }); } };
  const [main] = await new Transformer().transformFromSpec(spec(), { trustedOperationBindings: [binding()], upstreamCredentialPolicy: policy });
  assert.equal(JSON.parse(await main.handler({})).isError, false);
  const [conversion] = await transformOpenApiToMcpTools(undefined, undefined, spec(), undefined, undefined, false, undefined, undefined, [binding()], policy);
  assert.notEqual((await conversion.handler({})).isError, true);
  assert.equal(captures, 2); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(config => config.maxRedirects === 0));
  const [failure] = await new Transformer().transformFromSpec(spec(), { trustedOperationBindings: [binding()], upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot: () => { throw Error('synthetic-private-detail'); } } });
  const result = await failure.handler({});
  assert.equal(JSON.parse(result).isError, true); assert.equal(f.sent.length, 2);
  assert.ok(!JSON.stringify(result).includes('synthetic-private-detail'));
});