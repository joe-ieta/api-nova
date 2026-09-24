import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { createControlledDns, ControlledDnsError, ControlledDnsRequest } from './controlled-dns';
import { createNetworkPolicyCompiler } from './network-policy';
import { parseNetworkAddress } from './address-policy';

/** Internal implementation module: never export connection handles from the package entry point. */
export interface PinnedConnectionHostOptions { compiler: ReturnType<typeof createNetworkPolicyCompiler>; servers: readonly string[]; ca?: string }
export function pinnedError(code: ControlledDnsError['code'] = 'upstream_network_policy_denied'): ControlledDnsError { return new ControlledDnsError(code); }
export function pinnedRecord(raw: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) throw pinnedError();
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw pinnedError();
    const property = Object.getOwnPropertyDescriptor(raw, key)!; if (!('value' in property)) throw pinnedError(); copy[key] = property.value;
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(copy, key))) throw pinnedError(); return copy;
}
export function pinnedHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw === undefined) return headers;
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length > 128) throw pinnedError();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') throw pinnedError();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 8192) throw pinnedError();
    http.validateHeaderName(key); http.validateHeaderValue(key, descriptor.value);
    const name = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(headers, name) || ['host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'content-length', 'trailer', 'upgrade', 'expect'].includes(name)) throw pinnedError();
    headers[name] = descriptor.value;
  }
  return headers;
}
export function createPinnedConnectionHost(hostInput: PinnedConnectionHostOptions) {
  const host = pinnedRecord(hostInput, ['compiler', 'servers', 'ca'], ['compiler', 'servers']);
  const dns = createControlledDns({ compiler: host.compiler as ReturnType<typeof createNetworkPolicyCompiler>, servers: host.servers as readonly string[] });
  const ca = host.ca;
  if (ca !== undefined && (typeof ca !== 'string' || !ca || ca.length > 1024 * 1024)) throw pinnedError();
  return Object.freeze({ async prepare(request: ControlledDnsRequest, onFailure: (error: ControlledDnsError) => void, onVerified?: () => void) {
    if (typeof request.deadline !== 'number' || !Number.isFinite(request.deadline)) throw pinnedError();
    const deadline = request.deadline, signal = request.signal;
    const monotonicDeadline = performance.now() + deadline - Date.now();
    const resolution = await dns.resolve(request), url = new URL(resolution.url), address = resolution.addresses[0];
    let socket: net.Socket | tls.TLSSocket | undefined, destroyed = false, handedOff = false, connecting = false;
    const check = () => {
      if (destroyed) throw pinnedError();
      if (signal?.aborted) throw pinnedError('ABORT_ERR');
      if (Date.now() >= deadline || performance.now() >= monotonicDeadline) throw pinnedError('ETIMEDOUT');
      if (!dns.revalidate(resolution)) throw pinnedError();
    };
    check();
    const secure = url.protocol === 'https:', options = { keepAlive: false, maxSockets: 1, proxyEnv: {} };
    const agent = secure ? new https.Agent({ ...options, maxCachedSessions: 0 }) : new http.Agent(options);
    agent.createConnection = (_ignored, callback) => {
      if (connecting || !callback) { onFailure(pinnedError()); return undefined; } connecting = true;
      const rejectConnection = (failure: ControlledDnsError) => {
        if (!handedOff) { handedOff = true; callback(failure, undefined as never); }
        onFailure(failure);
      };
      try {
        check();
        const connection = { host: address.address, port: resolution.port, family: address.family };
        socket = secure ? tls.connect({ ...connection, ...(ca === undefined ? {} : { ca: ca as string }), rejectUnauthorized: true,
          servername: net.isIP(resolution.host) ? undefined : resolution.host,
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity(resolution.host, cert), ALPNProtocols: ['http/1.1'] }) : net.createConnection(connection);
        socket.on('error', () => {
          const failure = pinnedError(secure && !handedOff ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable');
          if (!handedOff) rejectConnection(failure); else onFailure(failure);
        });
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          if (destroyed) { socket?.destroy(); return; }
          try {
            check();
            if (!socket?.remoteAddress || parseNetworkAddress(socket.remoteAddress).canonical !== address.address || socket.remotePort !== resolution.port) throw pinnedError();
            if (secure) {
              const secured = socket as tls.TLSSocket;
              if (!secured.authorized || tls.checkServerIdentity(resolution.host, secured.getPeerCertificate()) || secured.alpnProtocol && secured.alpnProtocol !== 'http/1.1') throw pinnedError();
            }
            handedOff = true; callback(null, socket); onVerified?.();
          } catch (failure) { rejectConnection(failure instanceof ControlledDnsError ? failure : pinnedError()); }
        });
      } catch (failure) { rejectConnection(failure instanceof ControlledDnsError ? failure : pinnedError('upstream_network_policy_unavailable')); }
      // Node treats a synchronously returned socket as immediately available for HTTP writes.
      return undefined;
    };
    return Object.freeze({ resolution, url, agent, check,
      remaining: () => Math.max(0, Math.min(deadline - Date.now(), monotonicDeadline - performance.now())),
      destroy() { if (destroyed) return; destroyed = true; socket?.destroy(); agent.destroy(); },
    });
  } });
}
