import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type GatewayPayloadCapture = {
  totalBytes: number;
  preview?: string;
  hash: string;
  truncated: boolean;
};

type GatewayPayloadCaptureTracker = {
  observeChunk(chunk: Buffer | string): void;
  finalize(): GatewayPayloadCapture;
};

@Injectable()
export class GatewayRequestCaptureService {
  private readonly maxPreviewBytes = 4096;

  createTracker(contentType?: string | string[]): GatewayPayloadCaptureTracker {
    const normalizedContentType = this.headerValue(contentType).toLowerCase();
    const hash = createHash('sha256');
    const previewChunks: Buffer[] = [];
    let previewBytes = 0;
    let totalBytes = 0;
    let truncated = false;
    let finalized = false;
    let finalizedResult: GatewayPayloadCapture | null = null;

    const isPreviewable = this.isPreviewable(normalizedContentType);
    const isMultipart = normalizedContentType.includes('multipart/form-data');

    return {
      observeChunk: (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (finalized) {
          return;
        }
        totalBytes += buffer.byteLength;
        hash.update(buffer);

        if (!isPreviewable || isMultipart) {
          return;
        }
        if (previewBytes >= this.maxPreviewBytes) {
          truncated = true;
          return;
        }

        const remainingBytes = this.maxPreviewBytes - previewBytes;
        const slice = remainingBytes >= buffer.byteLength ? buffer : buffer.subarray(0, remainingBytes);
        previewChunks.push(slice);
        previewBytes += slice.byteLength;
        if (slice.byteLength < buffer.byteLength) {
          truncated = true;
        }
      },
      finalize: () => {
        if (finalized && finalizedResult) {
          return finalizedResult;
        }
        finalized = true;
        const digest = hash.digest('hex');
        if (isMultipart) {
          finalizedResult = {
            totalBytes,
            preview: totalBytes > 0 ? '[multipart/form-data omitted]' : undefined,
            hash: digest,
            truncated,
          };
          return finalizedResult;
        }
        finalizedResult = {
          totalBytes,
          preview: isPreviewable ? this.normalizePreview(Buffer.concat(previewChunks), truncated) : undefined,
          hash: digest,
          truncated,
        };
        return finalizedResult;
      },
    };
  }

  private isPreviewable(contentType: string) {
    if (!contentType) {
      return true;
    }
    return (
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    );
  }

  private normalizePreview(buffer: Buffer, truncated: boolean) {
    if (buffer.byteLength === 0) {
      return undefined;
    }
    const text = buffer.toString('utf8');
    return truncated ? `${text}...[truncated]` : text;
  }

  private headerValue(value?: string | string[]) {
    if (Array.isArray(value)) {
      return String(value[0] || '');
    }
    return String(value || '');
  }
}
