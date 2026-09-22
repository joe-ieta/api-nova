import type { HeaderPolicyV1 } from '../headers/header-policy';
/** TP-C1 structural candidate only. No provider resolution, asset verification or activation. */
export type UpstreamCredentialSelection =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'none' }
  | { readonly mode: 'reference'; readonly credentialId: string };

export type UpstreamSecretProviderDescription =
  | { readonly type: 'env' }
  | { readonly type: 'file'; readonly root: string; readonly requireOwnerOnly: true };

export interface UpstreamCredentialConstraints {
  readonly enabled?: boolean;
  readonly notBefore?: string;
  readonly expiresAt?: string;
  readonly environment?: string;
  readonly allowedHosts?: readonly string[];
  readonly endpointDefinitionIds?: readonly string[];
  readonly methods?: readonly string[];
}
export type UpstreamCredentialDescription = UpstreamCredentialConstraints & (
  | { readonly type: 'apiKey'; readonly placement: { readonly in: 'header'; readonly name: string }; readonly secretRef: string }
  | { readonly type: 'bearer'; readonly secretRef: string }
  | { readonly type: 'basic'; readonly usernameRef: string; readonly passwordRef: string }
  | { readonly type: 'customHeader'; readonly name: string; readonly secretRef: string }
);
/** One authoritative managed name; unknown runtime objects never default to an API key. */
export function upstreamCredentialHeaderName(credential: UpstreamCredentialDescription): string {
  switch (credential.type) {
    case 'bearer': case 'basic': return 'authorization';
    case 'apiKey': return credential.placement.name;
    case 'customHeader': return credential.name;
    default: throw new Error('UNSUPPORTED_CREDENTIAL_TYPE');
  }
}

export type UpstreamEndpointCredentialOverride = {
  readonly headerPolicy?: HeaderPolicyV1;
  readonly credential: UpstreamCredentialSelection;
} & (
  | { readonly endpointDefinitionId: string }
  | { readonly method: string; readonly path: string }
);

export interface UpstreamCredentialSite {
  readonly headerPolicy?: HeaderPolicyV1;
  readonly id: string;
  readonly sourceServiceAssetId: string;
  readonly match: {
    readonly scheme: 'http' | 'https';
    readonly host: string;
    readonly port: number;
    readonly basePath: string;
  };
  readonly credential: UpstreamCredentialSelection;
  readonly allowedHosts: readonly string[];
  readonly endpoints: readonly UpstreamEndpointCredentialOverride[];
}

export interface UpstreamCredentialBindingsCandidate {
  readonly apiVersion: 'security.apinova.io/v1';
  readonly kind: 'UpstreamCredentialBindings';
  readonly metadata: { readonly revision: string; readonly environment: string };
  /** Declarative intent only; validation never starts a watcher. */
  readonly reload: { readonly mode: 'manual' | 'watch'; readonly debounceMs: number; readonly rejectPlaintextSecrets: true };
  readonly secretProviders: Readonly<Record<string, UpstreamSecretProviderDescription>>;
  readonly credentials: Readonly<Record<string, UpstreamCredentialDescription>>;
  readonly sites: readonly UpstreamCredentialSite[];
}

export type UpstreamCredentialValidationCode =
  | 'INVALID_STRUCTURE' | 'INPUT_LIMIT_EXCEEDED' | 'UNSAFE_OBJECT'
  | 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'INVALID_VALUE'
  | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_CREDENTIAL_TYPE' | 'UNSUPPORTED_PROVIDER_TYPE'
  | 'PLAINTEXT_NOT_ALLOWED' | 'INVALID_REFERENCE' | 'DUPLICATE_SELECTOR'
  | 'INVALID_HEADER' | 'INVALID_HOST' | 'INVALID_PATH';
