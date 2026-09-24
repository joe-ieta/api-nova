import {
  assertRegistryProviderEvidence,
  type RegistryProviderEvidence,
} from 'api-nova-parser';

export const GATEWAY_HOST_CREDENTIAL_GENERATION_CAPABILITY = Symbol(
  'GATEWAY_HOST_CREDENTIAL_GENERATION_CAPABILITY',
);

export class GatewayHostCredentialGenerationCapabilityError extends Error {
  constructor(readonly code: 'invalid' | 'duplicate' | 'closed' | 'unavailable') {
    super(`GATEWAY_HOST_CREDENTIAL_GENERATION_CAPABILITY_${code.toUpperCase()}`);
    this.name = 'GatewayHostCredentialGenerationCapabilityError';
  }
}

export interface GatewayHostCredentialGenerationCapability {
  readonly kind: 'gateway-host-credential-generation-capability';
  readonly signal: AbortSignal;
}

export interface GatewayHostCredentialGenerationCapabilityController {
  readonly capability: GatewayHostCredentialGenerationCapability;
  close(): void;
}

type CapabilityState = {
  issuer: RegistryProviderEvidence;
  issuerClaimed: boolean;
  closed: boolean;
  controller: AbortController;
};

const capabilities = new WeakMap<object, CapabilityState>();
const wrappedIssuers = new WeakSet<object>();
const failure = (code: GatewayHostCredentialGenerationCapabilityError['code']): never => {
  throw new GatewayHostCredentialGenerationCapabilityError(code);
};

function readState(
  capability: GatewayHostCredentialGenerationCapability,
): CapabilityState {
  if (!capability || typeof capability !== 'object') return failure('invalid');
  const state = capabilities.get(capability);
  if (!state) return failure('invalid');
  if (state.closed || state.controller.signal.aborted) return failure('closed');
  try {
    assertRegistryProviderEvidence(state.issuer);
  } catch {
    return failure('unavailable');
  }
  return state;
}

/**
 * Creates an opaque host boundary around a real D2b2 Registry evidence issuer.
 * The issuer must carry the Parser's private runtime brand. Request/config/env/file
 * objects cannot mint this capability, and the issuer is never an enumerable field.
 */
export function createGatewayHostCredentialGenerationCapability(
  issuer: RegistryProviderEvidence,
): GatewayHostCredentialGenerationCapabilityController {
  try {
    assertRegistryProviderEvidence(issuer);
  } catch {
    return failure('invalid');
  }
  if (wrappedIssuers.has(issuer)) return failure('duplicate');
  wrappedIssuers.add(issuer);

  const controller = new AbortController();
  const capability = Object.freeze({
    kind: 'gateway-host-credential-generation-capability' as const,
    signal: controller.signal,
  });
  const state: CapabilityState = {
    issuer,
    issuerClaimed: false,
    closed: false,
    controller,
  };
  capabilities.set(capability, state);

  let controllerClosed = false;
  const close = () => {
    if (controllerClosed) return;
    controllerClosed = true;
    // Invalidate the capability before issuer.close() synchronously aborts its signals.
    state.closed = true;
    let closeFailed = false;
    try {
      state.issuer.close();
    } catch {
      closeFailed = true;
    } finally {
      controller.abort(new GatewayHostCredentialGenerationCapabilityError('closed'));
    }
    if (closeFailed) return failure('unavailable');
  };

  return Object.freeze({ capability, close });
}

/** Missing optional injection is the only default-off value. */
export function resolveGatewayHostCredentialGenerationCapability(
  value: GatewayHostCredentialGenerationCapability | null | undefined,
): GatewayHostCredentialGenerationCapability | null {
  if (value === undefined || value === null) return null;
  readState(value);
  return value;
}

/** One Registry composition may claim an issuer; later claims fail closed. */
export function consumeGatewayHostCredentialGenerationIssuer(
  capability: GatewayHostCredentialGenerationCapability,
): RegistryProviderEvidence {
  const state = readState(capability);
  if (state.issuerClaimed) return failure('duplicate');
  state.issuerClaimed = true;
  return state.issuer;
}
