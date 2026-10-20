import { createHash } from 'node:crypto';

export const GATEWAY_UPSTREAM_CREDENTIAL_CONFIG = Object.freeze({
  file: 'API_NOVA_UPSTREAM_CREDENTIAL_FILE',
  reloadMode: 'API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE',
  format: 'API_NOVA_UPSTREAM_CREDENTIAL_FORMAT',
  environment: 'API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT',
});

/** One host-owned Registry role per database, independent of candidate/file path. */
export const GATEWAY_HEADER_HISTORY_NAMESPACE = 'gateway:upstream-credential-registry:v1';
export const GATEWAY_HEADER_HISTORY_PROVENANCE = createHash('sha256')
  .update('api-nova:gateway:database-owned-upstream-credential-registry:v1').digest('hex');
