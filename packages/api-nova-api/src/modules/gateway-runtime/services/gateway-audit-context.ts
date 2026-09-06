import { auditDigest, redactAuditUrl, RuntimeCallContext } from 'api-nova-parser';
import { Request } from 'express';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayRequestAuthContext } from '../types/gateway-security.types';

export function gatewayAuditContext(req: Request, requestId: string, route?: GatewayResolvedRoute): RuntimeCallContext {
  const auth = (req as Request & { gatewayAuth?: GatewayRequestAuthContext }).gatewayAuth;
  const principal = auth?.principal;
  const issuer = principal?.issuer || (auth?.actorId ? 'api-nova-local' : auth?.consumerId ? 'api-nova-key' : undefined);
  const subject = principal?.subject || auth?.actorId || auth?.consumerId;
  return { transport: 'gateway', requestId,
    correlationId: typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'].slice(0, 120) : undefined,
    identitySource: subject ? 'authenticated' : 'anonymous', callerId: principal?.callerId ||
      (subject ? auditDigest(`${issuer}\0${subject}`) : undefined), callerIssuer: issuer, callerSubject: subject,
    credentialId: principal?.credentialId || auth?.keyId, clientId: principal?.clientId, scopes: principal?.scopes,
    runtimeAssetId: route?.runtimeAsset.id, endpointDefinitionId: route?.endpointDefinition.id,
    sourceServiceInstanceId: route?.sourceServiceInstance?.id, clientIp: req.ip || req.socket?.remoteAddress };
}

export function gatewayAuditUrl(req: Request, route?: GatewayResolvedRoute) {
  const url = new URL(req.originalUrl || req.url || '/', 'http://gateway.local');
  const key = route?.policies?.auth.apiKeyQueryParamName;
  if (key && url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
  return redactAuditUrl(url.toString());
}
