import { ServiceUnavailableException } from '@nestjs/common';
import type { ValueProvider } from '@nestjs/common';
import type { UpstreamCredentialRegistrySnapshot } from 'api-nova-parser';

/**
 * Shared startup dependency for explicit host mode. Only an explicit host
 * composition may supply a branded runtime; null or undefined means the legacy
 * path is unchanged. Never derived from request, config, environment or file.
 */
export const GATEWAY_HOST_RUNTIME = Symbol('GATEWAY_HOST_RUNTIME');

export type GatewayHostRuntimeState = Readonly<{
  mode: 'host';
  locked: boolean;
  lockReason?: string;
}>;

export interface GatewayHostRuntime {
  readonly mode: 'host';
  captureSnapshot(): UpstreamCredentialRegistrySnapshot;
  lock(reason?: string): void;
  state(): GatewayHostRuntimeState;
  assertOpen(): void;
}

const branded = new WeakSet<object>();

export function createGatewayHostRuntime(input: {
  captureSnapshot: () => UpstreamCredentialRegistrySnapshot;
  locked?: boolean;
  lockReason?: string;
}): GatewayHostRuntime {
  if (!input || typeof input.captureSnapshot !== 'function') {
    throw new Error('gateway_host_runtime_invalid');
  }
  let locked = input.locked === true;
  let lockReason = locked && typeof input.lockReason === 'string' && input.lockReason.trim()
    ? input.lockReason.trim().slice(0, 120) : undefined;
  const runtime: GatewayHostRuntime = Object.freeze({
    mode: 'host' as const,
    captureSnapshot: () => {
      if (locked) throw new ServiceUnavailableException('gateway_host_runtime_locked');
      return input.captureSnapshot();
    },
    lock: (reason?: string) => {
      if (locked) return;
      locked = true;
      if (typeof reason === 'string' && reason.trim()) lockReason = reason.trim().slice(0, 120);
    },
    state: () => Object.freeze({
      mode: 'host' as const,
      locked,
      ...(locked && lockReason ? { lockReason } : {}),
    }),
    assertOpen: () => {
      if (locked) throw new ServiceUnavailableException('gateway_host_runtime_locked');
    },
  });
  branded.add(runtime);
  return runtime;
}

export function assertGatewayHostRuntime(value: unknown): GatewayHostRuntime {
  if (!value || typeof value !== 'object' || !branded.has(value as object)) {
    throw new Error('gateway_host_runtime_invalid');
  }
  return value as GatewayHostRuntime;
}

/** Only null or undefined are default-off; anything else must be a branded host runtime. */
export function resolveGatewayHostRuntime(value: unknown): GatewayHostRuntime | null {
  if (value === null || value === undefined) return null;
  return assertGatewayHostRuntime(value);
}

export const gatewayHostRuntimeProvider: ValueProvider<null> = {
  provide: GATEWAY_HOST_RUNTIME,
  useValue: null,
};
