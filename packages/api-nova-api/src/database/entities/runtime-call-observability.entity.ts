import { Check, Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { getJsonColumnOptions } from '../database-dialect';

// Current development schema. These tables do not import historical audit formats.

@Entity('runtime_invocations')
@Index('IDX_obs_invocations_1', ["runtimeAssetId","startedAt"])
@Index('IDX_obs_invocations_2', ["callerId","startedAt"])
@Index('IDX_obs_invocations_3', ["traceId"])
@Index('IDX_obs_invocations_4', ["parentInvocationId"])
@Index('IDX_obs_invocations_5', ["spanKind","outcome","startedAt"])
@Index('IDX_obs_invocations_6', ["endpointDefinitionId","startedAt"])
@Index('IDX_obs_invocations_7', ["expiresAt"])
@Index('IDX_obs_invocations_8', ["updatedSequence"])
export class RuntimeInvocationEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_invocations' })
  invocationId: string;

  @Column({ type: 'varchar', length: 500 })
  sourceInstanceId: string;

  @Column({ type: 'integer', default: 0 })
  sourceRecordVersion: number;

  @Column({ type: 'integer', default: 0 })
  recordVersion: number;

  @Column({ type: 'varchar', length: 64 })
  recordHash: string;

  @Column({ type: 'varchar', length: 20 })
  createdSequence: string;

  @Column({ type: 'varchar', length: 20 })
  updatedSequence: string;

  @Column({ type: 'text', nullable: true })
  traceId: string | null;

  @Column({ type: 'text', nullable: true })
  parentInvocationId: string | null;

  @Column({ type: 'text', nullable: true })
  runtimeAssetId: string | null;

  @Column({ type: 'varchar', length: 500 })
  serverType: string;

  @Column({ type: 'varchar', length: 500 })
  spanKind: string;

  @Column({ type: 'varchar', length: 500 })
  origin: string;

  @Column({ type: 'text', nullable: true })
  callerId: string | null;

  @Column({ type: 'text', nullable: true })
  sourceId: string | null;

  @Column({ type: 'text', nullable: true })
  endpointDefinitionId: string | null;

  @Column({ type: 'text', nullable: true })
  sourceServiceInstanceId: string | null;

  @Column({ type: 'text', nullable: true })
  toolName: string | null;

  @Column({ type: 'varchar', length: 500 })
  startedAt: string;

  @Column({ type: 'text', nullable: true })
  completedAt: string | null;

  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  @Column({ type: 'varchar', length: 500 })
  phase: string;

  @Column({ type: 'text', nullable: true })
  requestPayloadId: string | null;

  @Column({ type: 'text', nullable: true })
  responsePayloadId: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  record: any;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;

  @Column({ type: 'varchar', length: 24 })
  ingestedAt: string;
}

@Entity('runtime_payload_objects')
@Index('IDX_obs_payload_objects_1', ["invocationId","side"])
@Index('IDX_obs_payload_objects_2', ["expiresAt"])
export class RuntimePayloadEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_payload_objects' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  invocationId: string;

  @Column({ type: 'varchar', length: 500 })
  side: string;

  @Column({ type: 'varchar', length: 500 })
  state: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'text', nullable: true })
  fileKey: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  digest: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  metadata: any;

  @Column({ type: 'varchar', length: 500 })
  createdAt: string;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

@Entity('runtime_callers')
@Index('IDX_obs_callers_1', ["lastSeenAt"])
export class RuntimeCallerEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_callers' })
  callerId: string;

  @Column({ type: 'varchar', length: 500 })
  identitySource: string;

  @Column({ type: 'text', nullable: true })
  displayName: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  labels: any;

  @Column({ type: 'varchar', length: 500 })
  firstSeenAt: string;

  @Column({ type: 'varchar', length: 500 })
  lastSeenAt: string;

  @Column({ type: 'integer', default: 0 })
  version: number;
}

@Entity('runtime_caller_credentials')
@Index('IDX_obs_caller_credentials_1', ["callerId"])
export class RuntimeCallerCredentialEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_caller_credentials' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  callerId: string;

  @Column({ type: 'varchar', length: 500 })
  credentialId: string;

  @Column({ type: 'varchar', length: 500 })
  firstSeenAt: string;

  @Column({ type: 'varchar', length: 500 })
  lastSeenAt: string;
}

@Entity('runtime_access_sources')
@Index('IDX_obs_access_sources_1', ["runtimeAssetId","lastSeenAt"])
@Index('IDX_obs_access_sources_2', ["day"])
export class RuntimeAccessSourceEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_access_sources' })
  sourceId: string;

  @Column({ type: 'text', nullable: true })
  runtimeAssetId: string | null;

  @Column({ type: 'varchar', length: 500 })
  authState: string;

  @Column({ type: 'text', nullable: true })
  clientIp: string | null;

  @Column({ type: 'text', nullable: true })
  peerIp: string | null;

  @Column({ type: 'varchar', length: 500 })
  ipSource: string;

  @Column({ type: 'boolean', default: false })
  proxyTrusted: boolean;

  @Column({ type: 'varchar', length: 500 })
  firstSeenAt: string;

  @Column({ type: 'varchar', length: 500 })
  lastSeenAt: string;

  @Column({ type: 'varchar', length: 500 })
  day: string;
}

@Entity('runtime_caller_observations')
@Index('IDX_obs_caller_observations_1', ["callerId","lastSeenAt"])
@Index('IDX_obs_caller_observations_2', ["runtimeAssetId","lastSeenAt"])
export class RuntimeCallerObservationEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_caller_observations' })
  id: string;

  @Column({ type: 'text', nullable: true })
  callerId: string | null;

  @Column({ type: 'text', nullable: true })
  sourceId: string | null;

  @Column({ type: 'text', nullable: true })
  runtimeAssetId: string | null;

  @Column({ type: 'varchar', length: 500 })
  serverType: string;

  @Column({ type: 'varchar', length: 500 })
  protocolTransport: string;

  @Column({ type: 'varchar', length: 500 })
  firstSeenAt: string;

  @Column({ type: 'varchar', length: 500 })
  lastSeenAt: string;
}

@Entity('runtime_ingest_checkpoints')
@Index('IDX_obs_ingest_checkpoints_1', ["status"])
export class RuntimeIngestCheckpointEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_ingest_checkpoints' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  fileName: string;

  @Column({ type: 'varchar', length: 20 })
  byteOffset: string;

  @Column({ type: 'varchar', length: 500 })
  fileIdentity: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lastSequence: string | null;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;

  @Column({ type: 'varchar', length: 500 })
  status: string;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}

@Entity('runtime_ingest_receipts')
@Index('IDX_obs_ingest_receipts_1', ["sourceInstanceId","eventId"], { unique: true })
@Index('IDX_obs_ingest_receipts_2', ["expiresAt"])
export class RuntimeIngestReceiptEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_ingest_receipts' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  sourceInstanceId: string;

  @Column({ type: 'varchar', length: 500 })
  eventId: string;

  @Column({ type: 'varchar', length: 64 })
  recordHash: string;

  @Column({ type: 'varchar', length: 500 })
  invocationId: string;

  @Column({ type: 'varchar', length: 500 })
  createdAt: string;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

/** Minimal replay gate after the physical receipt is removed. Never stores bodies or credentials. */
@Entity('runtime_ingest_receipt_tombstones')
@Index('IDX_obs_ingest_receipt_tombstones_1', ["sourceInstanceId","eventId"], { unique: true })
export class RuntimeIngestReceiptTombstoneEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_ingest_receipt_tombstones' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  sourceInstanceId: string;

  @Column({ type: 'varchar', length: 500 })
  eventId: string;

  @Column({ type: 'varchar', length: 64 })
  recordHash: string;

  @Column({ type: 'varchar', length: 500 })
  invocationId: string;

  @Column({ type: 'varchar', length: 500 })
  receiptCreatedAt: string;

  @Column({ type: 'varchar', length: 500 })
  receiptExpiresAt: string;

  @Column({ type: 'varchar', length: 500 })
  tombstonedAt: string;
}

@Entity('runtime_metric_buckets')
@Index('IDX_obs_metric_buckets_1', ["scope","bucketStart"])
@Index('IDX_obs_metric_buckets_2', ["expiresAt"])
export class RuntimeMetricBucketEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_metric_buckets' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  scope: string;

  @Column({ type: 'varchar', length: 500 })
  bucketStart: string;

  @Column({ type: 'varchar', length: 500 })
  bucketEnd: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  dimensions: any;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  metrics: any;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'varchar', length: 20 })
  dataWatermark: string;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

@Entity('runtime_caller_buckets')
@Index('IDX_obs_caller_buckets_1', ["callerId","bucketStart"])
@Index('IDX_obs_caller_buckets_2', ["runtimeAssetId","bucketStart"])
export class RuntimeCallerBucketEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_caller_buckets' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  callerId: string;

  @Column({ type: 'text', nullable: true })
  runtimeAssetId: string | null;

  @Column({ type: 'varchar', length: 500 })
  bucketStart: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  metrics: any;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

@Entity('runtime_metric_contributions')
export class RuntimeMetricContributionEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_metric_contributions' })
  invocationId: string;

  @Column({ type: 'integer', default: 0 })
  recordVersion: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  contribution: any;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;
}

@Entity('runtime_event_subscriptions')
@Index('IDX_obs_event_subscriptions_1', ["ownerId","state"])
export class RuntimeEventSubscriptionEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_event_subscriptions' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  ownerId: string;

  @Column({ type: 'varchar', length: 500 })
  name: string;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'varchar', length: 500 })
  state: string;

  @Column({ type: 'text' })
  destination: string;

  @Column({ type: 'varchar', length: 500 })
  secretRef: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  filter: any;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  scope: any;

  @Column({ type: 'varchar', length: 20 })
  effectiveFromSequence: string;

  @Column({ type: 'varchar', length: 500 })
  createdAt: string;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  pausedFromSequence: string | null;

  @Column({ type: 'text', nullable: true })
  deletedAt: string | null;
}

@Entity('runtime_subscription_revisions')
@Index('IDX_obs_subscription_revisions_1', ["subscriptionId","version"], { unique: true })
export class RuntimeSubscriptionRevisionEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_subscription_revisions' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  subscriptionId: string;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'varchar', length: 20 })
  effectiveFromSequence: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  effectiveUntilSequence: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  config: any;

  @Column({ type: 'boolean', default: false })
  revoked: boolean;

  @Column({ type: 'varchar', length: 500 })
  createdAt: string;
}

@Entity('runtime_event_deliveries')
@Index('IDX_obs_event_deliveries_1', ["subscriptionId","eventId"], { unique: true })
@Index('IDX_obs_event_deliveries_2', ["status","nextAttemptAt"])
@Index('IDX_obs_event_deliveries_3', ["eventId"])
@Index('IDX_obs_event_deliveries_4', ["expiresAt"])
export class RuntimeEventDeliveryEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_event_deliveries' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  subscriptionId: string;

  @Column({ type: 'integer', default: 0 })
  subscriptionRevision: number;

  @Column({ type: 'varchar', length: 500 })
  eventId: string;

  @Column({ type: 'varchar', length: 20 })
  eventSequence: string;

  @Column({ type: 'varchar', length: 500 })
  status: string;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'integer', default: 0 })
  replayGeneration: number;

  @Column({ type: 'varchar', length: 500 })
  nextAttemptAt: string;

  @Column({ type: 'text', nullable: true })
  leaseOwner: string | null;

  @Column({ type: 'text', nullable: true })
  leaseUntil: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  lastError: any;

  @Column({ type: 'varchar', length: 500 })
  createdAt: string;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

@Entity('runtime_event_delivery_attempts')
@Index('IDX_obs_event_delivery_attempts_1', ["deliveryId","attemptNo"], { unique: true })
export class RuntimeEventDeliveryAttemptEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_event_delivery_attempts' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  deliveryId: string;

  @Column({ type: 'integer', default: 0 })
  attemptNo: number;

  @Column({ type: 'varchar', length: 500 })
  startedAt: string;

  @Column({ type: 'text', nullable: true })
  completedAt: string | null;

  @Column({ type: 'varchar', length: 500 })
  result: string;

  @Column({ type: 'integer', nullable: true })
  durationMs: number | null;

  @Column({ type: 'integer', nullable: true })
  httpStatus: number | null;

  @Column({ type: 'text', nullable: true })
  errorCategory: string | null;

  @Column({ type: 'text', nullable: true })
  responseSummary: string | null;
}

@Entity('runtime_pipeline_state')
export class RuntimePipelineStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_pipeline_state' })
  id: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  value: any;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;
}

@Entity('runtime_observability_policies')
export class RuntimeObservabilityPolicyEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_observability_policies' })
  id: string;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  scope: any;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  settings: any;

  @Column({ type: 'varchar', length: 500 })
  updatedAt: string;

  @Column({ type: 'varchar', length: 500 })
  updatedBy: string;
}

@Entity('runtime_observability_idempotency')
@Index('IDX_obs_observability_idempotency_1', ["expiresAt"])
export class RuntimeObservabilityIdempotencyEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_observability_idempotency' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  ownerId: string;

  @Column({ type: 'varchar', length: 500 })
  requestHash: string;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  response: any;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;
}

@Entity('runtime_invocation_revisions')
@Index('IDX_obs_invocation_revisions_1', ["invocationId","recordVersion"], { unique: true })
@Index('IDX_obs_invocation_revisions_2', ["runtimeAssetId","startedAt"])
@Index('IDX_obs_invocation_revisions_3', ["callerId","startedAt"])
@Index('IDX_obs_invocation_revisions_4', ["traceId"])
@Index('IDX_obs_invocation_revisions_5', ["validFromSequence","validUntilSequence"])
@Index('IDX_obs_invocation_revisions_6', ["expiresAt"])
export class RuntimeInvocationRevisionEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_invocation_revisions' })
  id: string;

  @Column({ type: 'varchar', length: 500 })
  invocationId: string;

  @Column({ type: 'varchar', length: 500 })
  sourceInstanceId: string;

  @Column({ type: 'integer', default: 0 })
  sourceRecordVersion: number;

  @Column({ type: 'integer', default: 0 })
  recordVersion: number;

  @Column({ type: 'varchar', length: 64 })
  recordHash: string;

  @Column({ type: 'varchar', length: 20 })
  createdSequence: string;

  @Column({ type: 'varchar', length: 20 })
  updatedSequence: string;

  @Column({ type: 'text', nullable: true })
  traceId: string | null;

  @Column({ type: 'text', nullable: true })
  parentInvocationId: string | null;

  @Column({ type: 'text', nullable: true })
  runtimeAssetId: string | null;

  @Column({ type: 'varchar', length: 500 })
  serverType: string;

  @Column({ type: 'varchar', length: 500 })
  spanKind: string;

  @Column({ type: 'varchar', length: 500 })
  origin: string;

  @Column({ type: 'text', nullable: true })
  callerId: string | null;

  @Column({ type: 'text', nullable: true })
  sourceId: string | null;

  @Column({ type: 'text', nullable: true })
  endpointDefinitionId: string | null;

  @Column({ type: 'text', nullable: true })
  sourceServiceInstanceId: string | null;

  @Column({ type: 'text', nullable: true })
  toolName: string | null;

  @Column({ type: 'varchar', length: 500 })
  startedAt: string;

  @Column({ type: 'text', nullable: true })
  completedAt: string | null;

  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  @Column({ type: 'varchar', length: 500 })
  phase: string;

  @Column({ type: 'text', nullable: true })
  requestPayloadId: string | null;

  @Column({ type: 'text', nullable: true })
  responsePayloadId: string | null;

  @Column(getJsonColumnOptions(process.env.DB_TYPE))
  record: any;

  @Column({ type: 'varchar', length: 500 })
  expiresAt: string;

  @Column({ type: 'varchar', length: 24 })
  ingestedAt: string;

  @Column({ type: 'varchar', length: 20 })
  validFromSequence: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  validUntilSequence: string | null;
}

@Entity('runtime_ingest_quarantine')
@Index('IDX_obs_ingest_quarantine_1', ["createdAt"])
@Index('IDX_obs_ingest_quarantine_2', ["expiresAt"])
export class RuntimeIngestQuarantineEntity {
  @PrimaryColumn({ type: 'varchar', length: 240, primaryKeyConstraintName: 'PK_obs_ingest_quarantine' })
  id: string;

  @Column({ type: 'text', nullable: true })
  sourceInstanceId: string | null;

  @Column({ type: 'text', nullable: true })
  eventId: string | null;

  @Column({ type: 'text', nullable: true })
  invocationId: string | null;

  @Column({ type: 'text', nullable: true })
  fileName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  byteOffset: string | null;

  @Column({ type: 'varchar', length: 64 })
  recordHash: string;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', length: 24 })
  createdAt: string;

  @Column({ type: 'varchar', length: 24 })
  expiresAt: string;
}

@Entity('runtime_event_deletion_gaps')
@Check('CHK_obs_event_gaps_range', `length("startSequence") = 20 AND length("endSequence") = 20 AND "startSequence" > '00000000000000000000' AND "startSequence" <= "endSequence"`)
@Index('IDX_obs_event_gaps_end', ['endSequence'])
@Index('IDX_obs_event_gaps_scope_start', ['assetScope', 'startSequence'], { unique: true })
@Index('IDX_obs_event_gaps_scope_end', ['assetScope', 'endSequence'])
export class RuntimeEventDeletionGapEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, primaryKeyConstraintName: 'PK_obs_event_deletion_gaps' })
  id: string;
  @Column({ type: 'varchar', length: 500 })
  assetScope: string;
  @Column({ type: 'varchar', length: 20 })
  startSequence: string;
  @Column({ type: 'varchar', length: 20 })
  endSequence: string;
}

@Entity('runtime_payload_quota_ledgers')
export class RuntimePayloadQuotaLedgerEntity {
  @PrimaryColumn({ type: 'varchar', length: 120, primaryKeyConstraintName: 'PK_obs_payload_quota_ledgers' }) ownerId: string;
  @Column({ type: 'varchar', length: 36 }) epoch: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'varchar', length: 24 }) state: string;
  @Column({ type: 'varchar', length: 20 }) committedBytes: string;
  @Column({ type: 'varchar', length: 20 }) reservedBytes: string;
  @Column({ type: 'varchar', length: 128, nullable: true }) baselineKey: string | null;
  @Column(getJsonColumnOptions(process.env.DB_TYPE)) configuration: any;
  @Column({ type: 'varchar', length: 24 }) updatedAt: string;
}

/** An unverified inventory prefix. This row never grants a writer fence or quota baseline. */
@Entity('runtime_payload_inventory_checkpoints')
export class RuntimePayloadInventoryCheckpointEntity {
  @PrimaryColumn({ type: 'varchar', length: 120, primaryKeyConstraintName: 'PK_obs_payload_inventory_checkpoints' }) ownerId: string;
  @Column({ type: 'varchar', length: 36 }) epoch: string;
  @Column({ type: 'varchar', length: 20 }) generation: string;
  @Column({ type: 'varchar', length: 64 }) rootIdentity: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'integer' }) nextShard: number;
  @Column(getJsonColumnOptions(process.env.DB_TYPE)) completedShards: any;
  @Column({ type: 'varchar', length: 24 }) updatedAt: string;
}
@Entity('runtime_payload_quota_reservations')
@Index('IDX_obs_quota_reservation_owner_operation', ['ownerId', 'operationId'], { unique: true })
@Index('IDX_obs_quota_reservation_owner_state', ['ownerId', 'state'])
export class RuntimePayloadQuotaReservationEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, primaryKeyConstraintName: 'PK_obs_payload_quota_reservations' }) id: string;
  @Column({ type: 'varchar', length: 120 }) ownerId: string;
  @Column({ type: 'varchar', length: 128 }) operationId: string;
  @Column({ type: 'varchar', length: 36 }) epoch: string;
  @Column({ type: 'varchar', length: 20 }) generation: string;
  @Column({ type: 'varchar', length: 64 }) requestHash: string;
  @Column({ type: 'varchar', length: 20 }) reservedBytes: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) committedBytes: string | null;
  @Column({ type: 'varchar', length: 24 }) state: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) settlementHash: string | null;
  @Column({ type: 'varchar', length: 24 }) updatedAt: string;
}

/** Durable publication intent is written only for a newly created reservation.
 * Old reservations without a row remain unknown; no migration backfills them. */
@Entity('runtime_payload_publication_intents')
@Index('IDX_obs_publication_intent_scope', ['ownerId', 'epoch', 'generation'])
export class RuntimePayloadPublicationIntentEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, primaryKeyConstraintName: 'PK_obs_payload_publication_intents' })
  reservationId: string;
  @Column({ type: 'varchar', length: 120 }) ownerId: string;
  @Column({ type: 'varchar', length: 36 }) epoch: string;
  @Column({ type: 'varchar', length: 20 }) generation: string;
  @Column({ type: 'varchar', length: 500 }) sourceInstanceId: string;
  @Column({ type: 'varchar', length: 500 }) sourceEventId: string;
  @Column({ type: 'varchar', length: 64 }) payloadId: string;
  @Column({ type: 'varchar', length: 72 }) fileKey: string;
  @Column({ type: 'varchar', length: 113 }) temporaryKey: string;
  @Column({ type: 'varchar', length: 64 }) digest: string;
  @Column({ type: 'varchar', length: 20 }) storedBytes: string;
  @Column({ type: 'varchar', length: 64 }) intentHash: string;
  @Column({ type: 'varchar', length: 24 }) createdAt: string;

  @OneToOne(() => RuntimePayloadQuotaReservationEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reservationId', referencedColumnName: 'id',
    foreignKeyConstraintName: 'FK_obs_publication_intent_reservation' })
  reservation: RuntimePayloadQuotaReservationEntity;
}
export const CALL_OBSERVABILITY_ENTITIES = [
  RuntimePayloadInventoryCheckpointEntity,
  RuntimePayloadQuotaLedgerEntity,
  RuntimePayloadQuotaReservationEntity,
  RuntimePayloadPublicationIntentEntity,
  RuntimeEventDeletionGapEntity,
  RuntimeInvocationEntity,
  RuntimePayloadEntity,
  RuntimeCallerEntity,
  RuntimeCallerCredentialEntity,
  RuntimeAccessSourceEntity,
  RuntimeCallerObservationEntity,
  RuntimeIngestCheckpointEntity,
  RuntimeIngestReceiptEntity,
  RuntimeIngestReceiptTombstoneEntity,
  RuntimeMetricBucketEntity,
  RuntimeCallerBucketEntity,
  RuntimeMetricContributionEntity,
  RuntimeEventSubscriptionEntity,
  RuntimeSubscriptionRevisionEntity,
  RuntimeEventDeliveryEntity,
  RuntimeEventDeliveryAttemptEntity,
  RuntimePipelineStateEntity,
  RuntimeObservabilityPolicyEntity,
  RuntimeObservabilityIdempotencyEntity,
  RuntimeInvocationRevisionEntity,
  RuntimeIngestQuarantineEntity,
];
