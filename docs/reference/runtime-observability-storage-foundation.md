---
doc-version: 1.18.0
doc-status: active
doc-updated: 2026-09-11
implementation-status: in-progress
---
# 可观测性存储基础实现说明

> 范围：OBS-TP-02 存储基础与针对性验证已完成；不代表运行时集成、对外 API、自动治理或全平台验收完成。
> 前提：全新开发版本只维护当前 v2 源格式和空库初始化结构，不导入旧日志，不自动清理现有数据库。

## 1. 已写入的代码

| 文件（相对 packages/api-nova-api） | 职责 |
| --- | --- |
| src/database/entities/runtime-call-observability.entity.ts | 20 个调用观测实体与命名索引 |
| src/database/entities/runtime-observability-event.entity.ts | 扩展已有事件表的 sequence、主体版本、分发租约和保留字段 |
| src/database/database.entities.ts | 注册新实体 |
| src/modules/call-observability/call-observability-storage.ts | 序号编码、规范哈希、受限本地事务通道 |
| src/modules/call-observability/call-observability-payload.store.ts | 正文对象发布、数据库归属、路径约束、有界读取/扫描与完整性检查 |
| src/modules/call-observability/call-observability-payload.coordinator.ts | 共享写租约、独占 GC 租约与 storage generation |
| src/modules/call-observability/call-observability-garbage.service.ts | 有界孤立/过期/临时文件回收、引用保护与进度记录，无定时器 |
| src/modules/call-observability/call-observability.store.ts | receipt、调用当前/版本投影、断点及事件的统一事务入口 |
| src/modules/call-observability/call-observability.module.ts | 导出存储服务，尚未接入根应用入口 |
| src/database/migrations/*-InitialSqliteSchema.ts / *-InitialPostgresSchema.ts | 维护当前空库结构，不新增历史升级链 |
| database/sqlite-schema.sql / postgres-schema.sql | 同步空库 SQL |

## 2. 结构分组

| 用途 | 表 |
| --- | --- |
| 当前调用与快照分页历史 | runtime_invocations、runtime_invocation_revisions |
| 正文引用与独立保留 | runtime_payload_objects |
| 主体、凭证、来源与观察关联 | runtime_callers、runtime_caller_credentials、runtime_access_sources、runtime_caller_observations |
| 增量导入与冲突隔离 | runtime_ingest_checkpoints、runtime_ingest_receipts、runtime_ingest_quarantine |
| 可更正聚合的基础表 | runtime_metric_buckets、runtime_caller_buckets、runtime_metric_contributions |
| 订阅/配置版本/投递及尝试 | runtime_event_subscriptions、runtime_subscription_revisions、runtime_event_deliveries、runtime_event_delivery_attempts |
| 管道状态/策略/幂等 | runtime_pipeline_state、runtime_observability_policies、runtime_observability_idempotency |
| 持久事件 | 复用 runtime_observability_events，不新增另一张同义事件表 |

调用者/凭证/来源/观察归并已由 TP-08 投影 hook 实现；聚合、订阅管理和后台投递仍仅有实体。公开 API 与根应用尚未接入，既有生命周期事件生产者统一接入在后续集成包完成。

## 3. 事务和序号

源 process/sourceSequence 与管理端 sequence 分开。管理端使用事务内计数器，PostgreSQL 取得计数器行锁后分配；回滚同时回滚计数器和事实写入，不使用提交前抢占的独立 SERIAL 序列冒充提交顺序。

内部序号为 20 位补零字符串，范围不超过 uint64；对外输出不补零的十进制字符串。所有调用版本更新都能推进水位，不是每个版本都生成对外消息，所以序号允许间隙。

一次导入在同一事务内处理 receipt、调用投影、版本历史、终态事件、投影 hook、断点和存储诊断。未提交前不调用 Webhook 或 Socket.IO；返回的事件 ID 只是供后续分发使用，不代表已经推送。

SQLite 使用 SQL.js，当前存储提供 DataSource 级的本地写通道；仍要求单管理写实例。与现有其他模块同时写 SQL.js 的事务交互必须在集成验收中覆盖，不能把局部通道当作已经完成的全系统并发保证。

## 4. 去重、版本与恢复

- receipt 唯一身份是 sourceInstanceId + eventId；相同身份不同内容进入冲突隔离，不覆盖证据。
- sourceRecordVersion 与投影 recordVersion 分开。恢复产生的 unknown 不抢占源版本，迟到真实终态可以更正同一 invocation。
- 开始/进度和完成更新同一调用，不增加第二次调用次数；已观察到的终态不允许被后续进度或不同终态覆盖。
- 身份、链路与服务器归属冲突被隔离；日志中的任意 IP 不会在此被转换成可信调用者。
- reconcile 入口要求期望版本与失联观察边界；实际失联检测仍由 TP-08 worker 提供。
- 推断 unknown 的 completedAt/durationMs 保持 null，reconciledAt 单独记录，不能虚构真实完成时间。
- 版本历史通过 validFromSequence <= snapshotSeq < validUntilSequence 支持后续快照查询；开放查询与游标仍在 TP-09。
- 断点使用预期旧偏移和文件身份，避免不同采集者互相越过尚未提交的记录；半行识别在采集 worker 完成。

## 5. 正文对象

正文数据不嵌入调用/版本/事件的 metadata JSON。对象名由数据库归属、storage generation、所属调用、侧别、采集元数据和存储内容摘要生成，不跨调用或 generation 共享。空正文、省略、未采集、不完整与过期仍使用不同状态。

对象存放在 API_NOVA_OBSERVABILITY_DATA_DIR/payloads；未设置时位于 auditDirectory()/observability/payloads。只接受内部 64 位十六进制 ID 和固定分片路径，拒绝越界、符号链接或非普通文件；不向外返回磁盘路径，不挂载静态目录。目录/文件创建权限在支持的平台分别为 0700/0600，Windows 仍需部署 ACL 限制。

新对象先写临时文件并 fsync，再用不覆盖已有文件的原子发布方式建立最终名称。数据库提交前完成对象准备，数据库失败时可能留下孤立对象。存储异常降级为明确 omitted/storage_error，保留元数据，不冒充完整正文。

存储文本/Base64 可能大于原始 body，因此写入上限为共享采集上限的两倍，最高 128 MiB；读取硬上限同为 128 MiB。原始正文采集默认 16 MiB、最高 64 MiB 的契约不变。capturedDigest 表示采集边界摘要，实体 digest 检查实际已脱敏存储字节，两者不混用。

已提供协调后的有界 GC 服务，移除无协调的单对象删除入口。写入持有租约直到最终事务检查；GC 只在没有有效写入租约时运行，每次获得 GC 租约递增 generation，避免失效 GC 操作与新写入复用同一路径。尚未启用后台定时调度，细节见第 10 节。

## 6. 当前保留默认值

| 内容 | 存储基础当前默认 |
| --- | --- |
| 调用与版本 | 30 天 |
| 正文对象 | 7 天 |
| 对外事件 | 14 天 |
| 导入 receipt | 32 天，覆盖 30 天调用与 48 小时源暂存窗口 |
| 隔离记录 | 30 天 |

这些字段表达过期时刻，不等于后台清理已经运行。策略 API、动态配置、容量降级、投递和聚合保留由后续任务完成。

## 7. 初始化与交付边界

本次直接维护两个 InitialSchema 及其 SQL，不新增历史版本转换迁移。已经登记旧 InitialSchema 的开发数据库不会因修改源文件而自动变为新结构。未对现有业务库执行初始化、迁移或清理，也未重启现有应用。验证脚本只初始化并清理自己创建的隔离库，启动和停止独立测试 API 进程。

用户允许修复后，计数器初始化改为先构造带类型的实体再调用 insert.values，API build 已通过。本轮 48 项存储/GC 测试和 PostgreSQL 四进程调用仓储验证通过；此前 SQLite/PostgreSQL 隔离烟测均为 63 表、零结构漂移，并通过通用持久化/回滚和测试 API 启动。按存储包退出条件 TP-02=DONE；全系统 SQL.js 并发集成与 Linux 完整矩阵仍分别在 TP-15/16 未完成，不外推验收范围。

参见[唯一执行台账](../guides/runtime-observability-development-execution-status.md)和[对外 API 契约](./runtime-observability-api-endpoints.md)。

## 8. 已补充的测试脚本

packages/api-nova-api/scripts/test-call-observability.cjs 包含 32 项针对性用例，覆盖事务回滚、去重/冲突、断点冲突、unknown 更正、正文故障/过期/完整性、路径与符号链接约束、本地并发、快照版本及序号边界。测试只使用 SQL.js 内存库及 workspace/tmp/observability-storage-tests 下本次创建的目录。

已执行 node --test packages/api-nova-api/scripts/test-call-observability.cjs：32 tests PASS，0 fail，0 skipped。实际运行平台为 Windows，存储用例使用 SQL.js 内存库。

## 9. 两方言初始化验证

| 实际命令 | 结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| node packages/api-nova-api/scripts/database-tool.cjs smoke sqlite | PASS；63 表；schemaDrift=0；持久化/回滚、测试 API 启动通过；清理退出码 0 |
| node packages/api-nova-api/scripts/database-tool.cjs smoke postgres | PASS；63 表；schemaDrift=0；持久化/回滚、测试 API 启动通过；清理退出码 0 |

PostgreSQL 烟测出现 client.query 并发调用弃用警告；尚未定位其来源，纳入后续集成排查，不据此改变本次成功结论，也不声称已经消除该警告。这里的 PostgreSQL 烟测不是调用仓储的多进程序号验证。

隔离测试成功不自动开放任何新 Endpoint；新存储模块尚未接入根应用、collector 或分发链路。任务状态继续以执行台账为准。

## 10. 正文归属与有界回收

### 10.1 归属和租约

不增加数据库表。runtime_pipeline_state 使用以下内部记录：call-observability:payload-owner 保存数据库生成的 UUID；call-observability:payload-coordination 保存 generation、活动写入租约和 GC 租约；call-observability:payload-gc-status 保存最近成功回收报告与下一分片。

正文根目录 .owner.json 通过临时文件和不覆盖发布绑定该 UUID。其他数据库的目录、已有内容但缺少归属清单的目录均拒绝接管，不自动迁移或清空；部署切换必须明确使用新的隔离正文目录或另行批准的数据处理方案。

写入租约默认 60 秒，每 20 秒续租，最多 128 个活动写入者。正文准备发生在主投影事务之外，主事务首先检查租约和 generation；失效写入不能提交调用、receipt、checkpoint 或事件。操作退出时释放租约，数据库故障时依靠到期恢复。

GC 租约独占、默认 15 秒；每次取得租约递增 generation，每次删除前在数据库事务中重新确认并延长租约。新的正文 ID 包含 generation，因此即使旧文件操作晚于租约失效返回，也不会覆盖新一代合法写入路径。GC 占用时新写入显式失败，后续 collector 必须保留来源和断点并重试，不能吞掉忙碌错误后跳过记录。

### 10.2 扫描和删除规则

CallObservabilityGarbageService.collect 默认每轮最多扫描 128 个目录项、选取 32 个候选，孤立宽限期 24 小时；扫描上限可设为 1~1000，删除上限不得超过扫描上限，宽限期为 60 秒~7 天。遍历固定 256 个分片，目录迭代器在进程内续扫，成功报告持久化下一分片；重启或接管可能重复扫描未完成分片。

只考虑足够旧且名称严格匹配的普通正文或临时文件。拒绝越界/符号链接，保留 .owner.json、任意未知文件和较新文件。删除前再次核对大小、修改时间和 inode，候选变化则跳过。

有未过期正文元数据的文件受保护；过期对象删除后，元数据改为 expired、fileKey=null、storedBytes=0，调用和版本审计不删除。缺少正文元数据时仍查询当前调用和历史版本引用，存在引用则保留文件并计入 danglingReferences，不把结构异常误判为可删孤立对象。

报告包含 status、reason、scanned、deleted、missing、changed、protected、danglingReferences、nextShard、hasMore 和 generation。写入/其他 GC 占用返回 busy；失去租约直接失败，不伪报本轮成功。报告是内部原语，不是已实现的健康 HTTP API 或实时事件。

### 10.3 验证记录与边界

| 命令 | 本轮实际结果 |
| --- | --- |
| npm.cmd run build --workspace api-nova-api | PASS |
| node --test packages/api-nova-api/scripts/test-call-observability.cjs packages/api-nova-api/scripts/test-call-observability-gc.cjs | 48 tests PASS；0 fail；0 skipped；Windows / SQL.js |
| node packages/api-nova-api/scripts/test-call-observability-postgres.cjs | PASS；4 进程，20 个并发批次调用、21 个调用总计；schemaDrift=0；清理退出码 0 |

新增 16 项 GC 用例覆盖引用保护、过期审计保留、孤立与临时文件、写入和回收租约过期、主事务拒绝失效写入、generation 路径隔离、文件变化、归属冲突及有界续扫。PostgreSQL 场景在真正独立的 Node 进程和连接中验证提交可见性/顺序、回滚序号、并发调用事件和写入期间拒绝 GC，随后验证孤立回收。

PostgreSQL 父进程仍有 client.query 弃用警告；子进程警告计数 0 不代表整次运行无警告。测试脚本仅创建和清理 api_nova_obs_verify_进程号_时间戳 数据库及对应 workspace/tmp 目录，不处理业务库。GC 没有自动定时器；TP-14 完成治理闭环，TP-15 完成跨模块事务集成，TP-16 完成 Linux/完整平台矩阵和负载验证。

## 11. TP-08 首节点扩展（2026-09-09）

不改数据库结构。IngestCheckpoint 可携带 boundaryHash，与现有 receipt/调用/事件/检查点一起提交到 runtime_pipeline_state；文件内已观察序号跳跃更新 sourceSequenceGaps，重放不回退 lastSequence。IngestContext.suppressEvent 保留初始历史事件，但将 dispatchState 设为 suppressed、不返回待分发引用；普通写入保持 pending。

新增单文件 CallObservabilityCollector 导出和 14 项专项。数据集起点与早期管道状态已持久化，但模块尚未接入根应用，目录自动调度、调用者归并与公开 API 仍未完成。API build PASS；collector/storage/GC/API-foundation 合计 118/118 PASS。测试只使用隔离 Windows/SQL.js 和本轮自建临时目录，无业务库操作。

### 11.1 身份投影与 worker

新增调用者归并 hook 与显式启用的目录/恢复 worker，不新增数据库结构。来源 HMAC、overflow 降级、关联凭证和观察均随调用事务提交；重放不会创建第二个主体或重复降级计数。恢复接口增加 suppressEvent，用于抑制初始历史 unknown 的分发，真实当前终态保持正常事件序列。API build 与新增 15 项/联合 133 项通过；持久进程重启和关闭源残片确认继续下一节点。

### 11.2 持久 SQL.js/独立进程恢复

新增 3 项独立 Node 进程重开同一隔离 SQL.js 文件用例，验证字节断点、正文、数据集边界、调用与事件幂等、强制终止采集进程后的 unknown/迟到终态修正、改名与同名新文件。联合 136/136 PASS。强杀发生在显式保存数据库文件后，不声称机器断电或半写数据库文件恢复通过；生产者退出/关闭源残片仍待对接。不改实体、业务库或初始化基线。

### 11.3 源退出/封存与 TP-08 完成

不增加表。runtime_pipeline_state 的 source-exit 前缀行保存 UUID 绑定退出证明，source-seal 前缀行保存文件最终身份/大小/尾摘要；boundary 行增加单来源绑定或 mixedSources。封存先于可能失败的残片入库，断点仍只随成功 quarantine 事务推进，重试不重复消费。

SOURCE_CLOSED_PARTIAL_LINE 记录摘要及安全原因，同事务增加关闭残片数量/字节；退出恢复校验源证明与 invocation.sourceInstanceId 匹配，保留 completedAt/durationMs=null。新增 13 项与跨模块 208 项、parser 86 项、三包构建及真实烟测全部通过。TP-08 包级 DONE，公开 API/根应用仍未启用；这些证据行的治理留给 TP-14，不声称后台清理已运行。

## 12. 查询只读快照基础（2026-09-09）

新增 CallObservabilityStore.readSnapshot(callback)，返回 manager、读取时刻与十进制 snapshotSeq。使用 DataSource 共享串行通道保护 SQLite/SQL.js 事务，隔离级别 SERIALIZABLE；PostgreSQL 分支 REPEATABLE READ。只查询现存提交计数器，空数据集返回 0，不初始化流水线行、更新 updatedAt、生成事件或分配新序号。读回调仅用于数据库读取，不能进行网络或正文文件 I/O。

调用列表读取 runtime_invocation_revisions 的可见区间，明细读取 runtime_invocations 当前行；两者先施加资产和元数据保留过滤。结果集最早 expiresAt 约束游标固定截止，正文对象只批量查询安全元数据并根据自身 TTL 返回状态，不打开私有文件。无新表、列或迁移，无业务数据库处理。

API build、22 项实际查询 HTTP/Swagger 和联合 230/230 回归通过，包括空库读取不写流水线行、晚到更新的旧快照与最新明细、保留期失效。初次失败是过期建数被已有导入保留策略拒绝，用户批准后仅修正隔离夹具，生产保留逻辑不变。PostgreSQL 查询分支、提前元数据清理/策略变更导致的快照失效，以及完整性能矩阵仍待后续验证和治理。

### 12.1 正文读取与既有管理审计事务

新正文接口复用私有 PayloadStore.read 的完整性/路径/单对象读取边界，不增加表或对外文件能力。当前引用同时按 payloadId/invocationId/side 匹配；保留期在读前、读后和审计后重检，调用快照不延长正文 TTL。

AuditService.log(data, manager?) 可加入调用观测共享事务通道，管理审计写 audit_logs 而不分配调用序号。已有独立调用仍写原仓储。AuditLog/User 真外键及按 ID 读取已在隔离 SQL.js 验证；通用审计列表的 timestamp 字段仍需下一节点对齐 createdAt，不运行历史清理方法。审计失败回滚事务并返回 503，不对外泄露已在内存中准备的正文。

API 构建、19 项正文新专项和联合 249 项全部通过，前次 22 项查询已随受控链接变化回归。服务并发准入 4 路，不承诺治理/数据库其他模块或 HTTP 响应内存已整体协调；这些仍由 TP-14/15/16 验收。

### 12.2 管理审计列表读取对齐

AuditService.findLogs 现使用实体 createdAt 与 ORM Date 比较操作符、createdAt/id 降序和枚举/JSON 文本搜索。真实读取审计写入后通过列表、按日期与关键词查询的四项回归通过；正文/审计脚本 23 项，联合 253/253、API 构建 PASS。不修改数据库结构、权限、历史清理方法，也没有业务数据库操作；PostgreSQL 实际查询和全管理模块集成仍待验收。

### 12.3 trace 的有界只读图查询

无表、列、迁移或业务库操作。trace 查询复用 revision 可见区间与快照序号，先过滤资产、元数据 TTL、traceId/origin，再按 startedAt/invocationId 升序最多读取 201 行，超过 200 返回明确错误。没有读取正文或分配事件序号；晚到真实终态只呈现同一调用最新可见修订，不重复节点。

图关系裁剪/循环诊断完全在响应中执行，不纠正或伪造原始父子证据。规模测试通过独立 SQL.js 投影复制形成 200/201 边界，非生产采集或性能验收。API 构建、新增 16 项和联合 269/269 通过，实际 PostgreSQL trace 分支、Linux、应用启用仍未运行。

### 12.4 访客查询使用已有修订与注册表

无结构、迁移或业务库变更。调用者查询通过 revision 与 runtime_callers 按 callerId 内联，来源查询与 runtime_access_sources 按 sourceId 和同资产内联，所有筛选值参数化。源 authState 使用可信投影的注册值，callerId 关联还检查 canonical 可信认证；不查询正文文件或全局 credential 关联表。

快照内最多读取 5001 条符合授权/保留/外部调用窗口条件的修订，以判定 5000 上限；局部分组输出范围内观察时间与分计量口径总量。源/档案当前行仅提供不影响调用分页的注册属性和受控显示字段，不冒充额外历史修订。调用计数器和水位保持只读；期限/策略提前清理的游标失效仍需治理闭环。

API 构建与既有 269 项通过，新专项 23/24，匿名身份夹具错误待修正；未运行新 293 项联合或真实 PostgreSQL 查询。规模边界采用隔离 SQL.js 合成修订，不作为业务负载或生产采集证据，三接口仅 IMPLEMENTED。

### 12.5 访客查询重新验收

仅修正获批的匿名测试夹具，24 项专项与联合 293 项通过；无生产身份、存储、查询或保留变更。API 构建使用本节点原已通过结果，三条访客接口 VERIFIED；业务库、PostgreSQL 查询分支、Linux、部署和后台治理仍未操作。

### 12.6 档案版本与管理审计事务

无需新表或列。runtime_callers.version 转为只在真实档案编辑时递增，观察 hook 保留已有版本值；达到整数上限时拒绝继续编辑，但不能影响新的调用采集。完整资源授权同时检查 runtime_caller_observations 的已登记资产与保留 current invocations，不因隐藏记录过期就授予共享档案编辑权。

PATCH 通过现有 Store 管理事务和 AuditService.log(manager) 原子提交档案/审计，既不改写调用修订，也不分配新的调用序号或假造调用事件。审计故障与并发 ETag 冲突通过独立 SQL.js 实测。API 构建、22 新专项和 315 联合回归通过；另发现详情 HTTP 条件请求令牌范围错误，待许可修正，不因存储事务验证成功宣称整个 Endpoint 已验收或部署。

### 12.7 档案令牌边界修正通过

仅分离 HTTP 响应校验与档案令牌，无数据库结构、事务、身份或保留变更。GET/PATCH 使用 X-Profile-ETag 与 JSON profileEtag；5 项实际条件请求、27 项标签专项及 320 项联合通过，API 构建通过。TP-09 按查询/审计包内范围完成，无业务库操作或部署；全局事务集成和实际 PostgreSQL 查询仍需后续验收。

### 12.8 能力查询只读边界

能力接口复用 Store.readSnapshot，显式异步回调符合既有 Promise 类型约束；不改变 Store 签名、隔离级别、计数器/事件协议或初始化结构。空库水位字符串 0 且流水线表仍无记录；已有数据只读取现存提交水位，不扫描来源或打开私有正文。默认调用 30 天/正文 7 天仅为存储默认时长，非有效历史覆盖或实时保留策略保证。

无新表、迁移、业务库操作或根应用启用。获批修正初次回调类型错误后，14 项 HTTP/SQL.js/Swagger 专项和 334 项联合通过，API 构建通过；实际 PostgreSQL 查询、全系统事务集成、Linux 与负载仍按后续包验收。

### 12.9 统计内核不改变持久化

新增统计组件不执行数据库或文件 I/O，不改变实体、初始化结构、聚合桶/贡献表、提交序号、事件或业务根模块。输入数据库 revision 明确区别于源 recordVersion，调用方必须预先裁剪权限、TTL 和快照；此契约留给后续汇总仓储实现。

源 finished 必须具有 completedAt 的规则保持不变。专项夹具从合法 started 源记录构造数据库 reconciled/unknown 空完成时间投影，而非绕过生产源校验。内核 API 构建、24 项专项和 358 项联合通过；没有额外数据库、清理、迁移或部署操作。

### 12.10 汇总只读仓储

汇总使用现有 runtime_invocation_revisions 和同资产 runtime_access_sources 左关联，以数据库 recordVersion 作为计算输入。资产/TTL/时间/scope/快照均在 limit 前筛选，JSON 文本表达式只使用固定字段名和绑定值。当前只实际运行 Windows/SQL.js，不据此宣称 PostgreSQL 分支通过。

不读正文、不改调用/事件/计数器、不写 buckets/contributions，不变更初始化结构或根应用。20 项汇总、14 项能力、联合 378 项与 API 构建通过；真实 Store.reconcile 及晚到终态仅计一次最新数据库修订，超限和异常安全失败，不伪造历史覆盖。

### 12.11 按需时间序列与分组的存储边界（2026-09-09）

本轮不变更数据库结构、业务保留策略或根模块启用状态。summary、time-series、groups 共用修订快照、当前有效版本、TTL 与资产交集 SQL，保留来源关联的同资产约束；在权限和筛选完成后应用 5000 条上限。

分桶及分组只在选中行上计算，不逐桶/组追加数据库查询，不读取 Payload 文件，也不写聚合桶、健康状态或事件。dataWatermark 是读取快照序号，不可视为桶的持久版本；bucketVersion=null 明确表达尚未持久化。

默认保留明细不保证长期历史趋势；empty/synthetic 桶不填补历史覆盖空洞。后续持久聚合仍须设计桶级幂等修订、迟到完成替换、统计保留策略及恢复重算，不能简单累加当前接口返回的 distinct 指标。

本轮 API build、26 项新增专项和 20 项汇总通过；能力回归 4 项断言待修正，联合回归未执行。没有新 PostgreSQL、Linux、性能或部署验收声明。

### 12.12 时间序列/分组验收及持久聚合接续（2026-09-11）

初轮能力测试错误仅涉及断言，经授权修正后专项 60/60、联合 404/404 PASS；无数据库结构或生产代码追加变更。下一节点 TP10-B01 先计算数据库修订影响的稳定桶集合；B02 再接入贡献引用、事务条件和可恢复队列，B03 验收持久重算及覆盖。不会把纯规划结果、源端生命周期版本或读取 watermark 当作持久 bucketVersion。

### 12.13 TP10-B01 规划输入与 B02 持久化约束（2026-09-11）

B01 仅新增无 I/O 的 planBucketRevision。输入必须来自数据库规范化修订，使用数据库 recordVersion，而非源端 schemaVersion、sourceSequence 或生命周期 recordVersion。版本输出为十进制字符串，保留 uint64 精度；同版本无操作依赖存储层的不可变修订保证，不能用来绕过摄取内容冲突检查。

内部桶键 v1 包含版本、可空资产、origin、scope、timeBasis、interval、UTC 起点。每个调用最多进入 16 个桶，旧/新修订并集最多 32 个。较新修订一律使共有桶失效；移出旧时间窗、资产或 scope 的桶也必须重算，不能只处理新归属。

B01 不保存计数，不触发重算任务或事件，不改变当前明细保留期。它不能替代以下 B02/B03 必须实现的存储保证：

1. 同一写事务重新读取已投影版本，检查 expectedRecordVersion，原子提交贡献引用与待重算标记；并发冲突重读规划，禁止使用过期计划覆盖较新状态。
2. 崩溃或队列失败不留下已推进版本但未登记的失效桶；事务失败完整回滚，重启后可恢复。
3. 对移出和进入的所有桶保留可追溯失效依据；桶失效版本和已完成重算版本分离，不以 dirty 状态冒充新快照可读。
4. 基于当前有效贡献重算 distinct、直方图及字节边界，不直接累加阶段、均值、分位数或跨桶去重人数。
5. 桶/贡献保留期、明细过期、历史回填及覆盖断点单独设计和验收，缺少历史证据时继续报告未知/不完整。
6. 主动报送仅消费已提交的持久事件，不对纯规划输出发送成功状态。

验收：API build PASS，桶规划 26 项及指标 24 项 PASS，20 脚本联合 430/430 PASS。本节点没有新增数据库、PostgreSQL/Linux、部署或持久事件验收声明。

### 12.14 存储基础与未完成流程的复核（2026-09-11）

已存在 RuntimeMetricBucketEntity、RuntimeCallerBucketEntity、RuntimeMetricContributionEntity、RuntimeEventSubscriptionEntity、RuntimeSubscriptionRevisionEntity、RuntimeEventDeliveryEntity、RuntimeEventDeliveryAttemptEntity、RuntimePipelineStateEntity 与 RuntimeObservabilityPolicyEntity 等基础定义。B02 是核对并接入这些实体及版本契约，不表示所有表需从零创建。

当前 Worker 将调用者投影传给 collector/reconcile；B01 纯规划未接入该写入链路。Store 的调用、修订、回执、检查点与调用事件原子提交已经实现，但 pending/suppressed 事件状态不等于分发 Worker 或投递器已完成。不能把这一基础验收扩大为长期聚合、Webhook 或新版实时订阅验收。

入库及数据库修订当前明确受 2147483647 版本上限保护；B01 的 uint64 表示能力不是数据库范围变更。规划输入必须遵守已接受修订和既有不可变身份，不能用通用测试中的资产/时间修正能力开放历史事实任意修改。

未完成项、依赖与验收条件见[任务完成情况复核与未完成清单](../guides/runtime-observability-completion-review.md)。本次无结构调整、数据清理、部署或新增运行验证。
