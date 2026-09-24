import type {
  GatewayActiveRouteCatalogSnapshot,
  GatewayActiveRouteIdentity,
} from './gateway-active-route-catalog';
import type { GatewaySnapshotRouteEntry } from '../types/gateway-route-snapshot.types';

export interface GatewayActiveRouteCapture {
  readonly kind: 'gateway-active-route-capture';
  readonly catalogVersion: number;
}

export type GatewayCapturedActiveRoute = Readonly<{
  identity: GatewayActiveRouteIdentity;
  route: GatewaySnapshotRouteEntry;
}>;

type CaptureState = Readonly<{
  catalog: GatewayActiveRouteCatalogSnapshot;
  routes: readonly GatewayCapturedActiveRoute[];
  assertCurrent: (catalog: GatewayActiveRouteCatalogSnapshot) => void;
}>;

const captures = new WeakMap<object, CaptureState>();

export function createGatewayActiveRouteCapture(
  catalog: GatewayActiveRouteCatalogSnapshot,
  routes: readonly GatewayCapturedActiveRoute[],
  assertCurrent: (catalog: GatewayActiveRouteCatalogSnapshot) => void,
): GatewayActiveRouteCapture {
  if (!Object.isFrozen(catalog) || !Object.isFrozen(catalog.routes) ||
      !Array.isArray(routes) || routes.length !== catalog.routes.length ||
      typeof assertCurrent !== 'function') {
    throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
  }
  const copied = Object.freeze(routes.map((item, index) => {
    if (!item || item.identity !== catalog.routes[index] || !item.route) {
      throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
    }
    return Object.freeze({ identity: item.identity, route: item.route });
  }));
  const capture = Object.freeze({
    kind: 'gateway-active-route-capture' as const,
    catalogVersion: catalog.version,
  });
  captures.set(capture, Object.freeze({ catalog, routes: copied, assertCurrent }));
  return capture;
}

/** Host-only inspection. The token carries no network permission. */
export function inspectGatewayActiveRouteCapture(
  capture: GatewayActiveRouteCapture,
): readonly GatewayCapturedActiveRoute[] {
  if (!capture || typeof capture !== 'object') {
    throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
  }
  const state = captures.get(capture);
  if (!state) throw new Error('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
  state.assertCurrent(state.catalog);
  return state.routes;
}
