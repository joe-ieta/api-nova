import { types } from 'node:util';
import { DataSource } from 'typeorm';
import { UpstreamCredentialRegistry, type RegistryProviderEvidence, type UpstreamCredentialRegistrySnapshot, type UpstreamCredentialBindingsCandidate } from 'api-nova-parser';
import { GatewayHeaderHistoryLedgerService } from '../../../database/gateway-header-history-ledger.service';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { validateGatewayCredentialOwnership } from './gateway-upstream-credential-ownership';
import { GATEWAY_HEADER_HISTORY_NAMESPACE, GATEWAY_HEADER_HISTORY_PROVENANCE } from './gateway-upstream-credential.providers';
import { consumeGatewayHostCredentialGenerationIssuer, resolveGatewayHostCredentialGenerationCapability, type GatewayHostCredentialGenerationCapability } from './gateway-host-credential-generation.capability';

export interface GatewayHostCandidateAttestation { readonly kind: 'gateway-host-candidate-attestation' }
export interface GatewayHostCredentialRegistry {
  captureSnapshot(): UpstreamCredentialRegistrySnapshot;
  issueProof(source: string, ttlMs?: number): object;
  consumeProof(proof: object, source: string, expectedEpoch: string): Readonly<{ expiresAt: number }>;
  readEpoch(source: string): string;
  readSignal(source: string): AbortSignal;
  close(): void;
  onModuleDestroy(): void;
}
const hosts = new WeakMap<object, () => void>();
/** Runtime brand; copying methods never transfers the private host capability. */
export function assertGatewayHostCredentialRegistry(value: unknown): asserts value is GatewayHostCredentialRegistry {
  const check = value && typeof value === 'object' ? hosts.get(value) : undefined;
  if (!check) return fail();
  check();
}
type Candidate = { capability: GatewayHostCredentialGenerationCapability; text: string; format: 'json' | 'yaml'; environment: string; expectedGeneration: string };
const attestations = new WeakMap<object, Candidate>();
const fail = (): never => { throw new Error('gateway_host_credential_registry_unavailable'); };
/** Host-only synchronous attestation. No HTTP, config-file or request adapter may mint this. */
export function attestGatewayHostCredentialCandidate(input: Candidate): GatewayHostCandidateAttestation {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail();
  const fields = ['capability', 'text', 'format', 'environment', 'expectedGeneration'];
  if (Reflect.ownKeys(input).length !== fields.length) return fail();
  const values: any = {};
  for (const name of fields) { const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) return fail(); values[name] = descriptor.value; }
  if (!resolveGatewayHostCredentialGenerationCapability(values.capability) || typeof values.text !== 'string' || !values.text || Buffer.byteLength(values.text) > 8 * 1024 * 1024 ||
      !['json', 'yaml'].includes(values.format) || typeof values.environment !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(values.environment) ||
      typeof values.expectedGeneration !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(values.expectedGeneration)) return fail();
  const token = Object.freeze({ kind: 'gateway-host-candidate-attestation' as const }); attestations.set(token, Object.freeze(values)); return token;
}

/** Private boot composition only. Never returns the mutable Registry or an issuer. */
export async function createGatewayHostCredentialRegistry(token: GatewayHostCandidateAttestation, database: DataSource): Promise<GatewayHostCredentialRegistry> {
  const candidate = token && typeof token === 'object' ? attestations.get(token) : undefined;
  if (!candidate) return fail(); attestations.delete(token);
  let issuer: RegistryProviderEvidence | undefined, registry: UpstreamCredentialRegistry | undefined;
  try {
    issuer = consumeGatewayHostCredentialGenerationIssuer(candidate.capability);
    if (!database?.isInitialized) return fail();
    // SQL.js history CAS shares its live connection with external transactions.
    // A pre-await transaction check cannot prove durability; this boot is disabled.
    if (database.options.type !== 'postgres') return fail();
    const ledger = new GatewayHeaderHistoryLedgerService(database).asStore(GATEWAY_HEADER_HISTORY_NAMESPACE, GATEWAY_HEADER_HISTORY_PROVENANCE);
    const check = () => {
      if (!resolveGatewayHostCredentialGenerationCapability(candidate.capability)) return fail();
      if (database.options.type === 'sqljs' && database.createQueryRunner().isTransactionActive) return fail();
    };
    registry = new UpstreamCredentialRegistry({ environment: candidate.environment, providerEvidence: issuer,
      credentialHeaderHistory: { namespace: GATEWAY_HEADER_HISTORY_NAMESPACE, store: {
        load: async namespace => { check(); return ledger.load(namespace); },
        commit: async (namespace, version, names) => { check(); return ledger.commit(namespace, version, names); },
      } }, validateCandidateOwnership: value => validateGatewayHostCandidateOwnership(database, value) });
    const snapshot = await registry.reloadText(candidate.text, candidate.format);
    const sources = [...new Set(snapshot.candidate.sites.map(site => site.sourceServiceAssetId))];
    if (!sources.length) return fail();
    const evidence = issuer;
    const assertSource = (source: string) => {
      check(); if (!sources.includes(source) || evidence.readEpoch(snapshot, source) !== candidate.expectedGeneration || evidence.readSignal(snapshot, source).aborted) return fail();
    };
    for (const source of sources) assertSource(source);
    let closed = false;
    const assertOpen = () => { if (closed) return fail(); for (const source of sources) assertSource(source); };
    const close = () => { if (closed) return; closed = true; registry!.onModuleDestroy(); evidence.close(); };
    const host: GatewayHostCredentialRegistry = Object.freeze({
      captureSnapshot: () => { assertOpen(); return snapshot; },
      issueProof: (source: string, ttlMs?: number) => { assertOpen(); assertSource(source); return evidence.issue(snapshot, source, ttlMs); },
      consumeProof: (proof: object, source: string, expectedEpoch: string) => {
        assertOpen(); assertSource(source);
        const accepted = evidence.consume(proof, { snapshot, sourceServiceAssetId: source, providerEpoch: expectedEpoch });
        if (!accepted || expectedEpoch !== candidate.expectedGeneration) return fail();
        assertOpen(); return Object.freeze({ expiresAt: accepted.expiresAt });
      },
      readEpoch: (source: string) => { assertOpen(); assertSource(source); return evidence.readEpoch(snapshot, source); },
      readSignal: (source: string) => { assertOpen(); assertSource(source); return evidence.readSignal(snapshot, source); },
      close, onModuleDestroy: close,
    });
    hosts.set(host, assertOpen); return host;
  } catch { registry?.onModuleDestroy(); issuer?.close(); return fail(); }
}

/** Read isolation only. This helper provides no history-CAS durability or network authority. */
export async function validateGatewayHostCandidateOwnership(database: DataSource, candidate: UpstreamCredentialBindingsCandidate): Promise<void> {
  if (!database?.isInitialized) return fail();
  if (database.options.type === 'postgres') return validateGatewayCredentialOwnership(database, candidate);
  if (database.options.type !== 'sqljs' || database.createQueryRunner().isTransactionActive) return fail();
  // No await before copying the committed view into a separate SQL.js engine.
  const bytes = (database.driver as unknown as { export(): Uint8Array }).export();
  const isolated = new DataSource({ type: 'sqljs', database: bytes, entities: [SourceServiceAssetEntity, EndpointDefinitionEntity], synchronize: false, autoSave: false });
  try {
    await isolated.initialize(); await isolated.query('PRAGMA query_only = ON');
    await validateGatewayCredentialOwnership(isolated, candidate);
  } finally { if (isolated.isInitialized) await isolated.destroy(); }
}
