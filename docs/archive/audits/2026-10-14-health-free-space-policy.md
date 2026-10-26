---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-14
---
# ENV-01 空闲5GiB健康门槛及完整健康复验

2026-10-14用户明确将系统盘指标调整为“空闲5G”。按本次沟通的二进制容量口径实现为 **至少5 GiB（5,368,709,120字节）可用**，替代原使用率不超过90%的规则。既有审计中的90%失败是历史结果，不再作为当前磁盘阻断条件。

## 实现合同

- Windows检查C盘，其他平台检查根目录；使用Node原生statfs的bavail×bsize，反映运行账户可用空间，不依赖磁盘总容量百分比。
- 恰好5GiB通过；低于门槛、读取失败或无效采样失败，健康汇总返回503。响应保留disk键，并给出freeBytes、requiredFreeBytes及path；读取失败不虚构空闲数。
- 内存与MCP依赖继续独立检查。未修改可观测配额高低水位、留存、清理或物理空间保护合同，未删除用户文件。
- 注册独立DiskFreeSpaceHealthIndicator；未把Terminus“最多已用字节”配置误当作“至少空闲字节”。
- verify-env-01按运行时返回的门槛和实际可用数断言，新增指标产物哈希与工作树记录；浏览器验收器的空间不足诊断也按5GiB计算。

## 验证与证据

基线为 `oc_dev / 9356eef` 加本轮健康指标修复；未宣称完整API回归或生产签收。

| 项目 | 结果与证据 |
| --- | --- |
| 健康专项 | 8/8通过：9GiB且已用91%、恰好5GiB、低1字节拒绝及恢复、读取失败、三类无效采样、MCP失联与恢复；`.tmp/2026-10-14-health-free-space-tests.log` |
| API构建 | `npm run build --workspace api-nova-api` exit 0；`.tmp/2026-10-14-health-free-space-build.log` |
| 真实完整健康 | `npm run verify:env-01 -- --with-monitoring` exit 0，`FULL_HEALTH_PASSED`；`.tmp/env-01-nb13jB/evidence.json` |
| MCP启动前 | /health返回503，mcp_server=down；磁盘及内存为up |
| MCP启动后 | /health返回200，status=ok，四项均up，remainingFailures为空 |
| 监控入口 | 打包UI与Vite各4项，共8项HTTP检查通过；不是新的浏览器业务流程验收 |
| 资源清理 | 隔离API、MCP、Vite子进程已停止，3个端口均不可达；证据/脱敏日志保留在.tmp，不入Git |

运行时间为2026-10-14 12:23:16—12:23:47（Asia/Shanghai），Windows、Node v24.15.0、新迁移SQLite与随机端口。完整健康响应的空闲量为 **9,663,905,792字节（约9.000GiB）**，要求5,368,709,120字节。按原规则约90.95%已用会失败，按用户批准的新规则通过。

可复现专项入口：`npm run test --workspace api-nova-api -- --runInBand --runTestsByPath src/modules/health/health.controller.spec.ts`。

## 状态边界

ENV-01维持DONE，本机完整健康从旧规则下的磁盘受限更新为新规则下实测通过。当前不再要求额外释放2GiB才能进行本机健康验收；空间低于5GiB时仍会失败。Linux实现保持相同逻辑，但本次没有Linux主机实测。

SEC-F4-02、OBS-16-04、OPS-01目标签收继续待办。新指标和本机200不代表目标部署、容量、真实业务MCP调用或生产签收完成。历史审计原始样本保留，当前调度以[执行台账](../../guides/active-work-package-execution-status.md)为准。
