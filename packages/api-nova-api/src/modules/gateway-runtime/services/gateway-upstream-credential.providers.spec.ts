import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { GatewayRuntimeModule } from '../gateway-runtime.module';
import {
  createConfiguredGatewayCredentialRegistry,
  GATEWAY_UPSTREAM_CREDENTIAL_CONFIG as keys,
  GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY,
  gatewayUpstreamCredentialRegistryProvider,
  gatewayUpstreamCredentialResolverProvider,
} from './gateway-upstream-credential.providers';
import {
  GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER, GatewayUpstreamCredentialResolver,
} from './gateway-upstream-credential-resolver';

const secretName = 'API_NOVA_GATEWAY_CONFIG_SYNTHETIC_SECRET';
function document(revision = 'r1') {
  return {
    apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings',
    metadata: { revision, environment: 'test' },
    reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true },
    secretProviders: { env: { type: 'env' } },
    credentials: { token: { type: 'bearer', secretRef: 'env:' + secretName } },
    sites: [{
      id: 'site', sourceServiceAssetId: 'asset',
      match: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/' },
      allowedHosts: ['api.example.com'], credential: 'token',
      endpoints: [{ endpointDefinitionId: 'endpoint', credential: 'token' }],
    }],
  };
}
function config(values: Record<string, unknown>): ConfigService {
  return new ConfigService(values);
}

describe('Gateway configured credential activation', () => {
  let directory: string;
  let file: string;
  let previous: string | undefined;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'api-nova-gateway-config-')));
    file = join(directory, 'bindings');
    previous = process.env[secretName];
    process.env[secretName] = 'synthetic-gateway-secret';
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('registers the awaited factories in the actual Gateway module', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GatewayRuntimeModule);
    expect(providers).toContain(gatewayUpstreamCredentialRegistryProvider);
    expect(providers).toContain(gatewayUpstreamCredentialResolverProvider);
  });

  test('absent configuration retains the legacy resolver path', async () => {
    const registry = await createConfiguredGatewayCredentialRegistry(config({}));
    expect(registry).toBeNull();
    expect(gatewayUpstreamCredentialResolverProvider.useFactory(registry)).toBeNull();
  });

  test.each(['json', 'yaml'] as const)('activates %s through Nest before exposing the resolver', async format => {
    const value = document();
    await fs.writeFile(file, format === 'json' ? JSON.stringify(value) : dump(value));
    const module = await Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: config({
          [keys.file]: file, [keys.format]: format, [keys.environment]: 'test',
        }) },
        gatewayUpstreamCredentialRegistryProvider,
        gatewayUpstreamCredentialResolverProvider,
      ],
    }).compile();
    try {
      const registry = module.get<UpstreamCredentialRegistry>(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY);
      const resolver = module.get<GatewayUpstreamCredentialResolver>(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER);
      expect(registry.getStatus()).toMatchObject({ state: 'ready', revision: 'r1' });
      const route: any = { sourceServiceAsset: { id: 'asset' }, endpointDefinition: { id: 'endpoint' } };
      expect((await resolver.resolve(route, 'https://api.example.com/items')).headers)
        .toEqual({ authorization: 'Bearer synthetic-gateway-secret' });
      // The DI resolver captures the registry's current revision on each request.
      const replacement = document('r2');
      replacement.sites[0].endpoints[0].credential = 'none';
      await fs.writeFile(file, format === 'json' ? JSON.stringify(replacement) : dump(replacement));
      await registry.reloadFile(file, format);
      expect((await resolver.resolve(route, 'https://api.example.com/items')).headers).toEqual({});
    } finally { await module.close(); }
  });

  test.each([
    {}, { format: 'toml' }, { format: 'json' }, { environment: 'test' },
    { format: 'json', environment: '' },
  ])('rejects partial or invalid configuration: %p', async suffix => {
    const values: Record<string, unknown> = { [keys.file]: file };
    if ('format' in suffix) values[keys.format] = suffix.format;
    if ('environment' in suffix) values[keys.environment] = suffix.environment;
    await expect(createConfiguredGatewayCredentialRegistry(config(values)))
      .rejects.toThrow('gateway_upstream_credential_configuration_failed');
  });

  test('configured missing file fails bootstrap rather than enabling legacy fallback', async () => {
    await expect(Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: config({
          [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test',
        }) },
        gatewayUpstreamCredentialRegistryProvider,
        gatewayUpstreamCredentialResolverProvider,
      ],
    }).compile()).rejects.toThrow('gateway_upstream_credential_configuration_failed');
  });

  test.each(['environment', 'secret', 'syntax', 'watch'])('rejects %s failure with static diagnostics', async failure => {
    const value = document();
    if (failure === 'environment') value.metadata.environment = 'other';
    if (failure === 'secret') delete process.env[secretName];
    if (failure === 'watch') value.reload.mode = 'watch';
    await fs.writeFile(file, failure === 'syntax' ? '{"sensitive":"synthetic-gateway-secret"' : JSON.stringify(value));
    const error = await createConfiguredGatewayCredentialRegistry(config({
      [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test',
    })).catch(error => error);
    expect(error.message).toBe('gateway_upstream_credential_configuration_failed');
    expect(String(error)).not.toContain(file);
    expect(String(error)).not.toContain(secretName);
    expect(String(error)).not.toContain('synthetic-gateway-secret');
    expect(error.cause).toBeUndefined();
  });
  test('host watch opt-in updates the live DI resolver and Nest close stops it', async () => {
    const initial = document(); initial.reload.mode = 'watch'; initial.reload.debounceMs = 40;
    await fs.writeFile(file, JSON.stringify(initial));
    const module = await Test.createTestingModule({ providers: [
      { provide: ConfigService, useValue: config({
        [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test', [keys.reloadMode]: 'watch',
      }) }, gatewayUpstreamCredentialRegistryProvider, gatewayUpstreamCredentialResolverProvider,
    ] }).compile();
    const registry = module.get<UpstreamCredentialRegistry>(GATEWAY_UPSTREAM_CREDENTIAL_REGISTRY);
    try {
      const resolver = module.get<GatewayUpstreamCredentialResolver>(GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER);
      const route: any = { sourceServiceAsset: { id: 'asset' }, endpointDefinition: { id: 'endpoint' } };
      expect((await resolver.resolve(route, 'https://api.example.com/items')).headers)
        .toEqual({ authorization: 'Bearer synthetic-gateway-secret' });
      const replacement = document('r2'); replacement.reload.mode = 'watch';
      replacement.sites[0].endpoints[0].credential = 'none';
      await fs.writeFile(file, JSON.stringify(replacement));
      const deadline = Date.now() + 4000;
      while (registry.getStatus().revision !== 'r2' && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 20));
      }
      expect(registry.getStatus().revision).toBe('r2');
      expect((await resolver.resolve(route, 'https://api.example.com/items')).headers).toEqual({});
    } finally { await module.close(); }
    const retained = registry.captureSnapshot();
    const afterClose = document('r3'); afterClose.reload.mode = 'watch';
    await fs.writeFile(file, JSON.stringify(afterClose));
    await new Promise(done => setTimeout(done, 200));
    expect(registry.captureSnapshot()).toBe(retained);
  });

  test.each(['auto', true, ''])('rejects invalid host reload mode %p', async reloadMode => {
    await fs.writeFile(file, JSON.stringify(document()));
    await expect(createConfiguredGatewayCredentialRegistry(config({
      [keys.file]: file, [keys.format]: 'json', [keys.environment]: 'test', [keys.reloadMode]: reloadMode,
    }))).rejects.toThrow('gateway_upstream_credential_configuration_failed');
  });

});
