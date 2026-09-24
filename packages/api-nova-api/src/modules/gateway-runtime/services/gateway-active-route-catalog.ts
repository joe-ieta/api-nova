/** Host-only lifecycle evidence. These identifiers never constitute network admission. */
export type GatewayActiveRouteIdentity = Readonly<{
  runtimeAssetId: string;
  routeBindingId: string;
  revision: string;
  fingerprint: string;
}>;
export type GatewayActiveRouteCatalogSnapshot = Readonly<{
  version: number;
  routes: readonly GatewayActiveRouteIdentity[];
}>;
export type GatewayActiveRouteCatalogEvent = Readonly<{
  kind: 'reload' | 'removed';
  snapshot: GatewayActiveRouteCatalogSnapshot;
}>;

export class GatewayActiveRouteCatalog {
  private current?: GatewayActiveRouteCatalogSnapshot;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(event: GatewayActiveRouteCatalogEvent) => void>();

  read(): GatewayActiveRouteCatalogSnapshot {
    if (this.controller.signal.aborted || !this.current) throw new Error('GATEWAY_ACTIVE_CATALOG_NOT_READY');
    return this.current;
  }

  subscribe(listener: (event: GatewayActiveRouteCatalogEvent) => void) {
    if (this.controller.signal.aborted || typeof listener !== 'function' || this.listeners.size >= 128) {
      throw new Error('GATEWAY_ACTIVE_CATALOG_NOT_READY');
    }
    this.listeners.add(listener);
    return Object.freeze({
      signal: this.controller.signal,
      close: () => { this.listeners.delete(listener); },
    });
  }

  replace(
    routes: readonly GatewayActiveRouteIdentity[],
    commit: (snapshot: GatewayActiveRouteCatalogSnapshot) => void,
  ) {
    if (this.controller.signal.aborted) return;
    if (routes.length > 10000) throw new Error('GATEWAY_ACTIVE_CATALOG_TOO_LARGE');
    const keys = new Set<string>();
    const copied = routes.map(route => {
      for (const value of [route.runtimeAssetId, route.routeBindingId, route.revision]) {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) {
          throw new Error('GATEWAY_ACTIVE_CATALOG_INVALID');
        }
      }
      if (!/^[a-f0-9]{64}$/.test(route.fingerprint)) throw new Error('GATEWAY_ACTIVE_CATALOG_INVALID');
      const key = `${route.runtimeAssetId}/${route.routeBindingId}`;
      if (keys.has(key)) throw new Error('GATEWAY_ACTIVE_CATALOG_INVALID');
      keys.add(key);
      return Object.freeze({ runtimeAssetId: route.runtimeAssetId, routeBindingId: route.routeBindingId,
        revision: route.revision, fingerprint: route.fingerprint });
    }).sort((a, b) => a.runtimeAssetId.localeCompare(b.runtimeAssetId) || a.routeBindingId.localeCompare(b.routeBindingId));
    this.publish('reload', copied, commit);
  }

  remove(
    runtimeAssetId: string,
    commit: (snapshot: GatewayActiveRouteCatalogSnapshot) => void,
  ) {
    if (this.controller.signal.aborted) return;
    this.publish(
      'removed',
      (this.current?.routes || []).filter(route => route.runtimeAssetId !== runtimeAssetId),
      commit,
    );
  }

  close() {
    this.current = undefined;
    this.listeners.clear();
    this.controller.abort();
  }

  private publish(
    kind: GatewayActiveRouteCatalogEvent['kind'],
    routes: readonly GatewayActiveRouteIdentity[],
    commit: (snapshot: GatewayActiveRouteCatalogSnapshot) => void,
  ) {
    const snapshot = Object.freeze({
      version: (this.current?.version || 0) + 1,
      routes: Object.freeze(routes),
    });
    commit(snapshot);
    this.current = snapshot;
    const event = Object.freeze({ kind, snapshot });
    for (const listener of [...this.listeners]) {
      if (this.controller.signal.aborted || this.current !== event.snapshot) break;
      if (!this.listeners.has(listener)) continue;
      try {
        // Async observers cannot participate in this synchronous revocation boundary.
        const result: unknown = listener(event);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          this.close();
        }
      } catch { this.close(); }
    }
  }
}
