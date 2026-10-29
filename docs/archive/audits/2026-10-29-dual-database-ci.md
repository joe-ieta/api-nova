# 2026-10-29 双库CI结果核验

核验对象为提交`a63d07655a04111b90cc22de2c1e5488a0fa8684`，对应[双库CI运行40811446522](https://github.com/joe-ieta/api-nova/actions/runs/40811446522)。GitHub运行及两个作业均为completed/success，未发现失败步骤。已核对运行head SHA、各步骤结论和两份作业日志；结构化结果及原始日志SHA-256见[ci-summary.json](evidence/2026-10-29-dual-database-ci/ci-summary.json)。

| 作业 | 结论 | API单元回归 | UI回归 | 安全依赖专项 |
| --- | --- | --- | --- | --- |
| [SQLite](https://github.com/joe-ieta/api-nova/actions/runs/40811446522/job/123242457585) | success | 192 suites / 2065 tests | 95 tests | 16 tests |
| [PostgreSQL](https://github.com/joe-ieta/api-nova/actions/runs/40811446522/job/123242457877) | success | 192 suites / 2065 tests | 95 tests | 16 tests |

运行环境为Ubuntu 24.04、Node24.15.0、npm10.9.2。两份作业的API单元测试均按既有合同使用隔离SQL.js fixture，不能表述成2065项全部在PostgreSQL执行。实际SQLite/PostgreSQL分别由后续`db:smoke`、迁移与启动步骤核验。

两种数据库的`DATABASE_SMOKE_OK`均确认：73实体/73业务表、8次迁移、schemaDrift=0；空库初始化、重启后零重复迁移/零漂移、跨重启持久化、API启动及认证证据存储通过。隔离库`migration:run`及`/api/health/live`、`/api/system/initialization`启动冒烟亦通过。API/UI构建、共享包构建和锁文件安装步骤成功。

## 本轮处置及验收边界

- CI没有失败，无需修复业务代码或追加重复测试。上一批新增14项发布保旧、安全负例已随2065项API回归在两个CI作业通过；原本机验证与失败复现保留在[发布保旧与依赖整改审计](2026-10-29-publication-preservation-and-dependencies.md)。
- 将OPS-01/EXT-05维护步骤与SEC-F4-02兼容补丁标记为已完成远端限定回归；原任务状态仍由[统一台账](../../guides/active-work-package-execution-status.md)维护，不新增209条历史叶子或改变245条依赖。
- 本次CI没有执行新的在线依赖审计。既有5 high、12 moderate包节点是上一批审计结果，不因构建/安全专项通过清零或接受；Vue I18n/Intlify、Zod、Hono/MCP SDK迁移及Nest风险处置继续归SEC-F4-02。
- 本次只证明CI环境下的schema、持久化、liveness和初始化出口；不等于目标生产账户/ACL/TLS、完整健康、可观测容量、人工反馈或生产签收。SEC-F4-02、OBS-16-04仍IN_PROGRESS，OPS-01仍WAIT_DEP，延期项不变。
- 用户要求暂不发布；未触发release-artifacts工作流、未创建tag或新交付包。本轮仅更新文档和CI证据，不重写此前本机验收记录。
