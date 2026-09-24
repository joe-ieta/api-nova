import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import { API_GLOBAL_PREFIX } from './http-api-paths';
import { GatewayRouteSnapshotService } from '../modules/gateway-runtime/services/gateway-route-snapshot.service';
import { gatewayIngressPathname, installGatewayHttpIngressBoundary } from '../modules/gateway-runtime/services/gateway-http-ingress-boundary';

/** Uses the same case-insensitive prefix and decoded wildcard as the Nest route. */
export function gatewayIngressRoutePath(request: IncomingMessage): string | undefined {
  const pathname = gatewayIngressPathname(request.url || '/');
  const prefix = `/${API_GLOBAL_PREFIX}/v1/gateway/`;
  if (!pathname.toLowerCase().startsWith(prefix)) return undefined;
  // Preserve dot segments until the same route matcher used by the controller runs.
  return '/' + decodeURIComponent(pathname.slice(prefix.length));
}

/** Socket.IO registers upgrade listeners during init; wrap them before opening the port. */
export async function initializeGatewayHttpIngress(app: INestApplication): Promise<void> {
  await app.init();
  const routes = app.get(GatewayRouteSnapshotService);
  installGatewayHttpIngressBoundary(app.getHttpServer() as Server, request => {
    const routePath = gatewayIngressRoutePath(request);
    if (routePath === undefined) return false;
    const route = routes.resolve(request.headers.host, request.method || 'GET', routePath);
    return route?.policies.upstream?.compiledHeaderPolicy?.version === 1;
  });
}
