---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# OBS-14-05C3 Windows PostgreSQL多写者验收

实现基线6fa430d；本提交只新增验收脚本和证据，不改变产品实现。Windows、Node24.15.0、PostgreSQL16.10；package-lock.json SHA256：9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54。

复跑前设置API_NOVA_TEST_PG_BIN为本机PostgreSQL bin目录（本机E:/Programs/PostgreSQL/16/bin），从仓库根执行：

    node packages/api-nova-api/scripts/test-call-observability-payload-pg-multiwriter.cjs

脚本创建全新集群，只监听127.0.0.1随机端口，专用quota_fixture用户，过滤已有PG连接参数。每项使用独立schema，多个独立Node PID共享真实PG；每项停止再启动本次PG集群。所有路径在工作区tmp/observability-pg-multiwriter-tests/run-*，清理前校验范围，仅停止本次data目录。

| 场景 | 结果 |
| --- | --- |
| 四进程竞争1000B预算、各预留600B | 仅一项成功，另外三项额度拒绝；重启仍600B |
| 同operation四进程竞争 | 唯一预留/唯一收费，重启重复仍幂等 |
| 预留提交后杀写者 | 保留600B，重复不收费，额外600B拒绝 |
| 预留事务中杀写者 | 预留/账本同时回滚，重启新写者可用 |
| 实际ingest最终link后中断 | final/temp各10B，20B预留不释放，无伪元数据 |
| 实际ingest写入5/10B时中断 | 仅5B临时残留，保留20B预留 |
| temp删除后、结算前中断 | final10B、无temp，仍保留20B待证明 |
| receipt/payload已插入、metadata事务未提交中断 | 元数据整事务回滚，已发布10B继续计费 |
| 四个实际ingest竞争同文件根和PG | 全部4条业务元数据保留，正文按预算采集/省略；重启后成功事件跨进程重放不重复收费 |

代理初跑9/9、34.40秒；父任务独立复跑9/9、49.27秒，退出码0。这是执行时长而非性能承诺。父任务检查测试父目录为空。初次脚本诊断修复Windows pg_ctl后代继承pipe导致等待不结束及测试worker重复断开IPC；最终全套通过。

本机C3核心矩阵完成；Linux仍无就绪环境：wsl --list仅docker-desktop，docker version提示dockerDesktopLinuxEngine命名管道不存在。PG自身异常崩溃/掉电、长期物理压力和生产根未验，不外推。C3整包保留NEED_ENV，05D等待，不再把本机可执行用例列为环境阻塞。

[脚本](../../packages/api-nova-api/scripts/test-call-observability-payload-pg-multiwriter.cjs)、[划分](../guides/active-work-package-breakdown.md)、[状态](../guides/active-work-package-execution-status.md)。
