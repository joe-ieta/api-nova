import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator } from '@nestjs/terminus';
import { promises as fs } from 'fs';

export const MIN_DISK_FREE_BYTES = 5 * 1024 * 1024 * 1024;

@Injectable()
export class DiskFreeSpaceHealthIndicator extends HealthIndicator {
  async checkStorage(key: string, path: string) {
    let freeBytes: number;
    try {
      const stat = await fs.statfs(path);
      freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (!Number.isSafeInteger(freeBytes) || freeBytes < 0 || Number(stat.bsize) <= 0) {
        throw new Error('Invalid filesystem space observation');
      }
    } catch {
      throw new HealthCheckError('Unable to read available disk space', this.getStatus(key, false, {
        path, requiredFreeBytes: MIN_DISK_FREE_BYTES, message: 'Unable to read available disk space',
      }));
    }
    const healthy = freeBytes >= MIN_DISK_FREE_BYTES;
    const result = this.getStatus(key, healthy, {
      path, freeBytes, requiredFreeBytes: MIN_DISK_FREE_BYTES,
    });
    if (!healthy) throw new HealthCheckError('Available disk space is below 5 GiB', result);
    return result;
  }
}
