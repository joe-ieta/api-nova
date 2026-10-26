import type { Request } from 'express';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';

// In-process candidate execution authority. Neither HTTP fields nor the audit-only
// internal marker confer this permission. A grant is consumed once for its exact
// request/target pair and removed when replay ends, including on failure.
const grants = new WeakMap<Request, {
  target: GatewayResolvedRoute; fingerprint: string; method: string; url: string; runId: string;
}>();
function fingerprint(target: GatewayResolvedRoute): string {
  return JSON.stringify([target.runtimeAsset, target.membership, target.routeBinding, target.publishBinding,
    target.endpointDefinition, target.sourceServiceAsset, target.sourceServiceInstance,
    target.upstreamBaseUrl, target.params, target.policies]);
}
export function grantGatewayCandidateReplay(req: Request, target: GatewayResolvedRoute, runId: string): () => void {
  if (!runId || grants.has(req)) throw new Error('gateway_candidate_replay_grant_invalid');
  const grant = { target, fingerprint: fingerprint(target), method: req.method,
    url: req.originalUrl || req.url, runId };
  grants.set(req, grant);
  return () => { if (grants.get(req) === grant) grants.delete(req); };
}
export function consumeGatewayCandidateReplay(req: Request, target: GatewayResolvedRoute): string | undefined {
  const grant = grants.get(req);
  grants.delete(req);
  if (!grant || grant.target !== target || grant.fingerprint !== fingerprint(target) ||
      grant.method !== req.method || grant.url !== (req.originalUrl || req.url)) return undefined;
  return grant.runId;
}
