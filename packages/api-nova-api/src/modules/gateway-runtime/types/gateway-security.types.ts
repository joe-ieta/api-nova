import { GatewayAuthMode } from './gateway-policy.types';
import type { RuntimePrincipal } from 'api-nova-parser';

export type GatewayRequestAuthContext = {
  mode: GatewayAuthMode;
  actorId?: string;
  consumerId?: string;
  keyId?: string;
  principal?: RuntimePrincipal;
};
