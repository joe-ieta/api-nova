---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-10-26
---
# 数据库配置、初始化与维护

SQLite为默认持久模式，PostgreSQL为显式可选模式。当前共享模型为73张业务表、每种方言8项迁移；该数字来自rc.5双库验收，schema变更后须重新验证，不能永久硬编码为运维判断。

## 有效配置

| 选择 | 必填/相关配置 | 约束 |
| --- | --- | --- |
| SQLite | DB_TYPE=sqlite；DB_SQLITE_PATH默认data/api-nova.db | 一个API实例、持久可写目录；相对路径按工作区根解析 |
| PostgreSQL | DB_TYPE=postgres；DB_HOST/PORT/USERNAME/PASSWORD/DATABASE | 单独设置host等不会自动切换方言；连接权限、备份和目标容量需核验 |

DB_SYNCHRONIZE=true被拒绝；runtime synchronize始终false。应用与迁移CLI共享配置加载：进程环境优先，API包`.env.local`、`.env.<NODE_ENV>`、`.env`按既有优先级加载；API_NOVA_ENV_FILE可显式选择存在的文件。NODE_ENV=test默认不读取这些文件。

## 首次初始化

确认选定的是**新空库**后，从根目录执行：

```bash
npm run build --workspace api-nova-api
npm run migration:run --workspace api-nova-api
npm run start:dev --workspace api-nova-api
```

API首次启动会创建必要角色/用户，运行后的库不再是空schema。迁移配置从[database-options.ts](../../packages/api-nova-api/src/database/database-options.ts)读取初始结构及7类后续演进；不能沿用旧“每方言只有一个迁移”的说明，也不支持任意历史结构自动修复/回填。

## 隔离检查

以下命令新建测试库/文件，不重置配置中的业务库：

```bash
npm run db:create-empty --workspace api-nova-api -- sqlite
npm run db:create-empty --workspace api-nova-api -- postgres
npm run db:smoke --workspace api-nova-api -- sqlite --keep
npm run db:smoke --workspace api-nova-api -- postgres --keep
```

PG账户需要创建隔离数据库权限，DB_ADMIN_DATABASE默认postgres。keep保留测试库以供检查；结果按脚本输出的实际目录登记。检查迁移所有权、表/漂移、事务、进程持久化、API启动及匿名管理拒绝；不能用静态SQL文件存在代替运行验证。

## schema与升级

SQL导出位于`packages/api-nova-api/database`，不包含业务seed或迁移账本；不能先导入schema再无判断运行相同初始迁移。开发期schema生成器会重写开发导出/初始迁移，只能用于明确的新隔离数据库，不作为线上升级命令。

已有数据库升级、数据保留和回退必须遵守该版本说明及可验证备份；不能删除数据来通过初始化检查。SQLite大样本容量未全量证明，PostgreSQL本机证据也不代替生产角色、恢复、多进程及负载签收。见[部署](DEPLOYMENT.md)、[open-items](../reference/open-items.md)。
