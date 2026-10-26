import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PAYLOAD_PHYSICAL_GUARD_ENV, observePayloadFreeSpace, payloadPhysicalBoundary, payloadPhysicalGuardEnabled,
} from './call-observability-payload-physical';

const configuration = (overrides: Record<string, number> = {}) => ({
  minimumFreeBytes: 1000, maxObservationAgeMs: 15000, ...overrides,
});
const fresh = (availableBytes: number, observedAtMs: number) => (
  { availableBytes, observedAtMs, source: 'filesystem_statfs' as const });

describe('OBS-14-05D payload physical free-space guard', () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'obs-05d-physical-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('is default off and only the exact string true enables it', () => {
    expect(PAYLOAD_PHYSICAL_GUARD_ENV).toBe('API_NOVA_OBSERVABILITY_PAYLOAD_QUOTA_PHYSICAL_ENABLED');
    expect(payloadPhysicalGuardEnabled(undefined)).toBe(false);
    expect(payloadPhysicalGuardEnabled('')).toBe(false);
    expect(payloadPhysicalGuardEnabled('false')).toBe(false);
    expect(payloadPhysicalGuardEnabled('1')).toBe(false);
    expect(payloadPhysicalGuardEnabled('TRUE')).toBe(false);
    expect(payloadPhysicalGuardEnabled('true')).toBe(true);
  });

  it('reads real statfs numbers from the payload root and returns unknown instead of guessing', async () => {
    const observation = await observePayloadFreeSpace(directory);
    const stat = await fs.statfs(directory);
    expect(observation).toEqual({
      availableBytes: Number(stat.bavail) * Number(stat.bsize),
      observedAtMs: expect.any(Number),
      source: 'filesystem_statfs',
    });
    expect(Number.isSafeInteger(observation!.availableBytes)).toBe(true);
    expect(Math.abs(Date.now() - observation!.observedAtMs)).toBeLessThan(5000);
    expect(await observePayloadFreeSpace(join(directory, 'missing-root'))).toBeNull();
  });

  it('blocks below or at the reserve boundary, keeps the exact recovery edge and never treats stale or absent evidence as space', () => {
    const now = 1_000_000, bytes = 100;
    expect(payloadPhysicalBoundary(configuration(), bytes, null, now))
      .toEqual({ status: 'blocked', reason: 'quota_physical_unknown', availableBytes: null });
    expect(payloadPhysicalBoundary(configuration(), bytes, fresh(1000, now), now))
      .toEqual({ status: 'blocked', reason: 'quota_physical_low', availableBytes: 1000 });
    expect(payloadPhysicalBoundary(configuration(), bytes, fresh(1100, now), now))
      .toEqual({ status: 'blocked', reason: 'quota_physical_low', availableBytes: 1100 });
    expect(payloadPhysicalBoundary(configuration(), bytes, fresh(1101, now), now)).toEqual({ status: 'allowed' });
    expect(payloadPhysicalBoundary(configuration(), 200, fresh(1200, now), now))
      .toMatchObject({ status: 'blocked', reason: 'quota_physical_low' });
    expect(payloadPhysicalBoundary(configuration(), 200, fresh(1201, now), now)).toEqual({ status: 'allowed' });
    expect(payloadPhysicalBoundary(configuration(), bytes, fresh(1101, now - 15000), now)).toEqual({ status: 'allowed' });
    for (const observation of [fresh(1101, now - 15001), fresh(1101, now + 1),
      { ...fresh(1101, now), source: 'estimate' as never }, { ...fresh(1101, now), availableBytes: -1 }]) {
      expect(payloadPhysicalBoundary(configuration(), bytes, observation, now))
        .toMatchObject({ status: 'blocked', reason: 'quota_physical_unknown' });
    }
  });
});
