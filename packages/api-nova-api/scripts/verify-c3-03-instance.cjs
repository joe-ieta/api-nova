'use strict';
// SEC-C3-03: one real API process for the multi-process coordination runner.
// Only started by verify-c3-03.cjs against its disposable PostgreSQL cluster.
process.env.DB_TYPE = 'postgres';
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const originalResolve = Module._resolveFilename;
const assetsDir = process.env.C3_ASSETS_DIR;
const parserEntry = path.resolve(__dirname, '../../api-nova-parser/src/index.ts');
Module._resolveFilename = function (name, ...rest) {
  if (name === 'api-nova-server') return path.join(assetsDir, 'handoff.js');
  if (name === 'api-nova-server/dist/managed/entry.js') return path.join(assetsDir, 'entry.js');
  if (name === 'api-nova-parser') return parserEntry;
  return originalResolve.call(this, name, ...rest);
};

require('reflect-metadata');
const { createHash } = require('node:crypto');
const { DataSource } = require('typeorm');

const load = (file, name) => require(`../src/database/entities/${file}.entity.ts`)[name];
const Asset = load('runtime-asset', 'RuntimeAssetEntity');
const Member = load('runtime-asset-endpoint-binding', 'RuntimeAssetEndpointBindingEntity');
const Endpoint = load('endpoint-definition', 'EndpointDefinitionEntity');
const Source = load('source-service-asset', 'SourceServiceAssetEntity');
const Profile = load('publication-profile', 'PublicationProfileEntity');
const Publish = load('endpoint-publish-binding', 'EndpointPublishBindingEntity');
const Server = load('mcp-server', 'MCPServerEntity');
const Run = load('runtime-verification-run', 'RuntimeVerificationRunEntity');
const Upstream = load('runtime-upstream-binding', 'RuntimeUpstreamBindingEntity');
const PipelineState = load('runtime-call-observability', 'RuntimePipelineStateEntity');

const { ManagedMcpHandoffPreparationService, MANAGED_MCP_SOURCES_CONFIG_KEY } = require('../src/modules/servers/services/managed-mcp-handoff-preparation.service.ts');
const { startManagedMcpChannel } = require('../src/modules/servers/services/managed-mcp-channel.ts');
const { DataSourceManagedMcpLifecycleStore } = require('../src/modules/servers/services/managed-mcp-lifecycle.store.ts');
const { MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY, createConfigManagedLifecycleApprovalProvider } = require('../src/modules/servers/services/managed-mcp-lifecycle-approval.ts');
const { ManagedMcpLifecycleCoordinator } = require('../src/modules/servers/services/managed-mcp-lifecycle-coordinator.service.ts');

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

const SERVER_ID = process.env.C3_SERVER_ID;
const ASSET_ID = process.env.C3_ASSET_ID;
const PORT = Number(process.env.C3_PORT);
const registryPath = process.env.C3_REGISTRY_PATH;
const configPath = process.env.C3_CONFIG_PATH;

const specFixture = { openapi: '3.0.3', info: { title: 'c3-03-fixture', version: '1' }, servers: [{ url: 'https://c3-fixture.invalid' }],
  paths: { '/items': { get: { operationId: 'items', responses: { '200': { description: 'OK' } } } } } };
const fingerprintFixture = hash(JSON.stringify(canonical(specFixture)));
const environmentValues = {
  API_NOVA_RUNTIME_AUTH_MODE: 'api_key',
  API_NOVA_MCP_RESOURCE: 'https://managed.example.invalid/mcp',
  API_NOVA_RUNTIME_API_KEYS: JSON.stringify([{ id: 'client-one', subject: 'synthetic-consumer', secretHash: hash('synthetic-client-key'),
    resources: ['https://managed.example.invalid/mcp'], scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 }]),
};

const config = {
  get(key) {
    if (key === MANAGED_MCP_SOURCES_CONFIG_KEY) return JSON.parse(fs.readFileSync(configPath, 'utf8')).sources;
    if (key === MANAGED_MCP_LIFECYCLE_APPROVAL_CONFIG_KEY) return JSON.parse(fs.readFileSync(configPath, 'utf8')).lifecycleApproval;
    return environmentValues[key];
  },
};

let db;
let coordinator;
let preparation;
let spawns = 0;
let gateActive = false;
let gateRelease = null;
let armedCapture = null;

async function seed() {
  await db.getRepository(Asset).save({ id: id(1), name: 'c3-03-fixture', type: 'mcp_server', metadata: { managedServerId: SERVER_ID,
    activeRevision: 'candidate1', lastVerificationRunId: id(6), activeMcpBehaviorFingerprint: fingerprintFixture, verificationRequired: false } });
  await db.getRepository(Source).save({ id: id(4), sourceKey: 'c3-03-fixture' });
  await db.getRepository(Endpoint).save({ id: id(3), sourceServiceAssetId: id(4), method: 'GET', path: '/items', rawOperation: specFixture.paths['/items'].get });
  await db.getRepository(Member).save({ id: id(2), runtimeAssetId: ASSET_ID, endpointDefinitionId: id(3), enabled: true });
  await db.getRepository(Publish).save({ id: id(8), endpointDefinitionId: id(3), runtimeAssetEndpointBindingId: id(2), publishedToMcp: true });
  await db.getRepository(Upstream).save({ id: id(7), runtimeAssetEndpointBindingId: id(2), sourceServiceAssetId: id(4), environment: 'test',
    selectionMode: 'fixed_primary', status: 'active', revision: 1 });
  await db.getRepository(Server).save({ id: SERVER_ID, name: 'c3-03-fixture', inboundAuthMode: 'private_api_key', openApiData: specFixture, port: PORT,
    transport: 'streamable', config: { endpoint: '/mcp', runtimeAssetId: ASSET_ID, managedByRuntimeAsset: true, verifiedCandidateRevision: 'candidate1',
      verificationRunId: id(6), behaviorFingerprint: fingerprintFixture, executionMode: 'trusted_ipc_v1' } });
  await db.getRepository(Run).save({ id: id(6), runtimeAssetId: ASSET_ID, candidateRevision: 'candidate1', trigger: 'deploy', status: 'passed',
    activationStatus: 'activated', metadata: { behaviorFingerprint: fingerprintFixture, mcpEndpointConfig: { transport: 'streamable', port: PORT, endpointPath: '/mcp' } },
    upstreamBindingRevisions: [{ runtimeMembershipId: id(2), bindingId: id(7), revision: 1 }] });
}

async function main() {
  db = await new DataSource({ type: 'postgres', host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD || '', database: process.env.DB_DATABASE,
    synchronize: process.env.C3_SYNCHRONIZE === 'true', logging: false,
    entities: [Asset, Member, Endpoint, Source, Profile, Publish, Server, Run, Upstream, PipelineState] }).initialize();
  if (process.env.C3_MODE === 'seed') {
    return process.send({ type: 'ready', pid: process.pid, mode: 'seed' });
  }
  preparation = new ManagedMcpHandoffPreparationService(db, config);
  const store = new DataSourceManagedMcpLifecycleStore(db);
  coordinator = new ManagedMcpLifecycleCoordinator({
    store,
    capture: async (runtimeAssetId, serverId) => {
      let captured;
      try {
        if (armedCapture) { captured = armedCapture; armedCapture = null; }
        else captured = await preparation.captureForManagedLifecycle(runtimeAssetId, serverId);
      } catch (error) {
        process.stderr.write('C3_CAPTURE_ERROR ' + (error?.stack || error) + '\n');
        throw error;
      }
      if (gateActive) {
        process.send({ type: 'gated' });
        await new Promise(resolve => { gateRelease = resolve; });
      }
      return captured;
    },
    approval: createConfigManagedLifecycleApprovalProvider(config),
    channel: async input => { spawns++; return startManagedMcpChannel(input); },
  });
  process.send({ type: 'ready', pid: process.pid, mode: 'instance' });
}

async function handle(message) {
  const { id: commandId, type } = message;
  let result;
  switch (type) {
    case 'seed': await seed(); result = { seeded: true }; break;
    case 'start': result = await coordinator.start({ serverId: SERVER_ID, runtimeAssetId: ASSET_ID }); break;
    case 'stop': result = await coordinator.stop(SERVER_ID); break;
    case 'status': result = { status: await coordinator.status(SERVER_ID), owner: coordinator.ownedGeneration(SERVER_ID), spawns }; break;
    case 'reconcile': result = await coordinator.reconcile(SERVER_ID); break;
    case 'event': result = await coordinator.event(SERVER_ID, { generation: message.generation, type: message.eventType, code: message.code }); break;
    case 'armCapture': armedCapture = await preparation.captureForManagedLifecycle(ASSET_ID, SERVER_ID);
      result = { launchId: armedCapture.payload.launchId, registryRevision: armedCapture.payload.registrySource.expectedRevision,
        registryContentDigest: armedCapture.payload.registrySource.expectedContentDigest }; break;
    case 'armGate': gateActive = true; gateRelease = null; result = { armed: true }; break;
    case 'releaseGate': gateActive = false; if (gateRelease) { const release = gateRelease; gateRelease = null; release(); } result = { released: true }; break;
    case 'close': if (coordinator) await coordinator.onModuleDestroy();
      if (db && db.isInitialized) await db.destroy(); result = { closed: true }; break;
    default: throw Object.assign(new Error('UNKNOWN_COMMAND'), { code: 'UNKNOWN_COMMAND' });
  }
  return result;
}

process.on('message', message => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  if (message.type === 'close') {
    void handle(message).then(
      result => process.send({ id: message.id, ok: true, result }, () => process.exit(0)),
      error => {
        process.send({ id: message.id, ok: false, error: { name: String(error?.name || 'Error'), code: error?.code ?? null, message: String(error?.message || error) } });
        process.exit(1);
      });
    return;
  }
  void handle(message).then(
    result => process.send({ id: message.id, ok: true, result }),
    error => process.send({ id: message.id, ok: false, error: { name: String(error?.name || 'Error'), code: error?.code ?? null, message: String(error?.message || error) } }));
});

main().catch(error => {
  process.send({ type: 'fatal', error: { message: String(error?.message || error), stack: String(error?.stack || '') } });
  process.exitCode = 1;
});
