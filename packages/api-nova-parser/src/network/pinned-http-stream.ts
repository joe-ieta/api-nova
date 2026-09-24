import * as http from 'node:http';
import * as https from 'node:https';
import { Readable, Transform } from 'node:stream';
import { ControlledDnsError, ControlledDnsRequest } from './controlled-dns';
import { createPinnedConnectionHost, pinnedError as error, pinnedRecord as record, pinnedHeaders, PinnedConnectionHostOptions } from './pinned-http-connection';

export type PinnedStreamFraming = Readonly<{ mode: 'none' } | { mode: 'fixed'; length: number } | { mode: 'chunked' }>;
export class PinnedHttpStreamProtocolError extends ControlledDnsError {
  constructor(readonly reason: 'informational' | 'early_response' | 'request_length' | 'response_length' | 'upgrade' | 'parse') {
    super('upstream_network_policy_denied'); this.name = 'PinnedHttpStreamProtocolError';
  }
}
export interface PinnedHttpStreamRequest extends ControlledDnsRequest {
  /** Host adapter only. Defaults false; strict D1 hosts reject 1xx and retain safe protocol categories. */
  readonly rejectInformationalResponses?: boolean;
  readonly method: string; readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readable; readonly framing: PinnedStreamFraming;
}
export interface PinnedHttpStreamCompletion { readonly requestBytes: number; readonly responseBytes: number; readonly rawTrailers: readonly string[] }
export interface PinnedHttpStreamResponse {
  readonly statusCode: number; readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly rawHeaders: readonly string[]; readonly body: Readable; readonly completed: Promise<PinnedHttpStreamCompletion>;
}
// Ownership is one-shot across transport instances. A rejected or interrupted source cannot become a retry.
const claimedBodies = new WeakSet<Readable>();
const HIGH_WATER_MARK = 64 * 1024;
/** Host-only binary Readable exchange, with no automatic redirects or retries.
 * Ownership of body transfers after validation. No read/pipe/resume occurs before verified socket handoff.
 * Both directions use bounded stream buffers; this does not impose a whole-body size cap.
 * The host must consume or destroy the returned body and await completed. Headers/trailers are raw metadata
 * for a later D1 adapter, not permission to forward them to a consumer. No raw socket/request/Agent is exposed.
 */
export function createPinnedHttpStreamTransport(hostInput: PinnedConnectionHostOptions) {
  const connections = createPinnedConnectionHost(hostInput);
  async function send(input: PinnedHttpStreamRequest): Promise<PinnedHttpStreamResponse> {
    try {
      const value = record(input, ['policy', 'target', 'deadline', 'signal', 'method', 'headers', 'body', 'framing', 'rejectInformationalResponses'], ['policy', 'target', 'deadline', 'method', 'framing']);
      if (value.rejectInformationalResponses !== undefined && typeof value.rejectInformationalResponses !== 'boolean') throw error();
      const protocolError = (reason: PinnedHttpStreamProtocolError['reason']) => value.rejectInformationalResponses === true ? new PinnedHttpStreamProtocolError(reason) : error();
      if (typeof value.method !== 'string' || !/^[A-Z]{1,32}$/.test(value.method) || value.method === 'CONNECT' || typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)) throw error();
      if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw error();
      const framingRaw = record(value.framing, ['mode', 'length'], ['mode']);
      if (!['none', 'fixed', 'chunked'].includes(framingRaw.mode as string)) throw error();
      if (framingRaw.mode === 'fixed') { if (!Number.isSafeInteger(framingRaw.length) || Number(framingRaw.length) < 0) throw error(); }
      else if (Object.prototype.hasOwnProperty.call(framingRaw, 'length')) throw error();
      const framing = Object.freeze(framingRaw) as unknown as PinnedStreamFraming;
      const body = value.body as Readable | undefined;
      if (body !== undefined && (!(body instanceof Readable) || body.readableObjectMode || body.readableFlowing === true || body.readableEnded || body.destroyed || claimedBodies.has(body))) throw error();
      if (framing.mode === 'none' && body !== undefined || framing.mode === 'chunked' && !body || framing.mode === 'fixed' && framing.length > 0 && !body) throw error();
      const headers = pinnedHeaders(value.headers), callerSignal = value.signal as AbortSignal | undefined;
      if (body) claimedBodies.add(body);
      const controller = new AbortController();
      const request = { policy: value.policy, target: value.target, deadline: value.deadline, signal: controller.signal } as ControlledDnsRequest;
      let finished = false, published = false, requestFinished = false, responseConsumed = false;
      let requestBytes = 0, responseBytes = 0;
      let outgoing: http.ClientRequest | undefined, incoming: http.IncomingMessage | undefined, responseBody: Readable | undefined, responseTap: Transform | undefined, requestBody: Transform | undefined, requestSource: Readable | undefined;
      let connection: Awaited<ReturnType<typeof connections.prepare>> | undefined;
      let resolveResponse!: (value: PinnedHttpStreamResponse) => void, rejectResponse!: (failure: ControlledDnsError) => void;
      let resolveCompletion!: (value: PinnedHttpStreamCompletion) => void, rejectCompletion!: (failure: ControlledDnsError) => void;
      const responsePromise = new Promise<PinnedHttpStreamResponse>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
      const completed = new Promise<PinnedHttpStreamCompletion>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
      // Completion can fail before headers exist; observing it here avoids an unhandled rejection.
      void completed.catch(() => undefined);
      const cleanup = () => { clearTimeout(timer); callerSignal?.removeEventListener('abort', cancelled); body?.removeListener('error', sourceFailed); body?.removeListener('close', sourceClosed); };
      const destroy = () => { requestSource?.unpipe(requestBody); requestSource?.destroy(); body?.destroy(); requestBody?.destroy(); outgoing?.destroy(); incoming?.destroy(); responseTap?.destroy(); connection?.destroy(); };
      const fail = (failure: ControlledDnsError) => {
        if (finished) return; finished = true; cleanup(); controller.abort(); destroy(); responseBody?.destroy(failure);
        rejectCompletion(failure); if (!published) rejectResponse(failure);
      };
      const succeed = () => {
        if (finished || !requestFinished || !responseConsumed) return;
        finished = true; cleanup();
        const rawTrailers = Object.freeze([...(incoming?.rawTrailers ?? [])]); destroy();
        resolveCompletion(Object.freeze({ requestBytes, responseBytes, rawTrailers }));
      };
      const cancelled = () => fail(error('ABORT_ERR'));
      const sourceFailed = () => fail(error('upstream_network_policy_unavailable'));
      const sourceClosed = () => { if (!body?.readableEnded) sourceFailed(); };
      const timer = setTimeout(() => fail(error('ETIMEDOUT')), Math.min(2147483647, Math.max(1, request.deadline - Date.now())));
      callerSignal?.addEventListener('abort', cancelled, { once: true }); body?.once('error', sourceFailed); body?.once('close', sourceClosed);
      const startBody = () => {
        if (finished || !outgoing || !connection) return;
        try {
          connection.check();
          if (!body) { outgoing.end(); return; }
          requestBody = new Transform({ highWaterMark: HIGH_WATER_MARK, transform(chunk: Buffer, _encoding, callback) {
            requestBytes += chunk.length;
            if (!Number.isSafeInteger(requestBytes) || framing.mode === 'fixed' && requestBytes > framing.length) { callback(protocolError('request_length')); return; }
            callback(null, chunk);
          }, flush(callback) { callback(framing.mode === 'fixed' && requestBytes !== framing.length ? protocolError('request_length') : undefined); } });
          requestBody.once('error', failure => fail(failure instanceof ControlledDnsError ? failure : error()));
          // Keep private writable destinations out of the caller-owned source's pipe state.
          requestSource = Readable.from(body, { objectMode: false, highWaterMark: HIGH_WATER_MARK });
          requestSource.once('error', sourceFailed);
          requestSource.pipe(requestBody).pipe(outgoing);
        } catch { fail(error()); }
      };
      if (callerSignal?.aborted) cancelled();
      else if (Date.now() >= request.deadline) fail(error('ETIMEDOUT'));
      else void connections.prepare(request, fail, startBody).then(prepared => {
        if (finished) { prepared.destroy(); return; }
        connection = prepared;
        try {
          prepared.check(); const { resolution, url, agent } = prepared;
          const authority = `${resolution.host.includes(':') ? '[' + resolution.host + ']' : resolution.host}:${resolution.port}`;
          outgoing = (url.protocol === 'https:' ? https : http).request({ protocol: url.protocol, hostname: resolution.host, port: resolution.port,
            method: value.method as string, path: url.pathname + url.search, agent,
            headers: { ...headers, host: authority, connection: 'close', ...(framing.mode === 'fixed' ? { 'content-length': String(framing.length) } : framing.mode === 'chunked' ? { 'transfer-encoding': 'chunked' } : {}) } }, response => {
            incoming = response;
            if (finished) { response.destroy(); return; }
            if (!requestFinished) { fail(protocolError('early_response')); return; }
            const declared = response.headers['content-length'];
            if (declared && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) { fail(protocolError('response_length')); return; }
            const noBody = value.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304;
            const expected = noBody ? 0 : declared === undefined ? undefined : Number(declared);
            responseTap = new Transform({ highWaterMark: HIGH_WATER_MARK, transform(chunk: Buffer, _encoding, callback) {
              responseBytes += chunk.length;
              if (!Number.isSafeInteger(responseBytes) || expected !== undefined && responseBytes > expected) { callback(protocolError('response_length')); return; }
              callback(null, chunk);
            }, flush(callback) { callback(expected !== undefined && responseBytes !== expected ? protocolError('response_length') : undefined); } });
            // A direct pipe into a public Transform would expose IncomingMessage/socket in its
            // 'unpipe' event. The iterator wrapper exposes only bytes, never the private source.
            responseBody = Readable.from(responseTap, { objectMode: false, highWaterMark: HIGH_WATER_MARK });
            responseTap.on('error', failure => fail(responseBody?.destroyed ? error('ABORT_ERR') : failure instanceof ControlledDnsError ? failure : error('upstream_network_policy_unavailable')));
            responseBody.on('error', failure => fail(failure instanceof ControlledDnsError ? failure : error('upstream_network_policy_unavailable')));
            responseBody.once('end', () => { responseConsumed = true; succeed(); });
            responseBody.once('close', () => { if (!responseConsumed && !finished) fail(error('ABORT_ERR')); });
            response.once('error', () => fail(error('upstream_network_policy_unavailable')));
            response.once('aborted', () => fail(error('upstream_network_policy_unavailable')));
            const responseHeaders: Record<string, string | readonly string[]> = {};
            for (const [key, entry] of Object.entries(response.headers)) if (entry !== undefined) responseHeaders[key] = Array.isArray(entry) ? Object.freeze([...entry]) : entry;
            published = true;
            resolveResponse(Object.freeze({ statusCode: response.statusCode ?? 502, headers: Object.freeze(responseHeaders), rawHeaders: Object.freeze([...response.rawHeaders]), body: responseBody, completed }));
            response.pipe(responseTap);
          });
          outgoing.once('finish', () => { requestFinished = true; succeed(); });
          outgoing.once('error', failure => fail((failure as NodeJS.ErrnoException).code?.startsWith('HPE_') ? protocolError('parse') : error('upstream_network_policy_unavailable')));
          if (value.rejectInformationalResponses === true) outgoing.on('information', () => fail(protocolError('informational')));
          outgoing.once('upgrade', (_response, upgraded) => { upgraded.destroy(); fail(protocolError('upgrade')); });
        } catch (failure) { fail(failure instanceof ControlledDnsError ? failure : error()); }
      }).catch(failure => fail(failure instanceof ControlledDnsError ? failure : error()));
      return await responsePromise;
    } catch (failure) { if (failure instanceof ControlledDnsError) throw failure; throw error(); }
  }
  return Object.freeze({ send });
}
