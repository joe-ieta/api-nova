import { Injectable, Optional } from '@nestjs/common';
import { ObservabilityAuthorization } from './call-observability-access';
import { observabilitySuccess } from './call-observability-api.contract';
import { CallObservabilityStore } from './call-observability.store';
import { CallObservabilityServerStatusService } from './call-observability-server-status.service';
import { overviewFilter, overviewWindow, overviewSummary, readOverviewRows } from './call-observability-overview-query';
import { CallObservabilityOverviewSnapshotAuthorizer } from './call-observability-overview-snapshot-authorizer.service';
import { ObservabilityOverviewDto } from './call-observability-overview.dto';
@Injectable()
export class CallObservabilityOverviewService {
  constructor(private readonly store: CallObservabilityStore,
    private readonly servers: CallObservabilityServerStatusService,
    @Optional() private readonly snapshots?: CallObservabilityOverviewSnapshotAuthorizer) {}
  async get(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const filter = overviewFilter(raw);
    const result = await this.store.readSnapshot(async tx => {
      const rows = await readOverviewRows(tx, filter, authorization);
      const data: ObservabilityOverviewDto = {
        window: overviewWindow(filter), snapshotSeq: tx.snapshotSeq,
        invocationSnapshotSeq: tx.snapshotSeq, invocationSnapshotScope: 'invocation_facts_only',
        invocationSnapshotAuthorized: false, invocationSnapshotExpiresAt: null,
        businessSummary: overviewSummary(rows, filter, 'business', tx.snapshotSeq),
        upstreamSummary: overviewSummary(rows, filter, 'upstream', tx.snapshotSeq),
        serverStates: await this.servers.readInSnapshot(tx, filter, authorization, rows),
        unavailableSections: ['pipeline', 'recentEvents'], restricted: authorization.runtimeAssetIds !== null,
      };
      // Mixed state sources have no common event watermark; each block states its own evidence.
      return observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
    // Register only after readSnapshot resolves, including successful transaction completion.
    // Legacy server state is deliberately not covered by this invocation-only sequence.
    if (this.snapshots) {
      result.data.invocationSnapshotExpiresAt =
        this.snapshots.issue(result.data.invocationSnapshotSeq, authorization, filter);
      result.data.invocationSnapshotAuthorized = true;
    }
    return result;
  }
}
