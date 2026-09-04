import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { User, UserStatus } from './entities/user.entity';
import { Role, SYSTEM_ROLES } from './entities/role.entity';
import { Permission, SYSTEM_PERMISSIONS } from './entities/permission.entity';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      this.logger.log('Starting database seed initialization...');
      await this.initializePermissions();
      await this.initializeRoles();
      await this.initializeSuperAdmin();
      this.logger.log('Database seed initialization completed');
    } catch (error) {
      this.logger.error('Database seed initialization failed', error);
      throw error;
    }
  }

  private async initializePermissions(): Promise<void> {
    this.logger.log('Initializing system permissions...');

    const permissions = Object.values(SYSTEM_PERMISSIONS);
    let createdCount = 0;

    for (const permissionData of permissions) {
      const existingPermission = await this.permissionRepository.findOne({
        where: { name: permissionData.name },
      });

      if (!existingPermission) {
        const permission = this.permissionRepository.create(permissionData);
        await this.permissionRepository.save(permission);
        createdCount++;
        this.logger.debug(`Created permission: ${permissionData.name}`);
      }
    }

    this.logger.log(
      `Permission initialization completed, created ${createdCount} permissions`,
    );
  }

  private async initializeRoles(): Promise<void> {
    this.logger.log('Initializing system roles...');

    const roles = Object.values(SYSTEM_ROLES);
    let createdCount = 0;

    for (const roleData of roles) {
      const existingRole = await this.roleRepository.findOne({
        where: { name: roleData.name },
        relations: ['permissions'],
      });

      if (!existingRole) {
        const role = this.roleRepository.create(roleData);
        role.permissions = await this.resolveSystemRolePermissions(roleData.name);
        await this.roleRepository.save(role);
        createdCount++;
        this.logger.debug(`Created role: ${roleData.name}`);
        continue;
      }

      existingRole.permissions = await this.resolveSystemRolePermissions(
        roleData.name,
      );
      await this.roleRepository.save(existingRole);
      this.logger.debug(`Synchronized role permissions: ${roleData.name}`);
    }

    this.logger.log(
      `Role initialization completed, created ${createdCount} roles`,
    );
  }

  private async resolveSystemRolePermissions(
    roleName: string,
  ): Promise<Permission[]> {
    if (roleName === 'super_admin') {
      return this.permissionRepository.find();
    }

    const permissionNamesByRole: Record<string, string[]> = {
      admin: [
        'user:create',
        'user:read',
        'user:update',
        'user:delete',
        'server:create',
        'server:read',
        'server:update',
        'server:delete',
        'server:execute',
        'server:manage',
        'api:read',
        'api:execute',
        'api:manage',
        'monitoring:read',
        'audit:read',
        'system:view',
        'config:read',
        'config:update',
      ],
      operator: [
        'user:read',
        'server:read',
        'server:update',
        'server:execute',
        'api:read',
        'api:execute',
        'monitoring:read',
        'config:read',
      ],
      viewer: [
        'user:read',
        'server:read',
        'api:read',
        'monitoring:read',
        'system:view',
        'config:read',
      ],
      guest: ['server:read', 'api:read'],
    };

    const permissionNames = permissionNamesByRole[roleName] || [];
    if (permissionNames.length === 0) {
      return [];
    }

    return this.permissionRepository.find({
      where: permissionNames.map((name) => ({ name })),
    });
  }

  private async initializeSuperAdmin(): Promise<void> {
    this.logger.log('Checking super admin...');

    const superAdminRole = await this.roleRepository.findOne({
      where: { name: 'super_admin' },
      relations: ['users'],
    });

    if (!superAdminRole) {
      this.logger.error('Super admin role not found');
      throw new Error('Super admin role not found');
    }

    const existingSuperAdmin = await this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.roles', 'role')
      .where('role.name = :roleName', { roleName: 'super_admin' })
      .getOne();

    if (existingSuperAdmin) {
      await this.reconcileExistingSuperAdmin(existingSuperAdmin);
      this.logger.log(`Super admin already exists: ${existingSuperAdmin.username}`);
      return;
    }

    const superAdminData = {
      username: this.configService.get('SUPER_ADMIN_USERNAME', 'admin'),
      email: this.configService.get('SUPER_ADMIN_EMAIL', 'admin@example.com'),
      password: this.configService.get('SUPER_ADMIN_PASSWORD', 'Admin@123456'),
      firstName: this.configService.get('SUPER_ADMIN_FIRST_NAME', 'Super'),
      lastName: this.configService.get('SUPER_ADMIN_LAST_NAME', 'Admin'),
      status: UserStatus.ACTIVE,
      emailVerified: true,
      metadata: {
        isSystemUser: true,
        createdBySystem: true,
        department: 'System Administration',
        position: 'Super Administrator',
      },
    };

    try {
      const superAdmin = this.userRepository.create(superAdminData);
      superAdmin.roles = [superAdminRole];
      await this.userRepository.save(superAdmin);

      this.logger.log('Super admin created successfully');
      this.logger.log(`  Username: ${superAdminData.username}`);
      this.logger.log(`  Email: ${superAdminData.email}`);
      this.logger.log('  Change the default password after first login');
    } catch (error) {
      this.logger.error('Failed to create super admin', error);
      throw error;
    }
  }

  private async reconcileExistingSuperAdmin(user: User): Promise<void> {
    const isDevelopment =
      this.configService.get<string>('NODE_ENV', 'development') !== 'production';

    if (!isDevelopment) {
      return;
    }

    let dirty = false;

    if (user.status !== UserStatus.ACTIVE) {
      user.status = UserStatus.ACTIVE;
      dirty = true;
    }

    if (!user.emailVerified) {
      user.emailVerified = true;
      dirty = true;
    }

    if (user.lockedUntil) {
      user.lockedUntil = null;
      dirty = true;
    }

    if (user.loginAttempts !== 0) {
      user.loginAttempts = 0;
      dirty = true;
    }

    if (!dirty) {
      return;
    }

    await this.userRepository.save(user);
    this.logger.warn(
      `Reconciled development super admin state: ${user.username}`,
    );
  }

  async isSystemInitialized(): Promise<boolean> {
    const superAdminRole = await this.roleRepository.findOne({
      where: { name: 'super_admin' },
      relations: ['users'],
    });

    return !!(
      superAdminRole &&
      superAdminRole.users &&
      superAdminRole.users.length > 0
    );
  }

  async getInitializationStatus(): Promise<{
    isInitialized: boolean;
    permissionCount: number;
    roleCount: number;
    superAdminExists: boolean;
  }> {
    const [permissionCount, roleCount, isInitialized] = await Promise.all([
      this.permissionRepository.count(),
      this.roleRepository.count(),
      this.isSystemInitialized(),
    ]);

    return {
      isInitialized,
      permissionCount,
      roleCount,
      superAdminExists: isInitialized,
    };
  }
}
