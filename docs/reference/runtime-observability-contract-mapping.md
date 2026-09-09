---
doc-version: 1.7.0
doc-status: active
doc-updated: 2026-09-09
---
# 可观测性共享契约与接入映射

> Document status: OBS-TP-01 completed contract and source mapping
> 用户已确认全新开发版本策略；只支持当前 v2 源记录，不导入旧格式或建立历史迁移链。

## 冻结的契约

- 源记录 schemaVersion=2，对外 API schemaVersion=1.0；未知源 schema 拒绝。
- gateway_request/mcp_protocol/mcp_tool/upstream_api 分开计数。
- started/progress/finished 使用相同 invocationId，不同 eventId 和递增 recordVersion。
- 进程 sourceSequence 是源内顺序；对外 sequence 只能由管理数据库提交分配。
- API Key/JWT 主体必须经过认证；来源 IP 不等同于身份。
- HTTP body、MCP 序列化 Payload 按 byteMeasurement/measurementStage 分组，不混加。
- 缓存命中不生成上游调用；重定向的请求次数与重试轮次分别统计。
- 没有观察到正文返回 null/原因，不用空正文或 0 代替。
- 缺少父节点保持未关联；迟到终态提升版本并更新同一调用。
- 新查询路径为 /api/v1/monitoring/observability，来自全局 api + v1 控制器前缀。
- Socket.IO namespace=/monitoring，现有服务未自定义 Engine.IO path；新契约使用 /socket.io 和 auth.token。
- 现有 PermissionsGuard 为 ANY-OF；新正文/来源等权限必须使用明确 AND 检查。

## 当前源码边界与后续负责人

| 源路径 | 当前事实/后续改造 | 任务包 |
| --- | --- | --- |
| parser/src/audit/runtime-call-audit.ts | v2 阶段、正文预算/队列与失败计数；标量字符串保真和嵌套脱敏已重新验收 | 04 DONE |
| parser/src/audit/runtime-upstream-attempt.ts | 单次物理请求、实际字节与结束观察、父子上下文、编码正文省略及业务故障隔离 | 04 DONE |
| parser/src/audit/runtime-http-agent.ts、transformer/index.ts | 实例级 Agent 逐跳观察，保留原 Axios 跳转/解压及异常；17 项物理上游专项通过 | 06 IN_PROGRESS |
| parser/src/audit/runtime-observability-contract.ts | v2 校验、规范化、scope/去重参考计数；已实现 | 01 |
| gateway-runtime/services/gateway-runtime.service.ts | 入口节点、内部请求 ID、缓存与拒绝、独立上游 operation/attempt 已接入 | 05 DONE |
| gateway-runtime/services/gateway-proxy-engine.service.ts | 使用共享单次适配器，独立观察上游结束与客户端发送；21 项 HTTP 专项通过 | 05 DONE |
| gateway-runtime/services/gateway-access-log.service.ts | 已移除 fallback 规范事实；旧 DB 写入/查询保留到全链路收敛 | 05 DONE、15 |
| api-nova-server/src/transportUtils/audit.ts | 协议/Tool 父子关系与 send Promise 终态；15 项模拟和真实 Streamable/SSE 已验证，真实 STDIO 待验收 | 06 IN_PROGRESS |
| api-nova-server/src/tools/mcp-http-audit.ts、httpServer.ts | HTTP 正文/计量、认证前拒绝、协议错误、取消与不完整正文；15 项实际 HTTP 专项通过 | 06 IN_PROGRESS |
| api-nova-server/src/tools/runtime-security.ts | 逐请求主体和工具权限；拒绝不能虚构成功身份 | 06 |
| security/guards/permissions.guard.ts | 旧 ANY-OF 不用于新观测接口；专用 call-observability-access.guard.ts 已完成 AND/资源范围及真实 JWT 验证 | 03 DONE |
| database/database-options.ts | 新存储实体与两方言初始基线已完成隔离初始化/零漂移验证；未操作业务库 | 02 DONE |
| websocket/websocket.gateway.ts | 现有 namespace 和实时广播；新敏感订阅必须鉴权并接持久事件 | 13 |

路径均指 packages 下对应包的 src；实际绝对工作区为 E:/CodexDev/api-nova。

## 验证证据

2026-09-08：npm.cmd run test --workspace api-nova-parser -- --runInBand runtime-observability-contract.test.ts，1 suite、23 tests 全部通过。覆盖工具/上游分层、缓存、工具错误、失败身份、正文缺失、迟到终态、非业务 origin、STDIO、重试/重定向、未知父节点、混合计量和非法 schema 拒绝。

2026-09-08：npm.cmd run type-check --workspace api-nova-parser，通过。

本包只是共享契约验证，不将未完成的采集器、数据库、API 或推送标为已实现。

## 后续基础代码证据

共享采集器新增阶段测试；此前运行 runtime-observability-contract.test.ts、runtime-call-phases.test.ts、runtime-security-audit.test.ts，3 suites / 44 tests PASS；parser build PASS。这些结果不替代 Gateway/MCP 接入或存储端到端验收。

存储基础于 2026-09-08 写入，详见[存储基础实现说明](./runtime-observability-storage-foundation.md)。本轮仅写入源码/初始化文件，没有运行新的测试、构建或数据库验证。

## TP-04 收口记录

2026-09-08：runtime-upstream-attempt.test.ts 新增 16 项单次上游请求与故障用例，四组 parser 测试合计 60 项 PASS；parser 和 API 构建均 PASS。TP-04 达到共享采集器退出条件，实际 Gateway/MCP/测试探测接入未完成。适配器通过 index.ts 导出，不自行实现业务重试或读取响应流。

Gateway 已切换为不同 spanKind 的显式父子事实：gateway-request-audit.ts 观察入口现有读写，不消费或重放请求；代理使用共享适配器；auditRecorded 互斥与旧 fallback 规范记录已移除。2026-09-09：TP-03 夹具修复后 56 项专项与 48 项存储/GC 回归共 104/104 PASS，API build PASS；权限/API 公共基础已验收，生产控制器仍未接入。

2026-09-09：Gateway 21 项新增 HTTP 专项和 104 项基础回归共 125/125 PASS，API build PASS，TP-05 按包级退出条件收口。实际 Nest 控制器/独立监听器矩阵、可信代理逐跳解析和旧 DB 日志收敛仍留在 TP-15，不能声称全链路完成。TP-06 进入接入分析，MCP 代码尚未切换。

2026-09-09 TP-06 首批：server/src/transportUtils/audit.ts 已按 send Promise 结束记录 Tool/独立协议终态；server/src/tools/httpServer.ts 传递 HTTP 协议父节点。15 项模拟专项与 140 项联合回归、Server/API 构建通过，真实 SDK 联调待执行；MCP 整包仍 IN_PROGRESS。

## TP-06 HTTP 与物理上游批次验收

2026-09-09：公共脱敏标量保真、跳转终态、压缩响应原始编码观察和 Axios 超时分类修复完成。parser 五组 86 项与 Node 六脚本 155 项全部通过，parser/Server/API 构建及真实 Streamable/SSE 烟测通过。原失败证据保存在执行台账第 18 节，修复与重新验收见第 19 节；TP-04 恢复 DONE，TP-06 整包仍 IN_PROGRESS。

来源适配现在区分 mcp_protocol/mcp_tool/upstream_api，HTTP 与上游分别观察原字节，SSE 原始帧与编码正文只记录省略元数据。入站协议与 Tool/逐跳上游父子关系已有当前版本验证，不把原来逻辑补写方式继续当作单次物理请求。实际 STDIO、内部来源、自动汇集与查询/推送接入仍待后续包，旧格式不导入。

## 真实 STDIO 首轮接入证据（历史快照）

2026-09-09：新增 server/scripts/test-mcp-stdio-observability.cjs，通过公开服务器创建/STDIO 启动函数在实际子进程管道验证生产代码。7 项通过，慢读用例因 Windows 同步 stdout 与夹具 IPC 快照互相等待而失败，尚未修正。Server build PASS，联合回归 162/163 PASS；不能用已有模拟传输通过记录替代该失败场景。

脚本通过独立 IPC 控制夹具快照与主动关闭，不是生产状态推送接口。stdin EOF、stdout 错误/断管及完整平台矩阵仍待 TP-06/16 验收；TP-06 保持 IN_PROGRESS。

## STDIO 慢读修复后的有效证据

2026-09-09：在父进程暂停读取期间直接观察持久日志，恢复读取后再要求子进程 flush/health 快照，已修正 Windows 同步 stdout 导致的夹具等待错误。真实 STDIO 8/8、联合回归 163/163 与真实 Streamable/SSE 烟测通过，原不得提前成功和最终唯一终态断言均保留。

生产传输代码未改，本轮未重复构建；发送前 flush 是测试基线，不是新增生产能力。stdin EOF、stdout 错误/断管和完整平台矩阵仍待验收，TP-06 仍 IN_PROGRESS。

## TP-08 单文件采集映射（2026-09-09）

packages/api-nova-api/src/modules/call-observability/call-observability.collector.ts 消费 calls-v2 专用 JSONL，经唯一 CallObservabilityStore.ingest/rejectRecord 事务写入；调用/事件、检查点和尾边界指纹同事务。旧日志与 callers 文件不导入。测试脚本 test-call-observability-collector.cjs 新增 14 项通过；连同存储/GC/权限基础 118 项及 API 构建通过。目录调度、身份归并和公开 API 未在此节点宣告完成。
