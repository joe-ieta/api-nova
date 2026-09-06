import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';

export interface RuntimeCallContext {
  transport: 'gateway' | 'mcp';
  requestId: string;
  correlationId?: string;
  parentInvocationId?: string;
  callerId?: string;
  callerIssuer?: string;
  callerSubject?: string;
  clientId?: string;
  scopes?: string[];
  identitySource: 'authenticated' | 'anonymous';
  credentialId?: string;
  sessionIdHash?: string;
  runtimeAssetId?: string;
  serverId?: string;
  endpointDefinitionId?: string;
  sourceServiceInstanceId?: string;
  toolName?: string;
  operationId?: string;
  clientIp?: string;
}

export interface AuditBody {
  contentType: string;
  encoding?: 'utf8' | 'base64';
  data?: string;
  totalBytes: number;
  capturedBytes: number;
  sha256: string;
  state: 'complete' | 'empty' | 'omitted' | 'incomplete';
  reason?: string;
  redacted: boolean;
}

export interface RuntimeCallRecord extends RuntimeCallContext {
  schemaVersion: 1;
  invocationId: string;
  eventId: string;
  processId: string;
  sequence: number;
  kind: 'api' | 'tool' | 'admission';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: 'success' | 'error' | 'cancelled' | 'cache_hit';
  method?: string;
  path?: string;
  url?: string;
  statusCode?: number;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  request?: AuditBody;
  response?: AuditBody;
  errorCode?: string;
}

const contextStorage = new AsyncLocalStorage<RuntimeCallContext>();
const processId = randomUUID();
let sequence = 0;
let writeChain: Promise<void> = Promise.resolve();

export function withRuntimeCallContext<T>(context: RuntimeCallContext, callback: () => T): T {
  return contextStorage.run(context, callback);
}

export function getRuntimeCallContext(): RuntimeCallContext | undefined {
  return contextStorage.getStore();
}

export function auditDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  const configured = (process.env.API_NOVA_AUDIT_REDACT_FIELDS || '').split(',')
    .map(value => value.trim().toLowerCase().replace(/[-_]/g, '')).filter(Boolean);
  return configured.includes(normalized) || /^(authorization|proxyauthorization|cookie|setcookie|xapikey|apikey|password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|mcpsessionid|sessionid)$/.test(normalized);
}

export function redactAuditValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      sensitiveKey(key) ? '[REDACTED]' : redactAuditValue(item)]));
  }
  if (typeof value === 'string') {
    // MCP text content can contain a JSON-encoded upstream response.
    try { return JSON.stringify(redactAuditValue(JSON.parse(value))); } catch { /* plain text */ }
    return value.replace(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi, (block, json) => {
      try { return '```json\n' + JSON.stringify(redactAuditValue(JSON.parse(json))) + '\n```'; }
      catch { return block; }
    }).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/("(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
      .replace(/(<(?:password|secret|token|api[_-]?key)\b[^>]*>)[\s\S]*?(<\/(?:password|secret|token|api[_-]?key)>)/gi, '$1[REDACTED]$2')
      .replace(/((?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s&,;]+/gi, '$1[REDACTED]');
  }
  return value;
}

export function redactAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveKey(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch { return '[invalid URL]'; }
}

/** Explicit credential header names are secret even when the name is vendor-specific. */
export function redactAuditHeaders(headers: Record<string, unknown>, credentialNames: string[] = []) {
  const names = new Set(credentialNames.map(name => name.toLowerCase()));
  return redactAuditValue(Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    [name, names.has(name.toLowerCase()) ? '[REDACTED]' : value])));
}

export function auditDirectory(): string {
  return resolve(process.env.API_NOVA_AUDIT_DIR || 'data/runtime-audit');
}

export function auditBodyLimit(): number {
  const configured = Number(process.env.API_NOVA_AUDIT_MAX_BODY_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 64 * 1024 * 1024) : 16 * 1024 * 1024;
}

function captureMultipart(raw: Buffer, contentType: string): string {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const value = boundary?.[1] || boundary?.[2];
  if (!value || value.length > 200) throw new Error('invalid_multipart');
  const marker = Buffer.from(`--${value}`);
  const separator = Buffer.from(`\r\n--${value}`);
  const parts: unknown[] = [];
  let cursor = 0;
  while (raw.subarray(cursor, cursor + marker.length).equals(marker)) {
    cursor += marker.length;
    if (raw.subarray(cursor, cursor + 2).toString() === '--') return JSON.stringify({ parts });
    if (raw.subarray(cursor, cursor + 2).toString() !== '\r\n') break;
    cursor += 2;
    const headerEnd = raw.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0 || headerEnd - cursor > 16384) break;
    const headers: Record<string, string> = {};
    for (const line of raw.subarray(cursor, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('invalid_multipart');
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1];
    if (name === undefined) break;
    const next = raw.indexOf(separator, headerEnd + 4);
    if (next < 0) break;
    const partType = headers['content-type'] || (/(?:^|;)\s*filename\*?=/i.test(disposition) ? 'application/octet-stream' : 'text/plain');
    if (/multipart/i.test(partType)) throw new Error('nested_multipart');
    parts.push({ name, headers: redactAuditValue(headers), body: sensitiveKey(name) ? '[REDACTED]'
      : captureAuditBody(raw.subarray(headerEnd + 4, next), partType) });
    if (parts.length > 1000) throw new Error('multipart_part_limit');
    cursor = next + 2;
  }
  throw new Error('invalid_multipart');
}

export function createAuditBodyTracker(contentType = '', limit = auditBodyLimit()) {
  const hash = createHash('sha256');
  let chunks: Buffer[] = [];
  let totalBytes = 0;
  let overflow = false;
  let result: AuditBody | undefined;
  return {
    observe(chunk: Buffer | string) {
      if (result) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      hash.update(buffer);
      if (totalBytes > limit) { overflow = true; chunks = []; }
      if (!overflow) chunks.push(buffer);
    },
    finish(complete = true): AuditBody {
      if (result) return result;
      result = { contentType, totalBytes, capturedBytes: 0, sha256: hash.digest('hex'),
        state: totalBytes ? 'complete' : 'empty', redacted: false };
      if (!complete || overflow) {
        result.state = complete ? 'omitted' : 'incomplete';
        result.reason = !complete ? 'stream_interrupted' : 'size_limit';
        chunks = [];
        return result;
      }
      const raw = Buffer.concat(chunks);
      chunks = [];
      const text = raw.toString('utf8');
      const type = contentType.toLowerCase();
      if (type.includes('multipart/')) {
        try {
          result.data = captureMultipart(raw, contentType);
          result.encoding = 'utf8'; result.capturedBytes = raw.length; result.redacted = true;
        } catch { result.state = 'omitted'; result.reason = 'unsupported_or_invalid_multipart'; }
        return result;
      }
      const textual = !type || /json|text\/|xml|x-www-form-urlencoded/.test(type);
      let data: string;
      if (type.includes('json') && raw.length) {
        try { data = JSON.stringify(redactAuditValue(JSON.parse(text))); }
        catch { result.state = 'omitted'; result.reason = 'invalid_json'; return result; }
      } else if (type.includes('x-www-form-urlencoded')) {
        const form = new URLSearchParams(text);
        for (const key of Array.from(form.keys())) if (sensitiveKey(key)) form.set(key, '[REDACTED]');
        data = form.toString();
      } else {
        data = textual ? redactAuditValue(text) : raw.toString('base64');
      }
      result.data = data;
      result.encoding = textual ? 'utf8' : 'base64';
      result.capturedBytes = raw.length;
      result.redacted = textual && data !== text;
      return result;
    },
  };
}

export function captureAuditBody(value: unknown, contentType = 'application/json'): AuditBody {
  const tracker = createAuditBodyTracker(contentType);
  if (value !== undefined) tracker.observe(Buffer.isBuffer(value) ? value
    : typeof value === 'string' ? value : JSON.stringify(value));
  return tracker.finish();
}

export function beginRuntimeCall(context: RuntimeCallContext, kind: RuntimeCallRecord['kind']) {
  const record: RuntimeCallRecord = { ...context, schemaVersion: 1, invocationId: randomUUID(),
    eventId: randomUUID(), processId, sequence: ++sequence, kind, startedAt: new Date().toISOString(),
    serverId: context.serverId || process.env.API_NOVA_AUDIT_SERVER_ID };
  const start = process.hrtime.bigint();
  let finished = false;
  return { record, async finish(fields: Partial<RuntimeCallRecord>) {
    if (finished) return;
    finished = true;
    await writeRuntimeCall({ ...record, ...fields, completedAt: new Date().toISOString(),
      durationMs: fields.durationMs ?? Number(process.hrtime.bigint() - start) / 1e6 });
  } };
}

export async function writeRuntimeCall(record: RuntimeCallRecord): Promise<void> {
  const directory = auditDirectory();
  const file = join(directory, `${new Date().toISOString().slice(0, 10)}-${processId}.jsonl`);
  const line = JSON.stringify(record) + '\n';
  const write = writeChain.then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
    if (record.identitySource === 'authenticated' && record.callerId) {
      const observation = { callerId: record.callerId, issuer: record.callerIssuer,
        subject: record.callerSubject, clientId: record.clientId, transport: record.transport,
        observedAt: record.startedAt };
      await appendFile(join(directory, `callers-${processId}.jsonl`), JSON.stringify(observation) + '\n',
        { encoding: 'utf8', mode: 0o600 });
    }
  });
  writeChain = write.catch(() => {
    // Never echo payloads, paths, or a failing storage driver's error message.
    process.stderr.write('[RUNTIME_AUDIT_WRITE_FAILED] Invocation evidence could not be persisted.\n');
  });
  await writeChain;
}

/** Credential-free inventory. Does not expose invocation bodies or tokens. */
export async function listObservedRuntimeCallers() {
  await flushRuntimeAudit();
  const directory = auditDirectory();
  let files: string[];
  try { files = await readdir(directory); } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const callers = new Map<string, { callerId: string; issuer?: string; subject?: string;
    firstSeenAt: string; lastSeenAt: string; transports: string[] }>();
  for (const file of files.filter(name => /^callers-[a-f0-9-]+\.jsonl$/.test(name))) {
    const lines = createInterface({ input: createReadStream(join(directory, file)), crlfDelay: Infinity });
    for await (const line of lines) {
      let item: any;
      try { item = JSON.parse(line); } catch { continue; } // A process may be appending its last line.
      if (!item.callerId || !item.observedAt) continue;
      const current = callers.get(item.callerId);
      if (!current) callers.set(item.callerId, { callerId: item.callerId, issuer: item.issuer,
        subject: item.subject, firstSeenAt: item.observedAt, lastSeenAt: item.observedAt,
        transports: [item.transport] });
      else {
        current.firstSeenAt = current.firstSeenAt < item.observedAt ? current.firstSeenAt : item.observedAt;
        current.lastSeenAt = current.lastSeenAt > item.observedAt ? current.lastSeenAt : item.observedAt;
        if (!current.transports.includes(item.transport)) current.transports.push(item.transport);
      }
    }
  }
  return [...callers.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.callerId.localeCompare(b.callerId));
}

export async function flushRuntimeAudit(): Promise<void> {
  let pending: Promise<void>;
  do { pending = writeChain; await pending; } while (pending !== writeChain);
}
