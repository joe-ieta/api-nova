import { Injectable } from '@nestjs/common';
import { GatewayRouteBindingEntity } from '../../../database/entities/gateway-route-binding.entity';
import {
  GatewayCompiledPolicyBundle,
  GatewayLoggingCaptureMode,
} from '../types/gateway-policy.types';

@Injectable()
export class GatewayPolicyService {
  compileForRoute(routeBinding: GatewayRouteBindingEntity): GatewayCompiledPolicyBundle {
    return {
      auth: {
        ref: routeBinding.authPolicyRef,
        mode: this.resolveAuthMode(routeBinding.authPolicyRef),
        apiKeyQueryParamName: this.resolveApiKeyQueryParamName(routeBinding.upstreamConfig),
      },
      traffic: {
        ref: routeBinding.trafficPolicyRef,
        timeoutMs: routeBinding.timeoutMs ?? 30000,
        retryPolicy: routeBinding.retryPolicy || undefined,
        rateLimitRef: routeBinding.rateLimitPolicyRef,
        circuitBreakerRef: routeBinding.circuitBreakerPolicyRef,
        trafficControl: this.resolveTrafficControl(routeBinding),
      },
      logging: {
        ref: routeBinding.loggingPolicyRef,
        captureMode: this.resolveLoggingCaptureMode(routeBinding.loggingPolicyRef),
      },
      cache: {
        ref: routeBinding.cachePolicyRef,
        enabled: Boolean(routeBinding.cachePolicyRef),
        methods: ['GET', 'HEAD'],
        ...this.resolveCacheConfig(routeBinding.upstreamConfig),
      },
      upstream: {
        raw: routeBinding.upstreamConfig || undefined,
      },
    };
  }

  private resolveAuthMode(ref?: string) {
    const normalized = String(ref || '')
      .trim()
      .toLowerCase();

    if (!normalized) {
      return 'anonymous' as const;
    }
    if (normalized.includes('api-key') || normalized.includes('apikey') || normalized.includes('key')) {
      return 'api_key' as const;
    }
    if (normalized.includes('jwt') || normalized.includes('bearer') || normalized.includes('token')) {
      return 'jwt' as const;
    }
    return 'anonymous' as const;
  }

  private resolveLoggingCaptureMode(ref?: string): GatewayLoggingCaptureMode {
    const normalized = String(ref || '')
      .trim()
      .toLowerCase();

    if (!normalized) {
      return 'meta_only';
    }
    if (normalized.includes('full')) {
      return 'full_body';
    }
    if (normalized.includes('error')) {
      return 'body_on_error';
    }
    if (normalized.includes('preview') || normalized.includes('body')) {
      return 'body_preview';
    }
    return 'meta_only';
  }

  private resolveApiKeyQueryParamName(upstreamConfig?: Record<string, unknown>) {
    const value = upstreamConfig?.apiKeyQueryParam;
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    return normalized || undefined;
  }

  private resolveTrafficControl(routeBinding: GatewayRouteBindingEntity) {
    const raw = routeBinding.upstreamConfig?.trafficControl;
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const trafficControl = raw as Record<string, unknown>;
    const rateLimit = this.resolveRateLimitConfig(trafficControl.rateLimit);
    const concurrency = this.resolveConcurrencyConfig(trafficControl.concurrency);
    const breaker = this.resolveBreakerConfig(trafficControl.breaker);

    if (!rateLimit && !concurrency && !breaker) {
      return undefined;
    }

    return {
      rateLimit,
      concurrency,
      breaker,
    };
  }

  private resolveCacheConfig(upstreamConfig?: Record<string, unknown>) {
    const raw = upstreamConfig?.cache;
    if (!raw || typeof raw !== 'object') {
      return {};
    }

    const config = raw as Record<string, unknown>;
    const ttlMs = this.positiveNumber(config.ttlMs);
    const maxBodyBytes = this.positiveNumber(config.maxBodyBytes);

    return {
      ttlMs: ttlMs ?? 30000,
      maxBodyBytes: maxBodyBytes ?? 262144,
      varyQueryKeys: this.stringArray(config.varyQueryKeys),
      varyHeaderKeys: this.stringArray(config.varyHeaderKeys)?.map(item => item.toLowerCase()),
      varyByConsumer: Boolean(config.varyByConsumer),
    };
  }

  private resolveRateLimitConfig(raw: unknown) {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const config = raw as Record<string, unknown>;
    const windowMs = this.positiveNumber(config.windowMs);
    if (!windowMs) {
      return undefined;
    }

    return {
      windowMs,
      globalMax: this.positiveNumber(config.globalMax),
      runtimeAssetMax: this.positiveNumber(config.runtimeAssetMax),
      routeMax: this.positiveNumber(config.routeMax),
      consumerMax: this.positiveNumber(config.consumerMax),
    };
  }

  private resolveConcurrencyConfig(raw: unknown) {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const config = raw as Record<string, unknown>;
    const runtimeAssetMax = this.positiveNumber(config.runtimeAssetMax);
    const routeMax = this.positiveNumber(config.routeMax);
    if (!runtimeAssetMax && !routeMax) {
      return undefined;
    }

    return {
      runtimeAssetMax,
      routeMax,
    };
  }

  private resolveBreakerConfig(raw: unknown) {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const config = raw as Record<string, unknown>;
    const failureThreshold = this.positiveNumber(config.failureThreshold);
    const cooldownMs = this.positiveNumber(config.cooldownMs);
    if (!failureThreshold || !cooldownMs) {
      return undefined;
    }

    return {
      failureThreshold,
      cooldownMs,
      halfOpenMax: this.positiveNumber(config.halfOpenMax),
    };
  }

  private positiveNumber(value: unknown) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
  }

  private stringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const normalized = value
      .map(item => String(item || '').trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
}
