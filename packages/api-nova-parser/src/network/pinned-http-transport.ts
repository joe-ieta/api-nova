import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { createControlledDns, ControlledDnsError, ControlledDnsRequest } from './controlled-dns';
import { createNetworkPolicyCompiler } from './network-policy';
import { parseNetworkAddress } from './address-policy';

/** Bounded single-hop primitive, not a Gateway streaming-body adapter. */
export const PINNED_HTTP_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const PINNED_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export interface PinnedHttpRequest extends ControlledDnsRequest {
  readonly method: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: Buffer;
}
export interface PinnedHttpResponse {
  readonly statusCode: number; readonly headers: Readonly<Record<string, string | readonly string[]>>; readonly body: Buffer;
}
function error(code: ControlledDnsError['code'] = 'upstream_network_policy_denied'): ControlledDnsError { return new ControlledDnsError(code); }
function record(raw: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) throw error();
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw error();
    const property = Object.getOwnPropertyDescriptor(raw, key)!; if (!('value' in property)) throw error(); copy[key] = property.value;
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(copy, key))) throw error(); return copy;
}
/** Host-only direct transport. No global Agent, external socket, lookup, proxy, retry or redirect.
 * Both bodies are bounded to 8 MiB. Oversized requests fail before DNS; oversized responses destroy
 * the connection and are never returned partially. Streaming/large-body production adapters are separate.
 */
export function createPinnedHttpTransport(hostInput: { compiler: ReturnType<typeof createNetworkPolicyCompiler>; servers: readonly string[]; ca?: string }) {
  const host = record(hostInput, ['compiler', 'servers', 'ca'], ['compiler', 'servers']);
  const dns = createControlledDns({ compiler: host.compiler as ReturnType<typeof createNetworkPolicyCompiler>, servers: host.servers as readonly string[] });
  const ca = host.ca;
  if (ca !== undefined && (typeof ca !== 'string' || !ca || ca.length > 1024 * 1024)) throw error();
  async function send(input: PinnedHttpRequest): Promise<PinnedHttpResponse> {
    try {
      const value = record(input, ['policy', 'target', 'deadline', 'signal', 'method', 'headers', 'body'], ['policy', 'target', 'deadline', 'method']);
      if (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)) throw error();
      if (typeof value.method !== 'string' || !/^[A-Z]{1,32}$/.test(value.method) || value.method === 'CONNECT') throw error();
      if (value.body !== undefined && (!Buffer.isBuffer(value.body) || value.body.length > PINNED_HTTP_MAX_REQUEST_BYTES)) throw error();
      const body = value.body === undefined ? undefined : Buffer.from(value.body as Buffer);
      const headers: Record<string, string> = {};
      if (value.headers !== undefined) {
        if (!value.headers || typeof value.headers !== 'object' || Object.getPrototypeOf(value.headers) !== Object.prototype || Reflect.ownKeys(value.headers).length > 128) throw error();
        for (const key of Reflect.ownKeys(value.headers)) {
          if (typeof key !== 'string') throw error();
          const descriptor = Object.getOwnPropertyDescriptor(value.headers, key)!;
          if (!('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 8192) throw error();
          http.validateHeaderName(key); http.validateHeaderValue(key, descriptor.value);
          const name = key.toLowerCase();
          if (Object.prototype.hasOwnProperty.call(headers, name) || ['host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'content-length', 'trailer', 'upgrade', 'expect'].includes(name)) throw error();
          headers[name] = descriptor.value;
        }
      }
      const request = { policy: value.policy, target: value.target, deadline: value.deadline, ...(value.signal === undefined ? {} : { signal: value.signal }) } as ControlledDnsRequest;
      const monotonicDeadline = performance.now() + request.deadline - Date.now();
      const resolution = await dns.resolve(request);
      const signal = request.signal, url = new URL(resolution.url), address = resolution.addresses[0];
      if (signal?.aborted) throw error('ABORT_ERR');
      if (Date.now() >= request.deadline || performance.now() >= monotonicDeadline) throw error('ETIMEDOUT');
      if (!dns.revalidate(resolution)) throw error();
      return await new Promise<PinnedHttpResponse>((resolve, reject) => {
        let finished = false, handedOff = false, connecting = false;
        let socket: net.Socket | tls.TLSSocket | undefined, outgoing: http.ClientRequest | undefined, incoming: http.IncomingMessage | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const secure = url.protocol === 'https:';
        // Explicitly empty proxy environment even on Node versions that support env-proxy Agents.
        const options = { keepAlive: false, maxSockets: 1, proxyEnv: {} };
        const agent = secure ? new https.Agent({ ...options, maxCachedSessions: 0 }) : new http.Agent(options);
        const finish = (failure?: ControlledDnsError, result?: PinnedHttpResponse) => {
          if (finished) return; finished = true;
          if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
          incoming?.destroy(); outgoing?.destroy(); socket?.destroy(); agent.destroy();
          if (failure) reject(failure); else resolve(result!);
        };
        const abort = () => finish(error('ABORT_ERR'));
        const check = () => {
          if (signal?.aborted) throw error('ABORT_ERR');
          if (Date.now() >= request.deadline || performance.now() >= monotonicDeadline) throw error('ETIMEDOUT');
          if (!dns.revalidate(resolution)) throw error();
        };
        timer = setTimeout(() => finish(error('ETIMEDOUT')), Math.min(2147483647, Math.max(1, Math.min(request.deadline - Date.now(), monotonicDeadline - performance.now()))));
        signal?.addEventListener('abort', abort, { once: true });
        agent.createConnection = (_ignored, callback) => {
          if (connecting || !callback) { finish(error()); return undefined; } connecting = true;
          const rejectConnection = (failure: ControlledDnsError) => {
            if (!handedOff) { handedOff = true; callback(failure, undefined as never); }
            finish(failure);
          };
          try {
            check();
            const connection = { host: address.address, port: resolution.port, family: address.family };
            socket = secure ? tls.connect({ ...connection, ...(ca === undefined ? {} : { ca: ca as string }), rejectUnauthorized: true,
              servername: net.isIP(resolution.host) ? undefined : resolution.host,
              checkServerIdentity: (_host, cert) => tls.checkServerIdentity(resolution.host, cert), ALPNProtocols: ['http/1.1'] }) : net.createConnection(connection);
            socket.on('error', () => {
              const failure = error(secure && !handedOff ? 'upstream_network_policy_denied' : 'upstream_network_policy_unavailable');
              if (!handedOff) rejectConnection(failure); else finish(failure);
            });
            socket.once(secure ? 'secureConnect' : 'connect', () => {
              if (finished) { socket?.destroy(); return; }
              try {
                check();
                if (!socket?.remoteAddress || parseNetworkAddress(socket.remoteAddress).canonical !== address.address || socket.remotePort !== resolution.port) throw error();
                if (secure) {
                  const tlsSocket = socket as tls.TLSSocket;
                  if (!tlsSocket.authorized || tls.checkServerIdentity(resolution.host, tlsSocket.getPeerCertificate()) || tlsSocket.alpnProtocol && tlsSocket.alpnProtocol !== 'http/1.1') throw error();
                }
                // The only point at which HTTP obtains the socket and may flush buffered bytes.
                handedOff = true; callback(null, socket);
              } catch (failure) { rejectConnection(failure instanceof ControlledDnsError ? failure : error()); }
            });
          } catch (failure) { rejectConnection(failure instanceof ControlledDnsError ? failure : error('upstream_network_policy_unavailable')); }
          // Returning a socket here would let Node hand it to HTTP before the above checks finish.
          return undefined;
        };
        try {
          check();
          const authority = `${resolution.host.includes(':') ? '[' + resolution.host + ']' : resolution.host}:${resolution.port}`;
          outgoing = (secure ? https : http).request({ protocol: url.protocol, hostname: resolution.host, port: resolution.port,
            path: url.pathname + url.search, method: value.method as string, agent,
            headers: { ...headers, host: authority, connection: 'close', ...(body === undefined ? {} : { 'content-length': String(body.length) }) } }, response => {
            incoming = response;
            if (finished) { response.destroy(); return; }
            let bytes = 0; const chunks: Buffer[] = [];
            const declared = response.headers['content-length'];
            const noResponseBody = value.method === 'HEAD' || response.statusCode === 304 || response.statusCode === 204;
            if (declared && (!/^[0-9]+$/.test(declared) || !noResponseBody && Number(declared) > PINNED_HTTP_MAX_RESPONSE_BYTES)) { finish(error()); return; }
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > PINNED_HTTP_MAX_RESPONSE_BYTES) { finish(error()); return; }
              chunks.push(Buffer.from(chunk));
            });
            response.on('error', () => finish(error('upstream_network_policy_unavailable')));
            response.once('aborted', () => finish(error('upstream_network_policy_unavailable')));
            response.once('end', () => {
              const responseHeaders: Record<string, string | readonly string[]> = {};
              for (const [key, entry] of Object.entries(response.headers)) if (entry !== undefined) responseHeaders[key] = Array.isArray(entry) ? Object.freeze([...entry]) : entry;
              finish(undefined, Object.freeze({ statusCode: response.statusCode ?? 502, headers: Object.freeze(responseHeaders), body: Buffer.concat(chunks, bytes) }));
            });
          });
          outgoing.on('error', () => finish(error('upstream_network_policy_unavailable')));
          outgoing.end(body);
        } catch (failure) { finish(failure instanceof ControlledDnsError ? failure : error()); }
      });
    } catch (failure) {
      if (failure instanceof ControlledDnsError) throw failure;
      throw error();
    }
  }
  return Object.freeze({ send });
}
