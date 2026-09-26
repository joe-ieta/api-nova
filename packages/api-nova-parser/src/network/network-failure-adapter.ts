import { ControlledDnsError } from './controlled-dns';
import { PinnedHttpStreamProtocolError } from './pinned-http-stream';
import { createNetworkFailure, type NetworkFailure } from './network-failure-contract';

/**
 * Trusted instance-based mapping only. Raw error text, request fields and
 * foreign objects never decide a failure kind; unknown errors are unavailable.
 */
export function toNetworkFailure(error: unknown): NetworkFailure {
  // The protocol error extends ControlledDnsError; classify it first.
  if (error instanceof PinnedHttpStreamProtocolError) {
    // Protocol and peer violations are refusals; transport corruption is unavailable.
    return createNetworkFailure(
      error.reason === 'informational' || error.reason === 'early_response' ? 'denied' : 'unavailable',
    );
  }
  if (error instanceof ControlledDnsError) {
    switch (error.code) {
      case 'ETIMEDOUT': return createNetworkFailure('timeout');
      case 'ABORT_ERR': return createNetworkFailure('cancelled');
      case 'upstream_network_policy_denied': return createNetworkFailure('denied');
      default: return createNetworkFailure('unavailable');
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR')) {
    return createNetworkFailure('cancelled');
  }
  return createNetworkFailure('unavailable');
}
