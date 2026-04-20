import { GatewayPayloadCapture } from '../services/gateway-request-capture.service';

export type GatewayProxyResult = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  requestCapture?: GatewayPayloadCapture;
  responseCapture?: GatewayPayloadCapture;
};
