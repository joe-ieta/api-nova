---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-A2-01B三入口拒绝矩阵

| 入口 | 有效证据 | 拒绝条件与副作用 |
| --- | --- | --- |
| RuntimeAssets.deployMcpRuntimeAsset部署保存 | 三种显式模式保存/摘要可追溯 | 缺失/未知/非法持久或请求模式在候选、端口分配、保存前拒绝；保存不等于运行 |
| ServerManager.onModuleInit自动恢复 | 真实initializeExistingServers→startServer→凭证预检，启动副作用隔离 | 旧unknown/缺凭据不启动，失败可记录；开发全局anonymous不填补持久未知，显式匿名才允许 |
| ProcessManager/现行CLI/实验child | 配置缺失/未知/不符拒绝；真实HTTP与IPC验证 | 重启预检发生在stop前，spawn再核验；实验支持范围仍仅API Key，不代表生产IPC接线 |

实际修复：ProcessManager原先先停止旧进程后才在startProcess发现配置问题；现在停止、状态更新前预检。延迟期间凭据变化也会在真正启动前被再次拒绝。

父任务独立验收：API servers+runtime-assets 12套88/88。子任务定向7套74/74；现行CLI HTTP3/3、实验child14/14、API构建通过。测试集有重叠，不累加成覆盖率。初次从monorepo根误运行API限定命令时其他workspace无匹配退出1，改用正确API目录后全部通过。

自动恢复测试隔离数据库/进程副作用但调用真实预检；真实CLI HTTP和实验IPC另有实际child。不是生产启动全过程或Linux验收。保存允许配置受保护模式，凭据可用性由启动预检负责；effective仍unknown。

[任务划分](../guides/active-work-package-breakdown.md)和[状态](../guides/active-work-package-execution-status.md)登记A2-01B DONE，A3仍等待SEC-B1-01；不新增父包DONE。
