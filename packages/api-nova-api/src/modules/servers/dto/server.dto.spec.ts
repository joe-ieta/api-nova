import { validate } from 'class-validator';
import { AuthType } from '../../../database/entities/auth-config.entity';
import { McpInboundAuthMode } from '../../../database/entities/mcp-server.entity';
import { CreateAuthConfigDto, CreateServerDto, UpdateAuthConfigDto, UpdateServerDto } from './server.dto';

describe('server authentication DTOs', () => {
  it('keeps OAuth2 reserved but rejects it for current create/update operations', async () => {
    const create = Object.assign(new CreateAuthConfigDto(), {
      name: 'future-oauth',
      type: AuthType.OAUTH2,
      config: {},
    });
    const update = Object.assign(new UpdateAuthConfigDto(), {
      type: AuthType.OAUTH2,
    });

    expect((await validate(create)).map(error => error.property)).toContain('type');
    expect((await validate(update)).map(error => error.property)).toContain('type');
  });

  it('accepts only explicit MCP HTTP inbound modes without requiring one for legacy server edits', async () => {
    const create = Object.assign(new CreateServerDto(), {
      name: 'inbound-test', openApiData: {}, inboundAuthMode: McpInboundAuthMode.PRIVATE_JWT,
    });
    expect(await validate(create)).toEqual([]);
    const legacyEdit = Object.assign(new UpdateServerDto(), { description: 'unchanged mode' });
    expect(await validate(legacyEdit)).toEqual([]);
    for (const inboundAuthMode of ['oauth2', 'local_process', null]) {
      const update = Object.assign(new UpdateServerDto(), { inboundAuthMode });
      expect((await validate(update)).map(error => error.property)).toContain('inboundAuthMode');
    }
  });

  it('accepts an authentication type enabled in the current milestone', async () => {
    const create = Object.assign(new CreateAuthConfigDto(), {
      name: 'upstream-api-key',
      type: AuthType.API_KEY,
      config: { apiKeyHeader: 'X-API-Key' },
    });

    expect(await validate(create)).toEqual([]);
  });
});
