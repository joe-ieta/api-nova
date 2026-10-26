---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# ENV-01 Windows 完整健康复核与监控页入口修复

> ENV-01 按“保存完整结果，通过或限制均有证据”的原合同限定完成。本机 `/health` 仍因系统盘使用率超过 90% 返回 503，不能据此签署生产健康通过。监控页入口修复归 OPS-01 本地准备，不等于浏览器全过程或生产交付签收。

## 复现入口与隔离范围

- 命令：`node scripts/verify-env-01.cjs --with-monitoring`；只复核健康可省略 `--with-monitoring`。
- 前置：仓库依赖已安装、API/server 已构建；带监控入口验证时需已有 UI 构建。复核使用真实产品构建、空 SQLite migration、随机端口和独立 `.tmp/env-01-*` 目录。
- 本轮：Windows 10.0.19045，Node v24.15.0，基线 `94b5841` 加本轮健康/监控入口修复，已兼容更新 `proxy-addr` 2.0.8。API 54465、MCP 54466、Vite 54488；全为临时测试进程。
- 原始证据：`E:\CodexDev\api-nova\.tmp\env-01-q8pcpX\evidence.json`，同目录含迁移、API/MCP/UI 日志；JSON 记录入口与健康构建 SHA256。临时数据不入库。
- 执行结束：`ENV_01_EVIDENCE_COMPLETE`，exit 0；API/MCP/UI 三端口均不可达。此标记表示证据合同完成，不表示完整健康全绿。

## 实际结果

| 检查 | 结果 | 含义 |
| --- | --- | --- |
| `/api/health/ready`、`/api/health/live` | 200，ready/alive | 进程可响应；ready 实现仅检查 uptime 大于 5 秒 |
| MCP 未运行时 `/health` | 503；disk 与 mcp_server 均 down | 运行时地址实际拒绝连接，不视作健康 |
| 真实 MCP CLI Streamable 启动后 `/health` | 503；仅 disk down | memory_heap、memory_rss、mcp_server 均 up；MCP 自身 `/health` 为 200、纯文本 OK |
| 系统盘底层查询 | 成功 | `check-disk-space` 实际调用 Windows CIM，未遭执行策略阻断 |
| `Get-ExecutionPolicy -List` 独立只读查询 | 模块无法加载 | `Microsoft.PowerShell.Security` 加载失败；这是查询限制，不能推断现行策略或用它解释磁盘阈值 503 |
| 打包 UI `/monitoring` 与 Vite `/monitoring` | 均 200，返回 SPA app 容器 | 原历史深链接 404 已修复 |
| 两种入口的 `/api/health/ready` / 未知 `/api/*` | 200 JSON / 404 JSON | API 请求未被 SPA fallback 吞掉 |
| 两种入口的 `/socket.io/?EIO=4&transport=polling` | 均 200，合法 Engine.IO 握手 | `/monitoring` 是 Socket.IO namespace；传输仍走 `/socket.io` |

最终采样 C 盘：总量 **106,757,660,672 bytes**，空闲 **9,998,073,856 bytes**，使用率 **90.635%**。现有阈值需要空闲至少 **10,675,766,068 bytes**，当时差额 **677,692,212 bytes**（约 678 MB）。较早运行曾差 2.12 GB，宿主空闲空间会动态变化，复核时应重新计算。本任务未清理用户磁盘，也未改变健康阈值或 PowerShell 策略。

## 修复与验证

1. 健康控制器原先捕获 MCP `pingCheck` 异常并正常返回 `{ status: 'down' }`；Terminus 将这个结果归入成功集合，其他指标正常时可能整体返回 200。现保留原 `HealthCheckError`，使依赖失联进入 503 与 error 集合。真实 Terminus 汇总器回归模拟内存/磁盘正常，验证 MCP 失联 503 和恢复后 200。
2. Vite 原 `/monitoring` 代理与 Vue 页面路径冲突；打包 API 的 SPA fallback 同时排除了该路径。移除这两处冲突，保留 `/api` 与 `/socket.io` 分流。无需修改 namespace 或 UI 页面逻辑。
3. `npm run build --workspace api-nova-api` 通过；`npm run test --workspace api-nova-api -- --runInBand src/modules/health/health.controller.spec.ts`：1 suite / 1 test 通过。上述真实 HTTP 入口与完整健康验收通过其证据合同。

## 外部或人工要求

- 若要本机完整 `/health` 返回 200：由设备所有者释放 C 盘空间，最终空闲须达到 10% 以上；按本次最终采样至少差 678 MB，建议再释放至少 1 GB 并留持续运行余量。完成后重跑上述命令并保留新的完整响应。
- 正式部署时设置实际的 `MCP_SERVER_HOST` / `MCP_SERVER_PORT` 并启动该依赖；闲置或地址错误会如实返回 down。此检查不是全部受管 MCP 实例的健康汇总。
- 不要求为本轮验收放宽系统执行策略。若目标部署另有脚本执行需求，管理员另行确认政策与 PowerShell 模块可用性。
- 真实浏览器登录、注册→发布→消费→运维全流程，以及目标环境 TLS/权限/告警/恢复签收仍由 OPS-01 与相关生产任务负责；本轮仅消除了监控页 HTTP 入口阻断。
