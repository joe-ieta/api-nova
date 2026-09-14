import { randomUUID } from 'crypto';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import type { CommittedObservabilityEvent, ObservabilityWriteTransaction } from './call-observability.store';
import { expiresAfter, ObservabilityStorageError, publicSequence, sequenceKey, ZERO_SEQUENCE } from './call-observability-storage';

/** Producers supply their existing, metadata-only event contract; the writer does not redact payloads. */
export type DurableObservabilityEventInput = Pick<RuntimeObservabilityEventEntity,
  'eventName' | 'eventFamily' | 'severity' | 'status' | 'occurredAt' | 'actorType' | 'retentionClass'> &
  Partial<Pick<RuntimeObservabilityEventEntity,
    'runtimeAssetId' | 'runtimeAssetEndpointBindingId' | 'endpointDefinitionId' | 'sourceServiceAssetId' |
    'subjectId' | 'subjectVersion' | 'correlationId' | 'actorId' | 'summary' | 'dimensions' | 'details'>>;

export interface DurableObservabilityEventOptions {
  /** An unused event sequence allocated by THIS transaction, e.g. the invocation revision sequence.
   * Omit to allocate a new sequence. Projection hooks may already have advanced currentSequence().
   */
  sequence?: string;
  /** Persist history while excluding the event from dispatch and the transaction notification list. */
  suppressEvent?: boolean;
  /** Retention starts at tx.now (recorded time), never occurredAt. Defaults to 14 days. */
  retentionDays?: number;
}

/**
 * Must be awaited inside CallObservabilityStore.transaction; errors must propagate to roll back.
 * Uses the supplied manager and sequence allocator, without opening another transaction or publishing.
 * The returned receipt and tx.events remain tentative until the outer transaction commits.
 * A duplicate event sequence fails insertion; this writer does not swallow uniqueness errors.
 */
export async function writeDurableObservabilityEvent(
  tx: ObservabilityWriteTransaction,
  input: DurableObservabilityEventInput,
  options: DurableObservabilityEventOptions = {},
): Promise<CommittedObservabilityEvent> {
  const expiresAt = new Date(expiresAfter(tx.now, options.retentionDays ?? 14));
  const sequence = sequenceKey(options.sequence ?? tx.nextSequence());
  if (sequence === ZERO_SEQUENCE || sequence > sequenceKey(tx.currentSequence())) {
    throw new ObservabilityStorageError('INVALID_EVENT_SEQUENCE');
  }
  const event = Object.assign(new RuntimeObservabilityEventEntity(), input, {
    id: randomUUID(), sequence, schemaVersion: '1.0', createdAt: new Date(tx.now), expiresAt,
    dispatchState: options.suppressEvent ? 'suppressed' : 'pending',
  });
  await tx.manager.getRepository(RuntimeObservabilityEventEntity).insert(event);
  const receipt: CommittedObservabilityEvent = {
    eventId: event.id, sequence: publicSequence(sequence), eventType: event.eventName,
  };
  if (!options.suppressEvent) tx.events.push(receipt);
  return receipt;
}