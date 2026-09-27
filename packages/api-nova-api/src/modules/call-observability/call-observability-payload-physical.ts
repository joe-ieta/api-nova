import { promises as fs } from 'fs';

export const PAYLOAD_PHYSICAL_GUARD_ENV = 'API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_PHYSICAL_ENABLED';

export interface PayloadPhysicalSpaceObservation {
  availableBytes: number;
  observedAtMs: number;
  source: 'filesystem_statfs';
}

export interface PayloadPhysicalConfiguration {
  minimumFreeBytes: number;
  maxObservationAgeMs: number;
}

export type PayloadPhysicalBoundary =
  | { status: 'allowed' }
  | { status: 'blocked'; reason: 'quota_physical_unknown' | 'quota_physical_low'; availableBytes: number | null };

/** Default off. Only the exact string 'true' enables the physical guard. */
export function payloadPhysicalGuardEnabled(value: unknown = process.env[PAYLOAD_PHYSICAL_GUARD_ENV]): boolean {
  return value === 'true';
}

/** Real filesystem numbers (statfs equivalent); null means unknown, never sufficient. */
export async function observePayloadFreeSpace(root: string,
  nowMs = Date.now()): Promise<PayloadPhysicalSpaceObservation | null> {
  try {
    const stat = await fs.statfs(root);
    const availableBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(availableBytes) || availableBytes < 0) return null;
    return { availableBytes, observedAtMs: nowMs, source: 'filesystem_statfs' };
  } catch {
    return null;
  }
}

export function payloadPhysicalBoundary(configuration: PayloadPhysicalConfiguration, bytes: number,
  observation: PayloadPhysicalSpaceObservation | null | undefined, nowMs: number): PayloadPhysicalBoundary {
  const unknown: PayloadPhysicalBoundary = { status: 'blocked', reason: 'quota_physical_unknown', availableBytes: null };
  if (!observation || observation.source !== 'filesystem_statfs' ||
    !Number.isSafeInteger(observation.availableBytes) || observation.availableBytes < 0 ||
    !Number.isSafeInteger(observation.observedAtMs) || !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(bytes) || bytes < 1) return unknown;
  const age = nowMs - observation.observedAtMs;
  if (age < 0 || age > configuration.maxObservationAgeMs) return unknown;
  const available = BigInt(observation.availableBytes);
  const reserve = BigInt(configuration.minimumFreeBytes);
  if (available <= reserve || available - BigInt(bytes) <= reserve) {
    return { status: 'blocked', reason: 'quota_physical_low', availableBytes: observation.availableBytes };
  }
  return { status: 'allowed' };
}
