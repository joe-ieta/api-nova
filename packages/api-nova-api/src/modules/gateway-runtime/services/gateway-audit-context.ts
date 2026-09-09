import { randomUUID } from 'node:crypto';
import { auditDigest, redactAuditUrl, RuntimeCallContext } from 'api-nova-parser';
import { Request, Response } from 'express';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayRequestAuthContext } from '../types/gateway-security.types';

const identities = new WeakMap<Request, { internal: string; client?: string }>();

export function ensureGatewayRequestId(req: Request, res?: Response): string {
  let identity = identities.get(req);
  if (!identity) {
    const presented = req.headers['x-request-id'];
    const client = Array.isArray(presented) ? presented[0] : presented;
    identity = { internal: randomUUID(),
      client: typeof client === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(client) ? client : undefined };
    identities.set(req, identity);
  }
  req.headers['x-request-id'] = identity.internal;
  if (res && !res.headersSent) res.setHeader('x-request-id', identity.internal);
  return identity.internal;
}

export function gatewayAuditContext(req: Request, requestId: string, route?: GatewayResolvedRoute): RuntimeCallContext {
  const auth = (req as Request & { gatewayAuth?: GatewayRequestAuthContext }).gatewayAuth;
  const principal = auth?.principal;
  const issuer = principal?.issuer || (auth?.actorId ? 'api-nova-local' : auth?.consumerId ? 'api-nova-key' : undefined);
  const subject = principal?.subject || auth?.actorId || auth?.consumerId;
  const peerIp = req.socket?.remoteAddress;
  return { transport: 'gateway', protocolTransport: 'http', requestId,
    clientRequestId: identities.get(req)?.client,
    correlationId: typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined,
    identitySource: subject ? 'authenticated' : 'anonymous',
    authState: subject ? 'authenticated' : 'anonymous',
    callerId: principal?.callerId || (subject ? auditDigest(`${issuer}\0${subject}`) : undefined),
    callerIssuer: issuer, callerSubject: subject,
    credentialId: principal?.credentialId || auth?.keyId, clientId: principal?.clientId, scopes: principal?.scopes,
    runtimeAssetId: route?.runtimeAsset.id, runtimeAssetEndpointBindingId: route?.membership?.id,
    endpointDefinitionId: route?.endpointDefinition.id, sourceServiceAssetId: route?.sourceServiceAsset?.id,
    sourceServiceInstanceId: route?.sourceServiceInstance?.id,
    clientIp: peerIp, peerIp, ipSource: peerIp ? 'peer' : 'unknown', proxyTrusted: false };
}

export function gatewayAuditUrl(req: Request, route?: GatewayResolvedRoute) {
  const url = new URL(req.originalUrl || req.url || '/', 'http://gateway.local');
  const key = route?.policies?.auth.apiKeyQueryParamName;
  if (key && url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
  return redactAuditUrl(url.toString());
}
