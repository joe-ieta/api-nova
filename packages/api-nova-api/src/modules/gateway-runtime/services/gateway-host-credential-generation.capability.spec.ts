import {
  createHostCredentialGenerationStore,
  createRegistryProviderEvidence,
  HostCredentialGenerationError,
  UpstreamCredentialRegistry,
} from 'api-nova-parser';
import {
  consumeGatewayHostCredentialGenerationIssuer,
  createGatewayHostCredentialGenerationCapability,
  GatewayHostCredentialGenerationCapabilityError,
  resolveGatewayHostCredentialGenerationCapability,
} from './gateway-host-credential-generation.capability';

const candidate = {
  apiVersion: 'security.apinova.io/v1',
  kind: 'UpstreamCredentialBindings',
  metadata: { revision: 'r1', environment: 'test' },
  reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
  secretProviders: { memory: { type: 'env' } },
  credentials: {
    token: {
      type: 'bearer',
      secretRef: 'memory:TOKEN',
    },
  },
  sites: [{
    id: 'site',
    sourceServiceAssetId: 'asset',
    match: { scheme: 'https', host: 'fixture.invalid', port: 443, basePath: '/' },
    allowedHosts: ['fixture.invalid'],
    credential: 'token',
    endpoints: [],
  }],
};

describe('Gateway host credential generation capability', () => {
  const resources: Array<() => void> = [];

  function fixture(secret = 'PRIVATE_GATEWAY_SECRET') {
    const store = createHostCredentialGenerationStore();
    store.activate(store.stage({
      providers: { memory: { TOKEN: secret } },
      expiresAt: Date.now() + 60_000,
    }), null);
    const issuer = createRegistryProviderEvidence(store);
    const controller = createGatewayHostCredentialGenerationCapability(issuer);
    resources.push(() => {
      controller.close();
      store.close();
    });
    return { store, issuer, controller, secret };
  }

  afterEach(() => {
    for (const close of resources.splice(0)) close();
  });

  it('treats only missing optional injection as default off', () => {
    expect(resolveGatewayHostCredentialGenerationCapability(undefined)).toBeNull();
    expect(resolveGatewayHostCredentialGenerationCapability(null)).toBeNull();
    for (const forged of [
      {},
      { kind: 'gateway-host-credential-generation-capability', signal: new AbortController().signal },
      Object.freeze({ kind: 'gateway-host-credential-generation-capability' }),
    ]) {
      expect(() => resolveGatewayHostCredentialGenerationCapability(forged as never))
        .toThrow(GatewayHostCredentialGenerationCapabilityError);
    }
  });

  it('requires the Parser private issuer brand and rejects clones and proxies', () => {
    const { issuer } = fixture();
    expect(() => createGatewayHostCredentialGenerationCapability({ ...issuer }))
      .toThrow('CAPABILITY_INVALID');
    expect(() => createGatewayHostCredentialGenerationCapability(new Proxy(issuer, {})))
      .toThrow('CAPABILITY_INVALID');
    expect(() => createGatewayHostCredentialGenerationCapability({
      issue: issuer.issue,
      readEpoch: issuer.readEpoch,
      readSignal: issuer.readSignal,
      consume: issuer.consume,
      close: issuer.close,
    })).toThrow('CAPABILITY_INVALID');
  });

  it('allows one wrapper and one issuer claim only', () => {
    const { issuer, controller } = fixture();
    expect(resolveGatewayHostCredentialGenerationCapability(controller.capability))
      .toBe(controller.capability);
    expect(consumeGatewayHostCredentialGenerationIssuer(controller.capability)).toBe(issuer);
    expect(() => consumeGatewayHostCredentialGenerationIssuer(controller.capability))
      .toThrow('CAPABILITY_DUPLICATE');
    expect(() => createGatewayHostCredentialGenerationCapability(issuer))
      .toThrow('CAPABILITY_DUPLICATE');
  });

  it('invalidates before close synchronously aborts issuer and capability signals', async () => {
    const { issuer, controller } = fixture();
    const registry = new UpstreamCredentialRegistry({
      environment: 'test',
      providerEvidence: consumeGatewayHostCredentialGenerationIssuer(controller.capability),
    });
    const snapshot = await registry.reload(candidate);
    const issuerSignal = issuer.readSignal(snapshot, 'asset');
    let closedBeforeIssuerAbort = false;
    issuerSignal.addEventListener('abort', () => {
      try {
        resolveGatewayHostCredentialGenerationCapability(controller.capability);
      } catch (error) {
        closedBeforeIssuerAbort = error instanceof GatewayHostCredentialGenerationCapabilityError
          && error.code === 'closed';
      }
    });

    controller.close();

    expect(closedBeforeIssuerAbort).toBe(true);
    expect(issuerSignal.aborted).toBe(true);
    expect(issuerSignal.reason).toBeInstanceOf(HostCredentialGenerationError);
    expect(issuerSignal.reason.code).toBe('unavailable');
    expect(controller.capability.signal.aborted).toBe(true);
    expect(() => resolveGatewayHostCredentialGenerationCapability(controller.capability))
      .toThrow('CAPABILITY_CLOSED');
    expect(() => issuer.readEpoch(snapshot, 'asset')).toThrow('EVIDENCE_UNAVAILABLE');
    controller.close();
  });

  it('does not serialize issuer material through capability, controller or errors', () => {
    const { issuer, controller, secret } = fixture();
    const serialized = JSON.stringify({
      capability: controller.capability,
      controller,
      issuerClaim: consumeGatewayHostCredentialGenerationIssuer(controller.capability),
    });
    expect(serialized).not.toContain(secret);
    expect(Object.keys(controller.capability)).toEqual(['kind', 'signal']);
    expect(Object.keys(controller)).toEqual(['capability', 'close']);

    let failure: unknown;
    try {
      createGatewayHostCredentialGenerationCapability(issuer);
    } catch (error) {
      failure = error;
    }
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
  });
});
