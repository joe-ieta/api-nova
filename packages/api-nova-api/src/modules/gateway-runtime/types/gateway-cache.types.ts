export type GatewayCacheEntry = {
  headerPolicyIdentity?: string;
  key: string;
  runtimeAssetId: string;
  routeBindingId: string;
  method: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  contentType?: string;
  contentLength?: number;
  responseBytes: number;
  responseBodyPreview?: string;
  responseBodyHash?: string;
  expiresAt: number;
  createdAt: number;
};

export type GatewayCacheLookupResult =
  | {
      key: string;
      hit: false;
    }
  | {
      key: string;
      hit: true;
      entry: GatewayCacheEntry;
    };

/** Validated outbound business values, never credential values. */
export type GatewayHeaderCacheRequest = {
  normalizedRequestHeaders: Record<string, string>;
  cacheBypass: boolean;
  contentLength?: number;
  chunked: boolean;
  credentialCacheIdentity?: string;
};
