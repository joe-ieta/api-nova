import type { TemporaryAnonymousPolicy } from 'api-nova-parser';
export type GatewayAuthMode = 'anonymous' | 'jwt' | 'api_key';

export type GatewayLoggingCaptureMode =
  | 'meta_only'
  | 'body_preview'
  | 'body_on_error'
  | 'full_body';

export type GatewayResolvedAuthPolicy = {
  ref?: string;
  mode: GatewayAuthMode;
  apiKeyQueryParamName?: string;
  temporaryAnonymous?: TemporaryAnonymousPolicy;
};

export type GatewayResolvedTrafficPolicy = {
  ref?: string;
  timeoutMs: number;
  retryPolicy?: Record<string, unknown>;
  rateLimitRef?: string;
  circuitBreakerRef?: string;
  trafficControl?: GatewayTrafficControlConfig;
};

export type GatewayResolvedLoggingPolicy = {
  ref?: string;
  captureMode: GatewayLoggingCaptureMode;
};

export type GatewayResolvedCachePolicy = {
  ref?: string;
  enabled: boolean;
  methods: string[];
  ttlMs?: number;
  varyQueryKeys?: string[];
  varyHeaderKeys?: string[];
  varyByConsumer?: boolean;
  maxBodyBytes?: number;
};

export type GatewayResolvedUpstreamPolicy = {
  raw?: Record<string, unknown>;
};

export type GatewayTrafficRateLimitConfig = {
  windowMs: number;
  globalMax?: number;
  runtimeAssetMax?: number;
  routeMax?: number;
  consumerMax?: number;
  /** Per route and transport peer; forwarded headers are not trusted. */
  ipMax?: number;
  /** Shared by all explicitly anonymous requests to this route. */
  anonymousMax?: number;
};

export type GatewayTrafficConcurrencyConfig = {
  runtimeAssetMax?: number;
  routeMax?: number;
};

export type GatewayTrafficBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMax?: number;
};

export type GatewayTrafficControlConfig = {
  rateLimit?: GatewayTrafficRateLimitConfig;
  concurrency?: GatewayTrafficConcurrencyConfig;
  breaker?: GatewayTrafficBreakerConfig;
};

export type GatewayCompiledPolicyBundle = {
  auth: GatewayResolvedAuthPolicy;
  traffic: GatewayResolvedTrafficPolicy;
  logging: GatewayResolvedLoggingPolicy;
  cache: GatewayResolvedCachePolicy;
  upstream: GatewayResolvedUpstreamPolicy;
};
