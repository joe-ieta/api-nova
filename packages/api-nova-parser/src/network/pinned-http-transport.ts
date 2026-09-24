import * as http from 'node:http';
import * as https from 'node:https';
import { ControlledDnsError, ControlledDnsRequest } from './controlled-dns';
import { createPinnedConnectionHost, pinnedError as error, pinnedRecord as record, pinnedHeaders, PinnedConnectionHostOptions } from './pinned-http-connection';

/** Bounded single-hop primitive, not a Gateway streaming-body adapter. */
export const PINNED_HTTP_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const PINNED_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export interface PinnedHttpRequest extends ControlledDnsRequest {
  readonly method: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: Buffer;
}
export interface PinnedHttpResponse {
  readonly statusCode: number; readonly headers: Readonly<Record<string, string | readonly string[]>>; readonly body: Buffer;
}
/** Host-only direct transport. No global Agent, external socket, lookup, proxy, retry or redirect.
 * Both bodies are bounded to 8 MiB. Oversized requests fail before DNS; oversized responses destroy
 * the connection and are never returned partially. Streaming/large-body production adapters are separate.
 */
export function createPinnedHttpTransport(hostInput: PinnedConnectionHostOptions) {
  const connections = createPinnedConnectionHost(hostInput);
  async function send(input: PinnedHttpRequest): Promise<PinnedHttpResponse> {
    try {
      const value = record(input, ['policy', 'target', 'deadline', 'signal', 'method', 'headers', 'body'], ['policy', 'target', 'deadline', 'method']);
      if (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)) throw error();
      if (typeof value.method !== 'string' || !/^[A-Z]{1,32}$/.test(value.method) || value.method === 'CONNECT') throw error();
      if (value.body !== undefined && (!Buffer.isBuffer(value.body) || value.body.length > PINNED_HTTP_MAX_REQUEST_BYTES)) throw error();
      const body = value.body === undefined ? undefined : Buffer.from(value.body as Buffer);
      const headers = pinnedHeaders(value.headers);
      const request = { policy: value.policy, target: value.target, deadline: value.deadline, ...(value.signal === undefined ? {} : { signal: value.signal }) } as ControlledDnsRequest;
      let failed: ((failure: ControlledDnsError) => void) | undefined;
      const connection = await connections.prepare(request, failure => failed?.(failure));
      const { resolution, url, agent } = connection, signal = request.signal;
      return await new Promise<PinnedHttpResponse>((resolve, reject) => {
        let finished = false;
        let outgoing: http.ClientRequest | undefined, incoming: http.IncomingMessage | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const secure = url.protocol === 'https:';
        const finish = (failure?: ControlledDnsError, result?: PinnedHttpResponse) => {
          if (finished) return; finished = true;
          if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
          incoming?.destroy(); outgoing?.destroy(); connection.destroy();
          if (failure) reject(failure); else resolve(result!);
        };
        const abort = () => finish(error('ABORT_ERR'));
        failed = failure => finish(failure);
        const check = connection.check;
        timer = setTimeout(() => finish(error('ETIMEDOUT')), Math.min(2147483647, Math.max(1, connection.remaining())));
        signal?.addEventListener('abort', abort, { once: true });
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
