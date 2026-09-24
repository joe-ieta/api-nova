import { createGatewayTrustedNetworkFacade, type GatewayNetworkHostInstallation } from './gateway-trusted-network.provider';

/** Explicit host-only composition; no environment/config/request activation and no Nest registration. */
export function createGatewayNetworkHostProviders(installation?: GatewayNetworkHostInstallation) {
  if (installation === undefined) return null;
  const facade = createGatewayTrustedNetworkFacade();
  try { facade.install(installation); return facade; }
  catch (error) { facade.close(); throw error; }
}
