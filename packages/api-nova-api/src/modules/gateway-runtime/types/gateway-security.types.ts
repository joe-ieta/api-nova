import { GatewayAuthMode } from './gateway-policy.types';

export type GatewayRequestAuthContext = {
  mode: GatewayAuthMode;
  actorId?: string;
  consumerId?: string;
  keyId?: string;
};
