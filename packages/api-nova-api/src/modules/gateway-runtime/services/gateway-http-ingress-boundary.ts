import { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { API_GLOBAL_PREFIX } from '../../../common/http-api-paths';

/** Preserve raw path segments as Express does; never normalize .. or % escapes. */
export function gatewayIngressPathname(target: string): string {
  const raw = target.startsWith('/') ? target
    : target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  return raw.split(/[?#]/, 1)[0] || '/';
}

const installed = new WeakSet<Server>();
const ingressEvents = ['checkContinue', 'checkExpectation', 'upgrade'] as const;

/**
 * Install after Nest/Socket.IO initialization and before listen. This owns the
 * three ingress events: registering another handler afterwards is rejected.
 * Bootstrap/lifecycle code remains trusted and must not remove this boundary.
 * The predicate must synchronously inspect trusted compiled route policy;
 * never infer v1 from an incoming header. Production activation stays gated
 * until this boundary is installed by the application bootstrap.
 */
export function installGatewayHttpIngressBoundary(
  server: Server,
  isV1GatewayRequest: (request: IncomingMessage) => boolean,
): void {
  if (server.listening || installed.has(server)) {
    throw new Error('gateway_ingress_boundary_installation_order');
  }
  const previous = new Map<string, Function[]>();
  for (const event of ingressEvents) {
    previous.set(event, server.rawListeners(event));
    server.removeAllListeners(event);
  }

  function delegate(event: string, args: unknown[]): boolean {
    const handlers = previous.get(event)!;
    if (!handlers.length) return false;
    for (const handler of [...handlers]) {
      // rawListeners retains once wrappers. Remove from our dispatch list too,
      // so the next event restores Node's default after that wrapper fires.
      if ('listener' in handler) handlers.splice(handlers.indexOf(handler), 1);
      handler.apply(server, args);
    }
    return true;
  }

  function selected(request: IncomingMessage): boolean {
    let pathname: string;
    try { pathname = gatewayIngressPathname(request.url || '/'); }
    catch { return false; }
    if (!pathname.toLowerCase().startsWith(`/${API_GLOBAL_PREFIX}/v1/gateway/`)) return false;
    const decision: unknown = isV1GatewayRequest(request);
    if (typeof decision !== 'boolean') {
      // A miswired async predicate must neither pass by truthiness nor leave an
      // unhandled rejection. Selection is deliberately synchronous at ingress.
      void Promise.resolve(decision).catch(() => undefined);
      throw new Error('gateway_header_policy_unavailable');
    }
    return decision;
  }

  function reject(response: ServerResponse, status: number, error: string): void {
    response.shouldKeepAlive = false;
    response.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' });
    response.end(JSON.stringify({ error }));
  }

  for (const event of ['checkContinue', 'checkExpectation'] as const) {
    server.on(event, (request: IncomingMessage, response: ServerResponse) => {
      try {
        if (selected(request)) {
          reject(response, 417, 'gateway_expectation_not_supported');
          return;
        }
      } catch {
        reject(response, 503, 'gateway_header_policy_unavailable');
        return;
      }
      if (delegate(event, [request, response])) return;
      if (event === 'checkContinue') {
        response.writeContinue();
        server.emit('request', request, response);
      } else {
        reject(response, 417, 'expectation_not_supported');
      }
    });
  }

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let denied: boolean;
    try { denied = selected(request); }
    catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
    if (denied) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
    if (!delegate('upgrade', [request, socket, head])) {
      // Installing a listener suppresses Node's default close for upgrades.
      socket.destroy();
    }
  });

  installed.add(server);
  server.on('newListener', (event: string) => {
    if ((ingressEvents as readonly string[]).includes(event)) {
      throw new Error('gateway_ingress_boundary_late_listener');
    }
  });
}
