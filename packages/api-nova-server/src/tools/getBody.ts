import type { IncomingMessage } from "node:http";
import { auditBodyLimit, RuntimeAuthError } from 'api-nova-parser';

export function getBody<T = unknown>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const bodyParts: Buffer[] = [];
    let bytes = 0;
    let rejected = false;

    request
      .on("data", (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (rejected) return;
        if (bytes > auditBodyLimit()) {
          rejected = true;
          bodyParts.length = 0;
          reject(new RuntimeAuthError(413, 'request_body_too_large'));
          return;
        }
        bodyParts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      })
      .on("error", (error) => {
        reject(error);
      })
      .on("end", () => {
        if (rejected) return;
        const rawBody = Buffer.concat(bodyParts).toString().trim();

        if (!rawBody) {
          resolve({} as T);
          return;
        }

        try {
          resolve(JSON.parse(rawBody) as T);
        } catch (error) {
          reject(new RuntimeAuthError(400, 'invalid_json_request'));
        }
      });
  });
}
