export const GATEWAY_SNAPSHOT_REFRESH_REQUESTED = 'gateway.snapshot.refresh_requested';

export type GatewaySnapshotRefreshPayload = {
  reason: string;
  runtimeAssetId?: string;
  runtimeMembershipId?: string;
  routeBindingId?: string;
};
