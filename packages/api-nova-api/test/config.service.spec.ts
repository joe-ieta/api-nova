import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from '../src/config/app-config.service';
import { validationSchema } from '../src/config/validation.schema';

describe('AppConfigService', () => {
  let service: AppConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          validationSchema,
          ignoreEnvFile: true,
        }),
      ],
      providers: [AppConfigService],
    }).compile();

    service = module.get<AppConfigService>(AppConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should have default values', () => {
    expect(service.port).toBe(9001);
    expect(service.mcpPort).toBe(9022);
    expect(service.nodeEnv).toBeDefined();
    expect(service.throttleTtl).toBe(60);
    expect(service.throttleLimit).toBe(10);
    expect(service.jwtExpiresIn).toBe('15m');
    expect(service.processTimeout).toBe(30000);
    expect(service.healthCheckInterval).toBe(30000);
  });

  it('should have configuration methods', () => {
    expect(typeof service.get).toBe('function');
    expect(typeof service.getAllConfig).toBe('function');
  });

  it('should expose newly governed config groups in getAllConfig', () => {
    const config = service.getAllConfig();

    expect(config.throttle).toEqual({
      ttlSeconds: 60,
      limit: 10,
    });
    expect(config.security).toMatchObject({
      jwtEnabled: false,
      refreshTokenEnabled: false,
      accessTokenExpiresIn: '15m',
    });
    expect(config.process).toMatchObject({
      timeout: 30000,
      maxRetries: 3,
      restartDelay: 1000,
      pidDirectory: 'pids',
    });
    expect(config.monitoring).toMatchObject({
      metricsEnabled: true,
      healthCheckEnabled: true,
      healthCheckInterval: 30000,
      healthCheckTimeout: 5000,
      autoRestartUnhealthyServers: false,
    });
  });
});
