export type GatewayCacheEntry = {
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
