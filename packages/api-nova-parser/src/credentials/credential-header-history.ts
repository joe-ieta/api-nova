/** Trusted host-owned durable ledger. Never construct this adapter from Registry text. */
export interface CredentialHeaderHistoryState {
  readonly version: number;
  readonly names: readonly string[];
}
export interface CredentialHeaderHistoryStore {
  load(namespace: string): Promise<CredentialHeaderHistoryState>;
  /** Atomic CAS: false changes nothing. Success must durably union names and advance
   * version before resolving. No secret, ref, request value or candidate is supplied. */
  commit(namespace: string, expectedVersion: number, names: readonly string[]): Promise<boolean>;
}
export interface CredentialHeaderHistoryBinding {
  readonly namespace: string;
  readonly store: CredentialHeaderHistoryStore;
}
export const CREDENTIAL_HEADER_HISTORY_LIMIT = 4096;
export function checkedCredentialHeaderHistoryState(input: CredentialHeaderHistoryState): CredentialHeaderHistoryState {
  if (!input || !Number.isSafeInteger(input.version) || input.version < 0 || !Array.isArray(input.names) || input.names.length > CREDENTIAL_HEADER_HISTORY_LIMIT) throw Error();
  const names = new Set<string>();
  for (const name of input.names) {
    if (typeof name !== 'string' || !name || name.length > 256 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw Error();
    names.add(name);
  }
  return Object.freeze({ version: input.version, names: Object.freeze([...names].sort()) });
}
