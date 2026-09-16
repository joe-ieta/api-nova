import { RuntimeEventDeletionGapEntity } from '../../database/entities/runtime-call-observability.entity';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { ObservabilityWriteTransaction, ObservabilityReadTransaction } from './call-observability.store';
import { canonicalJson, contentHash, ObservabilityStorageError, publicSequence, sequenceKey } from './call-observability-storage';

/** Call inside the sole Store write transaction (global sequence lock: Store.transaction serializes locally and takes the
 * PostgreSQL counter row pessimistic_write lock before invoking this callback). E2 must
 * record the gap and delete its event in that same transaction. No deletion here. */
export async function recordEventDeletionGap(tx: ObservabilityWriteTransaction,
  event: Pick<RuntimeObservabilityEventEntity, 'sequence' | 'runtimeAssetId' | 'schemaVersion'>): Promise<void> {
  if (event.schemaVersion !== '1.0' || !event.sequence) throw new ObservabilityStorageError('INVALID_EVENT_GAP');
  const sequence = publicSequence(event.sequence), number = BigInt(sequence);
  if (number < BigInt(1) || number > BigInt(publicSequence(tx.currentSequence()))) throw new ObservabilityStorageError('INVALID_EVENT_GAP');
  const assetScope = event.runtimeAssetId || '';
  if (assetScope.length > 500) throw new ObservabilityStorageError('INVALID_EVENT_GAP');
  const key = sequenceKey(sequence), repository = tx.manager.getRepository(RuntimeEventDeletionGapEntity);
  const left = await repository.createQueryBuilder('gap').where('gap.assetScope = :assetScope', { assetScope })
    .andWhere('gap.startSequence <= :key', { key }).orderBy('gap.startSequence', 'DESC').take(1).getOne();
  if (left && left.endSequence >= key) return;
  const right = number < BigInt(publicSequence(tx.currentSequence())) ? await repository.findOneBy({
    assetScope, startSequence: sequenceKey((number + BigInt(1)).toString()),
  }) : null;
  if (left && BigInt(left.endSequence) + BigInt(1) === number) {
    left.endSequence = right?.endSequence ?? key;
    if (right) await repository.delete(right.id);
    await repository.save(left);
  } else {
    const endSequence = right?.endSequence ?? key;
    if (right) await repository.delete(right.id);
    await repository.insert({ id: contentHash(canonicalJson([assetScope, key])), assetScope,
      startSequence: key, endSequence });
  }
}

/** Match only the caller's authorized assets. A null scope denotes global access. */
export async function hasEventDeletionGap(tx: ObservabilityReadTransaction,
  assets: readonly string[] | null, start: string, high: string): Promise<boolean> {
  if (assets !== null && !assets.length) return false;
  const query = tx.manager.getRepository(RuntimeEventDeletionGapEntity).createQueryBuilder('gap')
    .where('gap.endSequence >= :start AND gap.startSequence <= :high',
      { start: sequenceKey(start), high: sequenceKey(high) });
  if (assets !== null) query.andWhere('gap.assetScope IN (:...assets)', { assets: [...assets] });
  return query.getExists();
}
