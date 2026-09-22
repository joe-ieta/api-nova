import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { captureManagedHandoff, ManagedMcpHandoffV1 } from 'api-nova-server';
import { parseUpstreamCredentialBindings, readStableUpstreamCredentialText } from 'api-nova-parser';
import { MCPServerEntity, McpInboundAuthMode } from '../../../database/entities/mcp-server.entity';
import { RuntimeVerificationRunEntity } from '../../../database/entities/runtime-verification-run.entity';
import { RuntimeUpstreamBindingEntity } from '../../../database/entities/runtime-upstream-binding.entity';
import { readMcpOwnership } from '../../runtime-assets/services/mcp-ownership-reader';
import { createMcpTrustedOperationBindings } from '../../runtime-assets/services/mcp-trusted-operation-bindings';
import { resolveMcpEndpoint } from '../../runtime-assets/services/mcp-endpoint-config';
import { buildManagedEnvironment, startManagedMcpChannel } from './managed-mcp-channel';

export const MANAGED_MCP_SOURCES_CONFIG_KEY = 'managedMcp.handoffSources';
export const MANAGED_MCP_PREPARATION_REJECTED = 'MANAGED_MCP_PREPARATION_REJECTED';
interface SourceConfiguration {
  registrySource: ManagedMcpHandoffV1['registrySource'];
  approvedEnvironmentNames: string[];
}
const reject = (): never => { throw new Error(MANAGED_MCP_PREPARATION_REJECTED); };
function canonical(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const serialized = (value: unknown) => JSON.stringify(canonical(value));
/** Bounded data-only capture: never execute host configuration getters/toJSON. */
function data(value: unknown, depth = 0, budget = { nodes: 0, characters: 0 }): any {
  if (depth > 12 || ++budget.nodes > 2048) return reject();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (budget.characters += value.length) > 65536) return reject();
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return reject();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) return reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1001) return reject();
  const result: any = Array.isArray(value) ? [] : Object.create(null);
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) return reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return reject();
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return reject();
    result[key] = data(descriptor.value, depth + 1, budget);
  }
  return result;
}
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys.sort().join('|')) reject();
}

/** Internal preparation only. The caller must already authorize these IDs.
 * No lifecycle/controller calls this service. A DB snapshot is rechecked after
 * file I/O; this is not a cross-process activation lease or a revocation system.
 */
@Injectable()
export class ManagedMcpHandoffPreparationService {
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}

  private source(runtimeAssetId: string): SourceConfiguration {
    const sources = data(this.config.get(MANAGED_MCP_SOURCES_CONFIG_KEY));
    if (Buffer.byteLength(JSON.stringify(sources), 'utf8') > 65536 || Array.isArray(sources) || !Object.prototype.hasOwnProperty.call(sources, runtimeAssetId)) reject();
    const source = sources[runtimeAssetId];
    exact(source, ['registrySource', 'approvedEnvironmentNames']);
    exact(source.registrySource, ['configId', 'path', 'format', 'environment', 'expectedRevision', 'expectedContentDigest']);
    const registry = source.registrySource;
    if (typeof registry.path !== 'string' || !isAbsolute(registry.path) || !['json', 'yaml'].includes(registry.format) ||
      typeof registry.expectedContentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(registry.expectedContentDigest) ||
      !Array.isArray(source.approvedEnvironmentNames) || source.approvedEnvironmentNames.length > 128) reject();
    for (const key of ['configId', 'environment', 'expectedRevision']) if (typeof registry[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(registry[key])) reject();
    return source;
  }

  private async snapshot(runtimeAssetId: string, serverId: string) {
    const isolation = ['postgres', 'mysql', 'mariadb'].includes(this.db.options.type) ? 'REPEATABLE READ' : 'SERIALIZABLE';
    return this.db.transaction(isolation, async manager => {
      const ownership = await readMcpOwnership(manager, runtimeAssetId);
      const server = await manager.getRepository(MCPServerEntity).findOne({ where: { id: serverId } });
      if (!ownership || !server || ownership.asset.type !== 'mcp_server' ||
        server.inboundAuthMode !== McpInboundAuthMode.PRIVATE_API_KEY) return reject();
      const { asset, rows } = ownership;
      const metadata = asset.metadata || {}, config = server.config || {};
      if (metadata.managedServerId !== serverId || config.runtimeAssetId !== runtimeAssetId || config.managedByRuntimeAsset !== true ||
        metadata.verificationRequired !== false || !['stopped', 'error'].includes(server.status) ||
        typeof config.verificationRunId !== 'string' || !config.verificationRunId || typeof config.verifiedCandidateRevision !== 'string' || !config.verifiedCandidateRevision) reject();
      const run = await manager.getRepository(RuntimeVerificationRunEntity).findOne({ where: { id: config.verificationRunId } });
      const fingerprint = digest(serialized(server.openApiData));
      if (!run || run.runtimeAssetId !== runtimeAssetId || run.status !== 'passed' || run.activationStatus !== 'activated' ||
        run.candidateRevision !== config.verifiedCandidateRevision || metadata.activeRevision !== run.candidateRevision || metadata.lastVerificationRunId !== run.id ||
        config.behaviorFingerprint !== fingerprint || metadata.activeMcpBehaviorFingerprint !== fingerprint || run.metadata?.behaviorFingerprint !== fingerprint) return reject();
      const endpoint = resolveMcpEndpoint({}, server);
      if (serialized(endpoint) !== serialized(run.metadata?.mcpEndpointConfig)) reject();
      const selected = rows.filter(row => row.membership.enabled && row.publishBinding && (row.publishBinding.publishedToMcp || row.publishBinding.publishStatus === 'active'));
      if (!selected.length) reject();
      const bindings = createMcpTrustedOperationBindings(asset, selected.map(row => {
        if (!row.endpointDefinition || !row.sourceServiceAsset || row.publishBinding!.endpointDefinitionId !== row.endpointDefinition.id ||
          (row.profile && row.profile.endpointDefinitionId !== row.endpointDefinition.id)) return reject();
        return { membership: row.membership, endpoint: row.endpointDefinition, sourceAsset: row.sourceServiceAsset };
      }), server.openApiData);
      const revisions = run.upstreamBindingRevisions;
      if (!Array.isArray(revisions) || revisions.length !== selected.length) return reject();
      const seen = new Set<string>(), seenBindings = new Set<string>(), upstream: RuntimeUpstreamBindingEntity[] = [];
      for (const expected of revisions) {
        if (!expected || typeof expected.bindingId !== 'string' || !expected.bindingId || typeof expected.runtimeMembershipId !== 'string' ||
          !expected.runtimeMembershipId || !Number.isSafeInteger(expected.revision) || expected.revision < 1 || seen.has(expected.runtimeMembershipId) || seenBindings.has(expected.bindingId)) reject();
        const row = selected.find(item => item.membership.id === expected.runtimeMembershipId);
        const binding = await manager.getRepository(RuntimeUpstreamBindingEntity).findOne({ where: { id: expected.bindingId } });
        if (!row || !binding || binding.runtimeAssetEndpointBindingId !== row.membership.id || binding.sourceServiceAssetId !== row.sourceServiceAsset!.id || binding.status !== 'active' || binding.revision !== expected.revision) reject();
        seen.add(expected.runtimeMembershipId); seenBindings.add(expected.bindingId); upstream.push(binding!);
      }
      // Capture every row value too, so drift during the file read cannot be hidden
      // by an unchanged revision. No entity/secret is returned to a controller.
      return { server, run, ownership, upstream, bindings, endpoint, fingerprint };
    });
  }

  private async capture(runtimeAssetId: string, serverId: string) {
    try {
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (!uuid.test(runtimeAssetId) || !uuid.test(serverId)) reject();
      const source = this.source(runtimeAssetId);
      const environmentValues: Record<string, string> = {};
      for (const name of source.approvedEnvironmentNames) {
        if (typeof name !== 'string') reject();
        const value = this.config.get<unknown>(name);
        if (typeof value !== 'string') reject();
        environmentValues[name] = value as string;
      }
      buildManagedEnvironment(source.approvedEnvironmentNames, environmentValues);
      if (environmentValues.API_NOVA_RUNTIME_AUTH_MODE !== 'api_key') reject();
      const first = await this.snapshot(runtimeAssetId, serverId);
      const text = await readStableUpstreamCredentialText(source.registrySource.path);
      const candidate = parseUpstreamCredentialBindings(text, source.registrySource.format);
      // Digest is explicitly SHA256 of stable decoded UTF-8 text (not a second
      // file read). B2 must use the same decoder/digest on its own stable read.
      if (digest(text) !== source.registrySource.expectedContentDigest || candidate.metadata.revision !== source.registrySource.expectedRevision ||
        candidate.metadata.environment !== source.registrySource.environment) reject();
      const sources = new Set(first.bindings.map(binding => binding.sourceServiceAssetId));
      if ([...sources].some(id => !candidate.sites.some(site => site.sourceServiceAssetId === id))) reject();
      for (const site of candidate.sites) {
        if (!sources.has(site.sourceServiceAssetId)) reject();
        for (const endpoint of site.endpoints) if ('endpointDefinitionId' in endpoint && !first.bindings.some(binding => binding.endpointDefinitionId === endpoint.endpointDefinitionId && binding.sourceServiceAssetId === site.sourceServiceAssetId)) reject();
      }
      for (const credential of Object.values(candidate.credentials)) {
        const references = credential.type === 'basic' ? [credential.usernameRef, credential.passwordRef] : [credential.secretRef];
        for (const reference of references) {
          const separator = reference.indexOf(':');
          const provider = reference.slice(0, separator), key = reference.slice(separator + 1);
          if (candidate.secretProviders[provider].type === 'env' && !source.approvedEnvironmentNames.includes(key)) reject();
        }
      }
      const second = await this.snapshot(runtimeAssetId, serverId);
      if (serialized(first) !== serialized(second) || serialized(source) !== serialized(this.source(runtimeAssetId))) reject();
      const payload = captureManagedHandoff({ version: 1, launchId: randomUUID(), managedServerId: serverId, runtimeAssetId,
        inboundAuthMode: second.server.inboundAuthMode!,
        candidateRevision: second.run.candidateRevision, verificationRunId: second.run.id, behaviorFingerprint: second.fingerprint,
        transport: { type: second.endpoint.transport, host: '127.0.0.1', port: second.endpoint.port, endpoint: second.endpoint.endpointPath },
        openApiData: second.server.openApiData, trustedOperationBindings: second.bindings, registrySource: source.registrySource });
      return { payload, approvedEnvironmentNames: source.approvedEnvironmentNames, environmentValues };
    } catch { return reject(); }
  }

  /** Internal data-only envelope; business environment values never enter it. */
  async prepare(runtimeAssetId: string, serverId: string): Promise<ManagedMcpHandoffV1> {
    return (await this.capture(runtimeAssetId, serverId)).payload;
  }

  /** Explicit internal experiment only: ACK is not readiness; await handle.ready.
   * No production lifecycle integration. */
  async startInternal(runtimeAssetId: string, serverId: string) {
    const captured = await this.capture(runtimeAssetId, serverId);
    return startManagedMcpChannel({ ...captured, launchId: captured.payload.launchId, serverId });
  }
}
