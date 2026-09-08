import { AuthConfig, CustomHeaders, OperationFilter } from 'api-nova-parser';

export interface ServerOptions {
  transport: string;
  port: string;
  host?: string;
  endpoint?: string;
  'base-url'?: string;
  autoRestart?: boolean;
  maxRetries?: string;
  retryDelay?: string;
  openapi?: string;
  watch?: boolean;
  authType?: string;
  bearerToken?: string;
  bearerEnv?: string;
  config?: string;
  env?: string;
  customHeaders?: string[];
  header?: string[];
  customHeadersConfig?: string;
  customHeadersEnv?: string[];
  debugHeaders?: boolean;
  managed?: boolean;
  'operation-filter-methods'?: string[];
  'operation-filter-paths'?: string[];
  'operation-filter-operation-ids'?: string[];
  'operation-filter-status-codes'?: string[];
  'operation-filter-parameters'?: string[];
  'allowed-host'?: string[];
  'allowed-origin'?: string[];
  'disable-dns-rebinding-protection'?: boolean;
}

export interface ConfigFile {
  transport?: string;
  port?: number;
  host?: string;
  endpoint?: string;
  openapi?: string;
  baseUrl?: string;
  watch?: boolean;
  auth?: AuthConfig;
  autoRestart?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  customHeaders?: CustomHeaders;
  debugHeaders?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  disableDnsRebindingProtection?: boolean;
  operationFilter?: OperationFilter;
}

export interface ParsedOptions extends ServerOptions {
  help?: boolean;
  'base-url'?: string;
  'auth-type'?: string;
  'bearer-token'?: string;
  'bearer-env'?: string;
  'auto-restart'?: boolean;
  'max-retries'?: string;
  'retry-delay'?: string;
  'custom-header'?: string[];
  header?: string[];
  'custom-headers-config'?: string;
  'custom-header-env'?: string[];
  'debug-headers'?: boolean;
  managed?: boolean;
  host?: string;
  'allowed-host'?: string[];
  'allowed-origin'?: string[];
  'disable-dns-rebinding-protection'?: boolean;
}
