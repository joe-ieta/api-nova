// Use the same JOSE major as the shared runtime verifier.
const { exportJWK, generateKeyPair, SignJWT } = require(require.resolve('jose', { paths: [require.resolve('api-nova-parser')] }));
import { PublicationService } from './publication.service';
import { GatewaySecurityService } from '../../gateway-runtime/services/gateway-security.service';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';

describe('persisted Gateway JWT verification policy', () => {
  const original = { ...process.env };
  let privateKey: any;
  beforeAll(async () => {
    const keys = await generateKeyPair('RS256'); privateKey = keys.privateKey;
    process.env.API_NOVA_RUNTIME_ISSUER = 'https://issuer.example';
    process.env.API_NOVA_RUNTIME_RESOURCE = 'https://gateway.example';
    process.env.API_NOVA_RUNTIME_JWKS_JSON = JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'policy' }] });
    delete process.env.API_NOVA_RUNTIME_JWKS_URI;
    delete process.env.API_NOVA_RUNTIME_REQUIRED_SCOPES;
    delete process.env.API_NOVA_RUNTIME_JWT_POLICY;
  });
  afterAll(() => { process.env = original; });
  const setup = (existing?: any) => {
    const service: any = Object.create(PublicationService.prototype);
    Object.assign(service, {
      resolveMembershipPublicationContext: jest.fn().mockResolvedValue({ runtimeAsset: { id: 'runtime', type: RuntimeAssetType.GATEWAY_SERVICE }, endpointDefinition: { id: 'endpoint' }, sourceServiceAsset: { id: 'source' } }),
      extractPrimaryEndpoint: () => ({ path: '/demo', method: 'GET' }), findGatewayRouteBinding: jest.fn().mockResolvedValue(existing),
      ensureRouteConflictFree: jest.fn(), recordAuditEvent: jest.fn(), emitGatewaySnapshotRefresh: jest.fn(), buildMembershipPublicationState: jest.fn(),
      routeBindingRepository: { create: (value: any) => value, save: jest.fn() },
    });
    return service;
  };
  const token = (claims: any = {}) => new SignJWT({ sub: 'subject', iss: 'https://issuer.example', aud: 'https://gateway.example',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'policy' }).sign(privateKey);
  it('normalizes the saved policy and enforces it through actual Gateway authorization', async () => {
    const service = setup();
    await service.configureRuntimeMembershipGatewayRoute('membership', { upstreamConfig: { jwtPolicy: {
      algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'tenant'], clockToleranceSeconds: 20,
    } } });
    const routeBinding = JSON.parse(JSON.stringify(service.routeBindingRepository.save.mock.calls[0][0]));
    const gateway = new GatewaySecurityService({ log: jest.fn() } as any, {} as any);
    const route: any = { routeBinding, runtimeAsset: { id: 'runtime' }, policies: { auth: { mode: 'jwt' } } };
    const authorize = async (claims: any) => gateway.authorize(route, { headers: { authorization: `Bearer ${await token(claims)}` } } as any);
    await expect(authorize({})).rejects.toMatchObject({ status: 401 });
    await expect(authorize({ tenant: 'a', exp: Math.floor(Date.now() / 1000) - 5 })).resolves.toMatchObject({ mode: 'jwt' });
    routeBinding.upstreamConfig.jwtPolicy.algorithms = ['ES256'];
    await expect(authorize({ tenant: 'a' })).rejects.toMatchObject({ status: 401 });
    routeBinding.upstreamConfig.jwtPolicy = null;
    await expect(authorize({ tenant: 'a' })).rejects.toMatchObject({ status: 503 });
  });
  it.each([null, { algorithms: ['HS256'] }, { requiredClaims: ['sub'] }, { clockToleranceSeconds: 301 }])('rejects invalid policy before saving %j', async jwtPolicy => {
    const service = setup();
    await expect(service.configureRuntimeMembershipGatewayRoute('membership', { upstreamConfig: { jwtPolicy } })).rejects.toThrow('invalid_jwt_policy');
    expect(service.routeBindingRepository.save).not.toHaveBeenCalled();
  });
  it('preserves JWT policy during unrelated upstream configuration changes', async () => {
    const jwtPolicy = { algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'tenant'], clockToleranceSeconds: 5 };
    const service = setup({ id: 'route', upstreamConfig: { jwtPolicy } });
    await service.configureRuntimeMembershipGatewayRoute('membership', { upstreamConfig: { timeout: 5 } });
    expect(service.routeBindingRepository.save).toHaveBeenCalledWith(expect.objectContaining({ upstreamConfig: { timeout: 5, jwtPolicy } }));
  });
});
