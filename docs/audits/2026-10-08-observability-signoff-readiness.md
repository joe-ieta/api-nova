---
doc-version: 1.1.1
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 可观测部署签收准备与剩余条件

> 后续批处理、源完整性与SQL.js整改结果见[2026-10-08联合吞吐证据](2026-10-08-observability-throughput-closure.md)。本文保留上一阶段实测；当前整体状态仍未签收。

后续完整PG冷备恢复已7/7通过，见[备份恢复实测](./2026-10-08-observability-backup-restore.md)；双DB参考性能已经测量但未达标，并发现源记录缺口，见[性能与吞吐阻断](./2026-10-08-observability-performance.md)。下文“尚无完整runner”等为准备阶段历史调查，不能继续列为当前缺口。

本次完成签收范围核定、配置与恢复边界核对，以及真实投递 Worker 的本地 TLS 信任正反验证。**实际部署签收未执行，OBS-16-04 不标记 DONE。** 不增加历史任务叶子，不把已有组件测试重新累计为项目完成度。

## 依赖与可并行工作

OBS-16-04 原依赖 OBS-16-02、OBS-16-03、OBS-15-02、OBS-14-05D 均已在[执行台账](../guides/active-work-package-execution-status.md)限定完成；当前无需重做这些实现。可观测准备与 PROD-04C 二进制留存、ENV-01 健康检查、SEC-F4-02 安全签收准备可并行；最终应合并同一候选构建、目标主机和数据库证据，OPS-01 等待安全与可观测签收。

现有[OBS-16-03 环境车道](2026-09-28-obs-16-03-environment-lane.md)证明 Windows/Linux Alpine 与真实 PostgreSQL 的部分多进程和恢复场景；[OBS-15-02](2026-09-26-obs-15-full-chain.md)证明身份链各边。两者均不代替一条实际部署中从业务调用、采集、事件、投递到外部接收方的整体证据。

## 本轮实测

命令：`node scripts/verify-obs-16-04-tls-trust.cjs`，入口为[保留执行器](../../scripts/verify-obs-16-04-tls-trust.cjs)。前置为已经构建的 api-nova-api；签收前须从选定候选源码重新构建。执行器复用现有 OBS-16-03 的合成证书和 receiver fixture，加载实际构建中的投递 Worker，两个独立 Node 进程使用独立 SQL.js 数据库与随机回环端口，不执行原历史矩阵。

| 格 | 实测结果 |
| --- | --- |
| 未提供附加信任根 | PASS：证书校验失败，投递进入 `retry_wait`，错误类别 `tls`，接收端收到 0 次 HTTP 请求 |
| Node 启动前配置 `NODE_EXTRA_CA_CERTS` | PASS：HTTPS 接收端返回 202，投递 `succeeded`；验签通过，eventId/deliveryId 一致，attempt 记录 202 且无错误 |

结果：**2/2，`OBS_16_04_TLS_TRUST_OK`，exit 0**。环境为 Windows x64、Node v24.15.0。首次保留执行证据在 `.tmp/obs-16-04-tls-SsGRkl/`；根代理在最新API构建和proxy-addr补丁后独立复跑2/2通过，最终证据在 `.tmp/obs-16-04-tls-llRvgC/`，含 `absent.log`、`configured.log` 和 `manifest.json`。manifest 记录执行时 HEAD、执行器/fixture/源码 Worker/构建 Worker 的 SHA-256；完整发布应归档本次候选重新执行的 manifest 和日志。临时日志不是长期发布归档。

这修正历史记录中的一个前置判断：**无应用级 `ca` 参数不意味着不能部署受信任私有 CA。** 在本次 Node 进程启动时提供 `NODE_EXTRA_CA_CERTS=<PEM 文件绝对路径>`，保留的原生 HTTPS 代码即可验证信任链。未设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，未替换证书验证器，未改生产代码。实际部署仍须提供受控 CA、正确证书主机名、启动配置和接收端证据。本次未测试主机名不匹配、证书轮换或真实外网部署，不能据此签收它们。

本机只读环境核实：PostgreSQL 16 的 `psql`、`pg_dump`、`pg_restore` 可用；`pg_isready -h 127.0.0.1 -p 5432` 返回 accepting connections，但归属及安全凭据未确定，因此未登录或修改现有数据库。Docker CLI 存在，但 `dockerDesktopLinuxEngine` pipe 不存在，daemon 未运行；没有擅自启动桌面服务，也未因此要求更换现有部署方案。

## 当前真正待签收的批准条件

以[原批准 AC-01～20 和性能指标](../guides/runtime-observability-requirements.md)为预期结果。下表“待验”指最终候选的部署验收，不将历史局部通过改写为失败或重新待开发。

| 条件 | 可复用证据 | 本包仍需完成 |
| --- | --- | --- |
| AC-01～08：Gateway/MCP 访问、重试、错误、身份与正文 | Gateway/MCP 矩阵、EXT-01～05、身份与拒绝审计、现有正文测试 | 同一候选上串联真实调用与采集查询；复用 PROD-04C 完整二进制结果，记录脱敏/超限/正文状态 |
| AC-09/10/13：导入幂等、强杀终态、投递重启/暂停/重投 | OBS-16-02/03、outbox/delivery 租约和强杀恢复 | 目标部署的进程重启与真实接收方去重；保留 attempts、事件关联和丢失/未知边界 |
| AC-11/14/19：统计、实时恢复、心跳 | 指标、Socket.IO、状态/快照与心跳的各项已完成证据 | 指定多服务器/时间桶数据的可推导期望值，目标部署断线补拉及零流量与故障区分 |
| AC-12：Webhook 不确定结果 | 已有受控 HTTP/TLS失败矩阵；本轮补信任根成功 | 实际受控 HTTPS 接收方的普通事件投递、响应丢失与重复去重；仅 test-subscription 202 不算 |
| AC-15/16：降级、到期与保留 | 配额/GC/生命周期与各恢复原语，PROD-04C 并行 | 目标存储上的批准保留策略、容量边界、数据库不可用/恢复证据；正文备份保留规则与在线一致 |
| AC-17/18：权限与来源隔离 | 现有拒绝/审计、test/probe origin 证据 | 与 SEC-F4-02 同批复核实际账户和授权范围；真实 receiver 不混入业务统计 |
| AC-20：平台与数据库 | Windows/Linux Alpine、SQLite/PG 各项已有结果 | 对照目标平台复用适用结果；新增平台组合必须实测，不能把 Alpine 外推为所有 Linux |
| 性能 | 原批准目标已给出，不需重新发明门槛 | 按参考负载记录机器、数据库、持续时间、正文策略、p95 和资源曲线；本轮已完成双DB测量但未达标；源writer/入库/投影需整改，不能关闭性能出口 |
| 备份恢复、开关与回退 | 已有重启/恢复原语、旧路由退出与回退说明 | PG冷备到空库/新目录已实测，见新增恢复报告；生产备份方案、运行账户以及同一候选启停/回退仍待签收 |

批准参考负载为 4 核/8 GiB/本地 SSD、100 请求/秒、每次请求加响应不超过 8 KiB；持续时间和数据规模须随结果记录。目标为采集可见性 p95 ≤3 秒、健康接收端首次尝试 p95 ≤5 秒、固定基准采集额外 p95 ≤10 ms、指定容量的明细/常用聚合 p95 ≤2 秒。心跳默认 15 秒，45 秒无心跳标记 stale/unknown。高并发大正文和持续长流需单独报告，不能从短小样本外推。多主机远程采集是后续扩展，不作为本次必须提供的环境。

## 已核实的配置映射

以下仅核实代码读取关系，未改本机或目标环境配置。

| 配置 | 用途及签收注意事项 |
| --- | --- |
| `API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED`、`API_NOVA_OBSERVABILITY_AGGREGATION_ENABLED` | 默认关闭；实际部署须记录是否启用及相应采集/聚合状态 |
| `API_NOVA_OBSERVABILITY_OUTBOX_ENABLED`、`API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED` | 独立的默认关闭开关；只有精确字符串 `true` 启动对应自动 Worker，手动 runOnce 通过不证明其部署已启用 |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS` | 精确 URL host（含非默认端口），不填完整 URL/通配符 |
| `API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS`、`API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS` | 引用白名单及本机注入的 JSON 秘钥映射；receiver 通过独立安全渠道取得匹配秘密，报告只记引用 |
| `API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP`、`API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS` | 生产 HTTPS 不开启 HTTP 例外；私网部署需明确精确私有 IP 例外和域名白名单，禁止用关闭 TLS 校验替代 |
| `NODE_EXTRA_CA_CERTS` | 本轮证实的 Node 启动时 PEM 信任根方式；不是新增应用 API 字段，变更后须重启目标 Node 进程 |
| `API_NOVA_OBSERVABILITY_RETENTION_ENABLED` | 默认关闭，正文物理回收；不是事件/调用明细/管理审计的统一开关 |
| `API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_ENABLED`、`API_NOVA_OBSERVABILITY_LIFECYCLE_RETENTION_EVENTS_ENABLED` | 默认关闭；事件永久删除另有独立开关 |
| `API_NOVA_OBSERVABILITY_AUDIT_RETENTION_ENABLED`、`API_NOVA_OBSERVABILITY_AUDIT_RETENTION_RETENTION_DAYS` | 默认关闭，管理审计至少保留 30 天；不要将其覆盖范围外推到全产品审计 |
| `API_NOVA_OBSERVABILITY_HEARTBEAT_ENABLED` | 默认关闭；管理心跳证明管理进程/存储往返，不单独证明所有业务服务存活 |

配置依据为 API 的 `validation.schema.ts`、`call-observability-delivery.worker.ts`、`call-observability-outbox.service.ts`、各 retention worker 与 heartbeat worker。receiver 签名与重试合同见[外部验收交接](../guides/runtime-observability-external-validation-handoff.md)；其中早期剩余开发列表是历史基线，当前任务状态以总台账为准。

## 备份恢复准备边界

在 `scripts` 与 `packages/api-nova-api/scripts` 检索，现有条目主要为进程重启、重新打开、事务回滚恢复或发行目录回退；**未找到覆盖可观测数据库＋正文文件＋配置/秘密恢复的完整部署备份 runner**。不能把 SIGKILL 恢复通过说成备份恢复通过。这是尚待完成的运维交付工作，不是单纯等待某个密码。

可使用部署平台备份工具，需形成一套可重复步骤：暂停相关写入或使用经验证的一致性快照 → 同批备份数据库、正文目录、必要审计暂存与配置清单 → 秘密由安全后端单独恢复 → 在干净的隔离目标恢复 → 核对调用/事件/正文引用与散列、授权读取和过期状态、恢复后的投递去重 → 记录可恢复时间点和恢复耗时 → 执行原部署回退。PostgreSQL 原生 `pg_dump`/`pg_restore` 可用不等于已完成跨数据库与文件的一致性恢复；SQLite 也不能在任意写入中直接复制一个数据库文件来声明一致性。

初始保留规则已有批准值：调用元数据 30 天、正文 7 天、分钟聚合 30 天、小时/日聚合 180 天、事件 14 天、投递及本功能管理审计 30 天、已入库文件暂存 48 小时；身份/IP 在无有效明细引用前提下最后活动 180 天。部署应确认目录/容量与备份保留适配这些规则，任何差异记录为明确部署选择。

## 需要外部环境或人工提供的最小清单

用户已明确本轮暂用本机隔离环境，生产签收保留待办；下表为正式签收时的交付要求，不要求当前转入生产操作。完整冷备恢复已在隔离PG完成；性能测量已揭示本地吞吐与源完整性阻断，继续整改后复验，不应全部归因为外部环境缺失。

| 所需输入 | 明确交付内容 | 用途 |
| --- | --- | --- |
| 目标主机与可执行入口 | 主机/平台与版本、远程执行方式或负责执行的人、API/UI 地址、Node 版本、运行账户、单管理实例/同机多进程拓扑、持久目录、候选版本 | 共用 ENV-01/SEC-F4-02 的环境，不重复要求多套 |
| 隔离验收数据库 | SQLite 专用目录，或 PG host/port/database/用户名、服务器版本及允许建表/迁移/恢复的范围；密码通过部署 secret 注入或受控凭据文件交付，只给位置/引用，不贴聊天 | 新建隔离验收库，禁止占用或清理未知现存库 |
| HTTPS 接收端与信任 | 受控接收 URL、所有者/联系人、允许的测试时段、DNS/出口可达性、必要的私网 IP 例外；私有 CA 的 PEM 路径/分发方式及匹配主机名证书 | 真实签名接收、失败/重试演练；CA 文件可由负责人员放到目标主机 |
| 接收端验签与去重 | secretRef、双方安全注入方式、原始请求体验签及 event/delivery 去重规则、可导出的脱敏接收回执 | 不要求在聊天或仓库提供真实 secret |
| 存储/性能/恢复约束 | 可用容量、采用默认保留或明确差异；参考负载运行窗口、持续时间与数据规模；备份位置/权限/加密方案、RPO/RTO 目标或明确“先测量、暂不签 SLA” | 使性能与恢复有可审核的通过标准，不自行承诺未知 SLA |
| 试运行启停决定 | 可对隔离验收实例执行的开关变更、故障/重启/恢复窗口及最终继续运行或关闭选择；如果操作生产，指定批准人/窗口 | 区分本地准备与真实部署变更；不重复请求已有源码提交推送授权 |

这些输入到齐后，先固化候选并构建，复跑必要差异验证，再按上述矩阵执行实际环境验收。未得到实测的格保留“未执行/需环境”，不以本地 TLS 成功将整个 OBS-16-04 关闭。
