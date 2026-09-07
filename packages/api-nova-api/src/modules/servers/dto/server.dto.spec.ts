import { validate } from 'class-validator';
import { AuthType } from '../../../database/entities/auth-config.entity';
import { CreateAuthConfigDto, UpdateAuthConfigDto } from './server.dto';

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

  it('accepts an authentication type enabled in the current milestone', async () => {
    const create = Object.assign(new CreateAuthConfigDto(), {
      name: 'upstream-api-key',
      type: AuthType.API_KEY,
      config: { apiKeyHeader: 'X-API-Key' },
    });

    expect(await validate(create)).toEqual([]);
  });
});
