---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-26
---
# 数据库结构导出

当前初始化、配置、迁移和隔离检查统一见[数据库手册](../../../docs/guides/database-strategy.md)。本目录的sqlite-schema.sql、postgres-schema.sql是开发schema导出，不包含业务seed或迁移账本，不能导入后再无判断重复执行初始迁移。

当前rc.5验证基线为73张业务表、每方言8项迁移；实际迁移入口在src/database/database-options.ts。修改模型后按开发验证流程重生成导出并复验，不将生成器作为已有业务库升级或重置命令。
