import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  AuditAction,
  AuditLevel,
  AuditLog,
  AuditStatus,
} from '../../../database/entities/audit-log.entity';
import { Permission } from '../../../database/entities/permission.entity';
import { Role } from '../../../database/entities/role.entity';
import { User } from '../../../database/entities/user.entity';
import { AuditService } from './audit.service';

describe('AuditService operator retrieval (PROD-05)', () => {
  let db: DataSource;
  let service: AuditService;
  const actorA = '11111111-1111-4111-8111-111111111111';
  const actorB = '22222222-2222-4222-8222-222222222222';

  const seedActor = async (id: string, username: string) => {
    await db.getRepository(User).save(db.getRepository(User).create({
      id,
      username,
      email: `${username}@example.test`,
      password: 'synthetic-hash',
    }));
  };
  const seed = async (resource: string, resourceId: string, userId: string) => {
    const repository = db.getRepository(AuditLog);
    await repository.save(repository.create({
      action: AuditAction.API_CONFIGURED,
      level: AuditLevel.INFO,
      status: AuditStatus.SUCCESS,
      resource,
      resourceId,
      userId,
      details: { operation: 'update' },
    }));
  };

  beforeEach(async () => {
    db = await new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [AuditLog, User, Role, Permission],
    }).initialize();
    service = new AuditService(db.getRepository(AuditLog), db.getRepository(User));
  });

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  test('filters instance and binding mutations by resource, resourceId and actor', async () => {
    await seedActor(actorA, 'operator-a');
    await seedActor(actorB, 'operator-b');
    await seed('source_service_instance', 'instance-1', actorA);
    await seed('source_service_instance', 'instance-2', actorA);
    await seed('runtime_upstream_binding', 'membership-1', actorB);

    const instanceTrail = await service.findLogs({
      resource: 'source_service_instance',
      resourceId: 'instance-1',
      userId: actorA,
    });
    expect(instanceTrail.total).toBe(1);
    expect(instanceTrail.data[0]).toMatchObject({
      resource: 'source_service_instance',
      resourceId: 'instance-1',
      userId: actorA,
    });
    expect(instanceTrail.data[0].user?.username).toBe('operator-a');

    const bindingTrail = await service.findLogs({
      resource: 'runtime_upstream_binding',
      resourceId: 'membership-1',
      userId: actorB,
    });
    expect(bindingTrail.total).toBe(1);
    expect(bindingTrail.data[0].resourceId).toBe('membership-1');

    const mismatched = await service.findLogs({
      resource: 'source_service_instance',
      resourceId: 'instance-1',
      userId: actorB,
    });
    expect(mismatched.total).toBe(0);

    const missing = await service.findLogs({
      resource: 'source_service_instance',
      resourceId: 'unknown-instance',
    });
    expect(missing.total).toBe(0);
  });
});
