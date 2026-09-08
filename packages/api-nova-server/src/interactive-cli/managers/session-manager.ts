import { promises as fs } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { assertStructuredHeaders, normalizeOperationFilter } from '../../utils/validation';
import { SessionConfig, SessionStats } from '../types/index';

const FORMAT_VERSION = 'api-nova-sessions/v1';
const clone = <T>(value: T): T => structuredClone(value);

export function validateSession(session: unknown): asserts session is SessionConfig {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Invalid session');
  const value = session as SessionConfig;
  for (const key of ['id', 'name', 'openApiUrl', 'createdAt', 'lastUsed'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Invalid session ${key}`);
  }
  if (!['stdio', 'sse', 'streamable'].includes(value.transport) ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.lastUsed))) {
    throw new Error('Invalid session transport or timestamps');
  }
  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) {
    throw new Error('Invalid session port');
  }
  if (value.auth && !['none', 'bearer', 'basic', 'apikey'].includes(value.auth.type)) {
    throw new Error('Unsupported session authentication');
  }
  if (value.customHeaders !== undefined) assertStructuredHeaders(value.customHeaders);
  if (value.operationFilter) normalizeOperationFilter(value.operationFilter);
}

export class SessionManager {
  private readonly sessionsFile: string;
  private sessions = new Map<string, SessionConfig>();
  private initialization?: Promise<void>;
  private pendingWrite: Promise<unknown> = Promise.resolve();

  constructor(configDir: string = '.api-nova') {
    this.sessionsFile = join(isAbsolute(configDir) ? configDir : join(homedir(), configDir), 'sessions.json');
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.loadSessions().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async loadSessions(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.sessionsFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const document = JSON.parse(content);
    if (document?.formatVersion !== FORMAT_VERSION || !Array.isArray(document.sessions)) {
      throw new Error('Unsupported session file format; recreate it using api-nova-sessions/v1');
    }
    const sessions = new Map<string, SessionConfig>();
    for (const session of document.sessions) {
      validateSession(session);
      if (sessions.has(session.id)) throw new Error('Duplicate session ID');
      sessions.set(session.id, session);
    }
    this.sessions = sessions;
  }

  private async persist(sessions: Map<string, SessionConfig>): Promise<void> {
    for (const session of sessions.values()) validateSession(session);
    const temporary = `${this.sessionsFile}.${process.pid}.${uuidv4()}.tmp`;
    await fs.mkdir(dirname(this.sessionsFile), { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify({
        formatVersion: FORMAT_VERSION, sessions: [...sessions.values()],
      }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.sessionsFile);
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private async mutate<T>(operation: (sessions: Map<string, SessionConfig>) => T): Promise<T> {
    await this.initialize();
    const work = this.pendingWrite.catch(() => undefined).then(async () => {
      const next = new Map([...this.sessions].map(([id, value]) => [id, clone(value)]));
      const result = operation(next);
      await this.persist(next);
      this.sessions = next;
      return clone(result);
    });
    this.pendingWrite = work;
    return work;
  }

  async saveSession(config: Omit<SessionConfig, 'id' | 'createdAt' | 'lastUsed'>): Promise<SessionConfig> {
    return this.mutate((sessions) => {
      const session: SessionConfig = { ...clone(config), id: uuidv4(),
        createdAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
      sessions.set(session.id, session);
      return session;
    });
  }

  async getSession(id: string): Promise<SessionConfig | undefined> {
    await this.initialize();
    await this.pendingWrite.catch(() => undefined);
    return clone(this.sessions.get(id));
  }

  async getAllSessions(): Promise<SessionConfig[]> {
    await this.initialize();
    await this.pendingWrite.catch(() => undefined);
    return clone([...this.sessions.values()]).sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed));
  }

  async updateSession(id: string, config: SessionConfig): Promise<void> {
    await this.mutate((sessions) => {
      if (!sessions.has(id)) throw new Error('Session not found');
      sessions.set(id, { ...clone(config), id, lastUsed: new Date().toISOString() });
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.mutate((sessions) => sessions.delete(id));
  }

  async findSessionByName(name: string): Promise<SessionConfig | undefined> {
    return (await this.getAllSessions()).find((session) => session.name === name);
  }

  async getRecentSessions(limit: number = 5): Promise<SessionConfig[]> {
    return (await this.getAllSessions()).slice(0, limit);
  }

  async sessionNameExists(name: string, excludeId?: string): Promise<boolean> {
    return (await this.getAllSessions()).some((session) => session.name === name && session.id !== excludeId);
  }

  async importSessions(incoming: SessionConfig[]): Promise<number> {
    if (!Array.isArray(incoming)) throw new Error('Sessions must be an array');
    incoming.forEach(validateSession);
    return this.mutate((sessions) => {
      let count = 0;
      const names = new Set([...sessions.values()].map((session) => session.name));
      for (const source of incoming) {
        if (names.has(source.name)) continue;
        const session = { ...clone(source), id: uuidv4(),
          createdAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
        sessions.set(session.id, session);
        names.add(session.name);
        count++;
      }
      return count;
    });
  }

  async exportSessions(): Promise<SessionConfig[]> { return this.getAllSessions(); }
  async clearAllSessions(): Promise<void> { await this.mutate((sessions) => sessions.clear()); }
  getConfigPath(): string { return this.sessionsFile; }

  async updateLastUsed(id: string): Promise<void> {
    await this.mutate((sessions) => {
      const session = sessions.get(id);
      if (session) session.lastUsed = new Date().toISOString();
    });
  }

  async getSessionStats(): Promise<SessionStats> {
    const sessions = await this.getAllSessions();
    const byTransport: Record<string, number> = {};
    sessions.forEach((session) => { byTransport[session.transport] = (byTransport[session.transport] || 0) + 1; });
    return { total: sessions.length, byTransport, recentlyUsed: Math.min(sessions.length, 5) };
  }
}
