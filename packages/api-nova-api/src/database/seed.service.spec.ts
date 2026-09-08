import { SeedService } from './seed.service';
import { UserStatus } from './entities/user.entity';

describe('SeedService current accounts', () => {
  it('does not reactivate or unlock an existing administrator at startup', async () => {
    const user = { username: 'admin', status: 'inactive' as UserStatus,
      emailVerified: false, loginAttempts: 5, lockedUntil: new Date('2030-01-01') };
    const query = { innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user) };
    const users = { createQueryBuilder: jest.fn().mockReturnValue(query), save: jest.fn() };
    const roles = { findOne: jest.fn().mockResolvedValue({ name: 'super_admin' }) };
    const service = new SeedService(users as any, roles as any, {} as any,
      { get: () => 'development' } as any);
    await (service as any).initializeSuperAdmin();
    expect(users.save).not.toHaveBeenCalled();
    expect(user.loginAttempts).toBe(5);
    expect(user.emailVerified).toBe(false);
  });
});
