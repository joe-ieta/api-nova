import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { authorizeObservability } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import type { EventsDispatchAuthorizer } from './call-observability-events.dispatcher';

/** Refresh the subscription owner's current grants in the dispatch transaction. */
@Injectable()
export class CallObservabilityDispatchAuthorization implements EventsDispatchAuthorizer {
  async resolve(ownerId: string, manager: EntityManager) {
    const user = await manager.getRepository(User).findOne({ where: { id: ownerId },
      relations: { roles: { permissions: true } } });
    try { return authorizeObservability(user, ['monitoring:subscription:manage']); }
    catch (error) {
      if (error instanceof ObservabilityApiError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code)) return null;
      throw error;
    }
  }
}