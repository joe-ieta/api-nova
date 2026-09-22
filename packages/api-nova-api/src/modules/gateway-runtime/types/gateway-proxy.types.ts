import { GatewayPayloadCapture } from '../services/gateway-request-capture.service';

export type GatewayProxyResult = {
  headerCacheSignals?: {
    policyIdentity: string;
    credentialCacheIdentity?: string;
    age?: string;
    setCookie: boolean;
    pragma: boolean;
    cacheControl?: string;
    vary?: string;
    contentType?: string;
  };
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  requestCapture?: GatewayPayloadCapture;
  responseCapture?: GatewayPayloadCapture;
  responseBodyBuffer?: Buffer;
};
