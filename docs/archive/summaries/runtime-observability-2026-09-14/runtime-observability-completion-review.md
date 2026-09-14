---
doc-version: 2.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 统一调用可观测性：远端基线整合完成情况

## 整合原则

以 origin/main 7a7fc44 已闭环的实现为基线。远端持久聚合、Store/采集、Outbox、订阅和投递 API、人工重投、签名发送及数据库结构予以保留，不因本地准备实现重复而重开远端已完成任务。

本地独有的根模块接入、总览/依赖/服务器状态/pipeline 查询、缓存三态、内部测试/探测/验证 origin 隔离与 MCP 发送边界修复叠加整合。本地同类聚合/投递内核和旧测试已由远端实现替代，历史提交 2b4c6c6 仍保留原代码。

## 当前任务包口径

DONE=10、IN_PROGRESS=2、BACKLOG=4。DONE 表示各包约定范围；不是全部产品、平台或部署完成。TP11/TP12 沿用远端闭环结论，整合回归单独记录，不把远端工作降为从零待做。

| 任务 | 状态 | 整合后的依据与剩余 |
| --- | --- | --- |
| TP01~05 | DONE | 沿用共享契约、存储、权限、采集与 Gateway 既有闭环 |
| TP06 | IN_PROGRESS | 保留本地 MCP 发送确认修复；完整传输/正文/平台矩阵及 Windows 大响应背压限制继续跟踪 |
| TP07 | DONE | 保留本地真实测试/探测/候选验证接入、origin 隔离和 telemetry 排除 |
| TP08~09 | DONE | 保留远端身份修复和原查询，根模块接入为本地增量 |
| TP10 | IN_PROGRESS | 采用远端 B01~B03 和桶/采集状态事件，保留本地四类查询及缓存；真实存活、整体长期治理/平台性能不由局部重算证明 |
| TP11 | DONE | 以远端规范事件、授权历史、持久 Outbox 及水位为主；本地调用快照桥接为可选增量 |
| TP12 | DONE | 以远端订阅/投递 HTTP、受控测试、重投、签名、重试与审计闭环为主，不保留双发送消费者 |
| TP13 | BACKLOG | 接续统一 Socket.IO、快照切换、补拉、撤权和慢消费者控制 |
| TP14 | BACKLOG | 接续配额、整体保留、策略 API、安全清理及恢复；pipeline/status 为已具备的准备能力 |
| TP15 | BACKLOG | 根接入已有；继续完整身份/拒绝审计、旧消费者收敛、所有链路与部署切换 |
| TP16 | BACKLOG | PostgreSQL/Linux、多进程、持续负载/容量、性能及对外交付验收 |

## 接口与数据协议

远端 API01、03~13、16~25 加本地 API02、14、15、26，编号并集为 26/28；API27/28 policies 尚未实现。两侧既有验证和合并后的验证分开记录，不能仅按编号相加声称已完成整合验收。部署 AVAILABLE=0。

唯一订阅格式为远端 enabled/paused/deleted、对象 destination、修订区间 [from,until)。唯一聚合写入为远端 Store 及 metrics.recompute 协议；唯一物化/发送消费者为远端 OutboxService 和 DeliveryWorker。实体和初始化结构不增加本地已撤销队列字段。

远端事件服务保留完整事件类型、固定水位、MAX_EVENT_SCAN=1000、游标完成和过期语义。在此基础上接入 origin 与经授权的 afterSequence，不将调用快照误当服务器或全管线快照。

本地持久缓存适配只处理新增七字段：旧桶证据不足时走远端原有明细降级，新桶使用原有持久路径。不伪造缓存零值、历史完整性或当前存活。

## 未完成清单与后续顺序

1. 完成本次远端核心与本地增量的联合回归，记录真实结果及任何差异，不恢复已移除的双消费者。
2. 接续 TP13 Socket.IO，以远端持久事件和水位为唯一来源，落实快照/实时边界、撤权、慢消费者与补拉上限。
3. TP10/14 并行推进真实存活证据、整体覆盖/保留/配额和策略 API，保留活跃投递所引用事件，不直接启用破坏性 GC。
4. TP06/16 推进 MCP 全矩阵、Windows 背压限制与 PostgreSQL/Linux/容量性能环境验收。
5. TP15 收敛旧消费者、服务身份及全链路审计，最后按授权部署。TP12 管理 API 和人工重投已由远端交付，不再重复排期实现。

## 已知 MCP 限制

Windows / Node v24.15.0、16 MiB Streamable 响应的原生 cork/uncork 恢复组合，原生 SDK 与审计版本均有 3 秒未完成复现。对照通过不是恢复成功；等待期间没有伪成功，断开后为 error/incomplete。该限制不归因于远端可观测性管理闭环，也不因整合而隐去。

## 验证和文档入口

本地整合前 API 105/105、远端各节点专项均为各自历史证据。本次整合已确认 Parser/Server build PASS、Parser 审计 103/103、MCP 四脚本 53/53；API 整合结果待本次后续回归记录。未执行生产迁移、真实外部接收端投递或推送远端。

- 接入配置：runtime-observability-integration.md
- 外部环境要求：runtime-observability-external-validation-handoff.md
- 差异和原始整合路线：runtime-observability-remaining-work-2026-09-14.md
- 逐次验证：runtime-observability-development-execution-status.md
## 2026-09-14：远端优先整合验收通过

采用 origin/main 7a7fc44 为主链路，保留远端 Store、采集 Worker、Outbox、订阅/投递管理与发送 Worker 原实现，实体及 SQLite/PostgreSQL 初始化结构与远端一致。仅在远端模块、事件和统计读取处追加本地独有查询/快照桥接/缓存兼容；不注册第二套聚合、Outbox 或发送消费者。

实际验证：Parser、Server、API build 均 PASS；Parser 审计 103/103；MCP 四脚本 53/53；API 全部可观测性脚本加 Gateway/内部依赖专项联合 548/548，0 fail/cancelled/skipped。最终日志 tmp/observability-remote-integration-final-2026-09-14.log。各专项与联合重叠，不重复累加。

首次 API 联合为 543/548。五项失败均定位为旧测试问题：一项能力断言仍期待 Webhook 未实现，而远端 read-only 正确为 restricted；三项重启计数把远端新增的桶/管线事件计作调用；一项事件过期夹具依赖批量插入后被回填改写的数组 ID，原版远端服务隔离运行也复现。修正只涉及测试：分别检查调用与辅助事件、按持久 sequence 定位待过期事件、保留 410 和全部安全约束。没有为通过测试改写远端生产内核。

当前接口为 API01~26 的限定契约已验证，API27/28 policies 未实现；AVAILABLE=0。TP11/TP12 延续远端 DONE，TP07 保留本地 DONE；总计 DONE=10、IN_PROGRESS=2、BACKLOG=4。后续为 TP13 Socket.IO、TP10/14 真实存活及治理/策略、TP06/16 平台矩阵和 TP15 身份审计/旧消费者收敛，不再重复开发远端订阅/投递闭环。

本次整合保留所有本地原始实现于提交历史，未执行生产迁移、未改环境秘密、未启用真实外部投递、未推送远端。MCP Windows 大响应有界对照仍保留，不将对照通过声明为恢复成功。