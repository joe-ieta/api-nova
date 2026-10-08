import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppConfigService } from '../../config/app-config.service';

export function openAPIUploadLimit(value: string): number {
  const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  const match = /^(\d+)\s*(B|KB|MB|GB)$/i.exec(value);
  const limit = match ? Number(match[1]) * units[match[2].toUpperCase()] : NaN;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid file size format: ${value}`);
  }
  return limit;
}

@Injectable()
export class OpenAPIUploadInterceptor implements NestInterceptor {
  constructor(private readonly config: AppConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const maxBytes = openAPIUploadLimit(this.config.maxOpenAPIFileSize);
    // Multer 2.4 implements the inclusive fileSize boundary itself. These routes
    // accept one file and no text fields; reject unexpected fields before parsing.
    const interceptor = new (FileInterceptor('file', {
      limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 100 },
    }))();
    return interceptor.intercept(context, next);
  }
}
