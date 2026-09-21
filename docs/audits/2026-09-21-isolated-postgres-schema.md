---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-A4-02当前版本PostgreSQL空库验收

实现基线6fa430d，后续只有测试/文档提交；Windows、Node24.15.0、PostgreSQL16.10。package-lock.json SHA256：9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54。

预先构建API，设置API_NOVA_TEST_PG_BIN为本机PostgreSQL bin目录（本机E:/Programs/PostgreSQL/16/bin），从仓库根执行：

    node packages/api-nova-api/scripts/test-isolated-postgres-schema.cjs

wrapper新建tmp/pg-schema-acceptance-*集群，专用schema_fixture用户、127.0.0.1随机端口，丢弃应用/PG环境配置，只保留OS执行环境并显式传入测试DB参数和内存随机JWT。内部复用database-tool smoke postgres新建随机数据库，不连接已有应用库。

父任务独立复跑原始报告：

    {"marker":"ISOLATED_POSTGRES_SCHEMA_ACCEPTANCE_OK","dialect":"postgres","entities":69,"domainTables":69,"appliedMigrations":3,"empty":true,"schemaDrift":0,"restart":true,"restartMigrations":0,"restartSchemaDrift":0,"persistence":true,"apiStartup":true,"database":"api_nova_verify_16916_1789980458322","clusterStopped":true,"clusterRemoved":true,"scope":"local-current-schema-migrations-reconnect-persistence-api-startup"}

退出码0；覆盖空库、所有运行实体表、迁移去重、JSON/标量持久化、约束失败回滚、实际Nest启动及管理端点匿名401。子任务和父任务分别执行成功，父任务复查无pg-schema-acceptance-*残留。未修改产品数据库源码。

restart表示同一数据库的TypeORM连接重建，不是PG进程故障/掉电；当前空库验证不等于历史版本迁移升级或Linux/生产备份恢复。SEC-A4-02限定出口DONE；父包原基线治理退出不从该环境子项自动推导。

[脚本](../../packages/api-nova-api/scripts/test-isolated-postgres-schema.cjs)、[任务划分](../guides/active-work-package-breakdown.md)、[执行状态](../guides/active-work-package-execution-status.md)。本批最终132叶子：DONE59、READY25、WAIT_DEP28、NEED_ENV17、IN_PROGRESS0、SCOPE_REVIEW1、DEFERRED2。
