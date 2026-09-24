import { BadGatewayException, GatewayTimeoutException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { ControlledDnsError, PinnedHttpStreamProtocolError, runRuntimeUpstreamAttempt } from 'api-nova-parser';
import type { GatewayPreparedProxyRequest } from './gateway-proxy-engine.service';
import type { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import type { GatewayTrustedNetworkProvider } from './gateway-trusted-network.provider';
import { GatewayRequestCaptureService } from './gateway-request-capture.service';
import { filterGatewayResponseHeadersV1, GatewayHeaderWireError } from './gateway-header-wire-policy';
import { ensureGatewayRequestId, gatewayAuditContext } from './gateway-audit-context';
/** D1 owns framing and sanitization; B3a owns DNS, verified socket and binary backpressure. */
export async function forwardGatewayNetworkStream(provider: GatewayTrustedNetworkProvider, prepared: GatewayPreparedProxyRequest,
  route: GatewayResolvedRoute, req: Request, res: Response, capture: GatewayRequestCaptureService,
  options?: { attemptIndex?: number; upstreamOperationId?: string; discardedTrailers?: (direction: 'request' | 'response') => void }) {
  const { networkLease, requestPolicy, compiledHeaderPolicy, credentials, url } = prepared;
  if (!networkLease || !requestPolicy || !compiledHeaderPolicy) throw new ServiceUnavailableException('gateway_network_policy_unavailable');
  const controller = new AbortController();
  const cancel = () => controller.abort(); const closed = () => { if (!res.writableFinished) cancel(); };
  req.once('aborted', cancel); req.once('error', cancel); res.once('close', closed); res.once('error', cancel);
  if (req.aborted || res.destroyed) cancel();
  const requestId = ensureGatewayRequestId(req, res), requestCapture = capture.createTracker(req.headers['content-type']);
  const headers = { ...requestPolicy.headers }; delete headers.host; delete headers['content-length']; delete headers['transfer-encoding'];
  const framing = requestPolicy.chunked ? { mode: 'chunked' as const } : requestPolicy.contentLength !== undefined ? { mode: 'fixed' as const, length: requestPolicy.contentLength } : { mode: 'none' as const };
  let source: Readable | undefined, responseBody: Readable | undefined;
  try {
    return await runRuntimeUpstreamAttempt({ context: { ...gatewayAuditContext(req, requestId, route), upstreamOperationId: options?.upstreamOperationId },
      method: route.routeBinding.upstreamMethod, url: url.href, attemptIndex: options?.attemptIndex ?? 1, redirectHopIndex: 0,
      requestHeaders: headers, requestContentType: String(req.headers['content-type'] || ''), credentialHeaderNames: [...credentials.credentialHeaderNames] }, async observer => {
      if (framing.mode === 'chunked' || framing.mode === 'fixed' && framing.length > 0) {
        if (req.readableEnded) throw new BadGatewayException('gateway_network_body_unavailable');
        // Creating the iterator is inert. It is consumed only after B3a verifies the socket.
        source = Readable.from((async function* () { for await (const chunk of req) { requestCapture.observeChunk(chunk); observer.requestChunk(chunk); yield chunk; } })(), { objectMode: false, highWaterMark: 65536 });
      }
      const response = await provider.send(networkLease, { headers, framing, ...(source ? { body: source } : {}), signal: controller.signal });
      responseBody = response.body; observer.requestComplete();
      if (req.rawTrailers?.length) options?.discardedTrailers?.('request');
      const responsePolicy = filterGatewayResponseHeadersV1({ policy: compiledHeaderPolicy, rawHeaders: response.rawHeaders, headers: response.headers as any,
        statusCode: response.statusCode, requestMethod: route.routeBinding.upstreamMethod, managedHeaderNames: credentials.managedHeaderNames,
        consumerAuthenticationHeaderNames: route.policies.upstream?.consumerAuthenticationHeaderNames, historicalAuthenticationHeaderNames: prepared.historicalAuthenticationHeaderNames });
      const responseCapture = capture.createTracker(response.headers['content-type'] as string | undefined);
      observer.responseStarted(response.statusCode, responsePolicy.headers, String(response.headers['content-type'] || ''));
      res.status(response.statusCode); for (const [name, value] of Object.entries(responsePolicy.headers)) if (value !== undefined) res.setHeader(name, value);
      res.setHeader('x-request-id', requestId); res.flushHeaders?.();
      let bytes = 0;
      const tapped = Readable.from((async function* () { for await (const chunk of response.body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
        if (!responsePolicy.bodyAllowed && bytes || responsePolicy.bodyAllowed && responsePolicy.contentLength !== undefined && bytes > responsePolicy.contentLength) throw new GatewayHeaderWireError(502, 'gateway_header_body_length');
        responseCapture.observeChunk(data); observer.responseChunk(data); yield data;
      }
      if (responsePolicy.bodyAllowed && responsePolicy.contentLength !== undefined && bytes !== responsePolicy.contentLength) throw new GatewayHeaderWireError(502, 'gateway_header_body_length');
      })(), { objectMode: false, highWaterMark: 65536 });
      const [, completion] = await Promise.all([pipeline(tapped, res), response.completed]);
      if (completion.rawTrailers.length) options?.discardedTrailers?.('response'); observer.responseComplete();
      return { statusCode: response.statusCode, headers: responsePolicy.headers, requestCapture: requestCapture.finalize(), responseCapture: responseCapture.finalize(), targetUrl: url.href };
    });
  } catch (failure) {
    controller.abort(); source?.destroy(); responseBody?.destroy(); if (res.headersSent && !res.writableFinished) res.destroy();
    if (failure instanceof GatewayHeaderWireError) throw new HttpException(failure.code, failure.statusCode);
    if (failure instanceof PinnedHttpStreamProtocolError) {
      const codes = { informational: 'gateway_header_response_status', early_response: 'gateway_header_early_response', request_length: 'gateway_header_body_length', response_length: 'gateway_header_body_length', upgrade: 'gateway_header_upgrade_unsupported', parse: 'gateway_header_upstream_parse' };
      throw new HttpException(codes[failure.reason], failure.reason === 'request_length' ? 400 : 502);
    }
    if (failure instanceof ControlledDnsError) {
      if (failure.code === 'ETIMEDOUT') throw new GatewayTimeoutException('gateway_network_timeout');
      if (failure.code === 'upstream_network_policy_denied') throw new BadGatewayException(failure.code);
      if (failure.code === 'upstream_network_policy_unavailable') throw new ServiceUnavailableException(failure.code);
      throw new ServiceUnavailableException('gateway_network_policy_unavailable');
    }
    throw failure;
  } finally { provider.close(networkLease); req.removeListener('aborted', cancel); req.removeListener('error', cancel); res.removeListener('close', closed); res.removeListener('error', cancel); }
}
