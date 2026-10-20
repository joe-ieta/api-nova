import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { GatewayNetworkBootstrap } from './gateway-network-bootstrap';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';

@Injectable()
export class GatewayNetworkInstallationService implements OnApplicationBootstrap {
  constructor(
    private readonly bootstrap: GatewayNetworkBootstrap,
    private readonly routes: GatewayRouteSnapshotService,
  ) {}

  onApplicationBootstrap(): void {
    // Nest has awaited every onModuleInit, including real persisted-route loading.
    this.bootstrap.installCommittedRoutes(this.routes);
  }
}
