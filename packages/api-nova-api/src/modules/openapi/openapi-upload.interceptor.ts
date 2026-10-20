import {
  CallHandler, ExecutionContext, Injectable, InternalServerErrorException, NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppConfigService } from '../../config/app-config.service';

/** Apply the existing configured file limit while parsing, before buffering the
 * entire upload. These endpoints accept one file and no multipart text fields. */
@Injectable()
export class OpenAPIUploadInterceptor implements NestInterceptor {
  constructor(private readonly config: AppConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const match = /^(\d+)\s*(B|KB|MB|GB)$/i.exec(this.config.maxOpenAPIFileSize);
    const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
    const fileSize = match && Number(match[1]) * units[match[2].toUpperCase()];
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0)
      throw new InternalServerErrorException('Invalid upload size configuration');
    const Upload = FileInterceptor('file', {
      limits: { fileSize, files: 1, fields: 0, parts: 2, fieldNameSize: 100, headerPairs: 32 },
    });
    return new Upload().intercept(context, next);
  }
}
