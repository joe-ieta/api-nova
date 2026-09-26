import {
  classifyNetworkFailure,
  createNetworkFailure,
  networkFailureDisposition,
} from './network-failure-contract';
import { toNetworkFailure } from './network-failure-adapter';
import { ControlledDnsError } from './controlled-dns';
import { PinnedHttpStreamProtocolError } from './pinned-http-stream';

describe('network failure adapter', () => {
  test('maps trusted error instances without reading raw text', () => {
    expect(classifyNetworkFailure(toNetworkFailure(new ControlledDnsError('upstream_network_policy_denied')))).toBe('denied');
    expect(classifyNetworkFailure(toNetworkFailure(new ControlledDnsError('upstream_network_policy_unavailable')))).toBe('unavailable');
    expect(classifyNetworkFailure(toNetworkFailure(new ControlledDnsError('ETIMEDOUT')))).toBe('timeout');
    expect(classifyNetworkFailure(toNetworkFailure(new ControlledDnsError('ABORT_ERR')))).toBe('cancelled');
    expect(classifyNetworkFailure(toNetworkFailure(new PinnedHttpStreamProtocolError('parse')))).toBe('unavailable');
    expect(classifyNetworkFailure(toNetworkFailure(new PinnedHttpStreamProtocolError('early_response')))).toBe('denied');
    const abort = Object.assign(new Error('client left'), { name: 'AbortError' });
    expect(classifyNetworkFailure(toNetworkFailure(abort))).toBe('cancelled');
    expect(classifyNetworkFailure(toNetworkFailure(new Error('fixture.test:443 cert')))).toBe('unavailable');
    expect(classifyNetworkFailure(toNetworkFailure('fixture.test'))).toBe('unavailable');
  });

  test('keeps gateway and tool disposition stable for every kind', () => {
    const cases = [
      ['denied', 'upstream_network_policy_denied', 502, 'error'],
      ['unavailable', 'upstream_network_policy_unavailable', 503, 'error'],
      ['timeout', 'ETIMEDOUT', 504, 'error'],
      ['cancelled', 'ABORT_ERR', undefined, 'cancelled'],
    ] as const;
    for (const [kind, code, status, tool] of cases) {
      const disposition = networkFailureDisposition(createNetworkFailure(kind), 'not-started');
      expect(disposition.code).toBe(code);
      expect(disposition.tool.action).toBe(tool);
      if (status === undefined) expect(disposition.gateway.action).toBe('destroy');
      else expect(disposition.gateway).toEqual({ action: 'respond', statusCode: status });
    }
    const started = networkFailureDisposition(createNetworkFailure('denied'), 'started');
    expect(started.gateway.action).toBe('destroy');
    const closed = networkFailureDisposition(createNetworkFailure('denied'), 'closed');
    expect(closed.gateway.action).toBe('none');
  });
});
