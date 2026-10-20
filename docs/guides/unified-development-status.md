---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-10-20
---
# 统一开发状态

本页为2026-10-20起的唯一调度台账。[阶段计划](./unified-development-plan.md) / [工作包合同](./unified-work-packages.md)。
迁移基线 `2f49534`，原150条限定DONE留在BASE-150，不改写历史验收。用户已授权本计划开发；生产目标签收与真实数据删除不是本批操作。

| 工作包 | 状态 | 当前证据/下一出口 |
| --- | --- | --- |
| NP-00 | DONE | 209条映射、父包摘要与CAS范围复核；见本轮审计 |
| NP-01 | IN_PROGRESS | PG16/Node24已验；WSL只确认Ubuntu注册，Linux执行、目标部署与性能阈值待落实 |
| NP-02 | IN_PROGRESS | 兼容整改后全量98、生产18个包条目（0 critical/2 high/16 moderate）；剩余工具/生态升级及交付图待处置 |
| NP-10 | DONE | 启动互斥、可信Snapshot、旧Registry/watch/admin隔离和Gateway闭锁；50套724项、PG61+4组通过；仍默认off |
| NP-11 | DONE | post-route新proof与成对facade接线；Gateway51套736项、PG68+4组通过；无自动续proof/默认启用 |
| NP-12 | READY | NP-11完成；推进普通reload与撤销/收窄/到期在途矩阵及明确重装生命周期 |
| NP-13 | WAIT_DEP | 等NP-12 |
| NP-20 | DONE | 生命周期32项、通道/准备47项通过；真实Nest关停、30秒超时与5秒强杀出口完成，默认off |
| NP-21 | READY | NP-20完成；推进真实child→受控上游继承/覆盖/None及零发送边界 |
| NP-22 | WAIT_DEP | 等NP-21 |
| NP-30 | IN_PROGRESS | Unsecured MCP只读preview/事务发布与部分失败禁止部署，19套268项通过；生产proof authority与完整异步激活仍缺 |
| NP-31 | IN_PROGRESS | 默认off宿主authority/请求绑定接线14套272项通过；实际会话适配器、管理入口、G2/异步激活与PG仍缺 |
| NP-32 | WAIT_DEP | 等NP-21/22 |
| NP-33 | WAIT_DEP | 等NP-30/31/32 |
| NP-40 | READY | NP-00完成；只对隔离合成数据验证删除，生产开关默认关闭 |
| NP-41 | READY | 投递/receipt/审计留存治理 |
| NP-42 | READY | staging扫描与导入恢复 |
| NP-43 | NEED_ENV | Windows历史PG证据保留；Linux与长期压力待NP-01确认 |
| NP-44 | READY | 长连接、慢客户端与恢复验收 |
| NP-45 | READY | 统一查询及旧入口收敛 |
| NP-46 | READY | 变更操作者审计 |
| NP-47 | READY | MCP传输终态与正文矩阵 |
| NP-50 | WAIT_DEP | 环境可提前准备，最终执行依赖功能 |
| NP-51 | WAIT_DEP | 目标上游/浏览器/双平台及功能前置待齐备 |
| NP-52 | WAIT_DEP | 等治理能力和可复现承载基线 |
| NP-53 | WAIT_DEP | 依赖审计及最终候选联合门禁 |
| NP-60 | WAIT_DEP | 等候选验收与明确目标环境 |
| NP-70 | DEFERRED | 邮件为独立后续，不阻塞当前主线 |
| NP-71 | WAIT_DEP | 等真实产品流程稳定 |
| NP-72 | READY | 随交付验证 |
| NP-73 | DEFERRED | 未恢复OAuth/额外令牌/QoS范围 |

## 本批子任务状态

| 子任务 | 状态 | 证据与剩余出口 |
| --- | --- | --- |
| NP-02.1 | DONE | 兼容补丁、固定副本收敛、真实SDK加载与消费版本检查通过；当前生产0 critical，残余漏洞仍跟进 |
| NP-02.2 | DONE | 依赖6项、上传10项、SDK122项及API/Parser全量通过；四工作区构建通过 |
| NP-02.3 | READY | 优先评估Inspector与braces/chokidar，再处理兼容候选及Nest等升级；离线交付安装图待核 |
| NP-20.1 | DONE | 真实Nest关停、排队/在途恢复、慢HTTP健康检查取消及资源清理通过 |
| NP-20.2 | DONE | 真实30秒超时+5秒强杀及显式停止覆盖，生命周期32项通过、自然退出 |
| NP-31.1 | DONE | 真实宿主challenge/proof/请求绑定装配35项+既有237项通过；默认关闭 |
| NP-31.2 | WAIT_DEP | 等NP-31.1/NP-30，完整受保护发布及PG并发验收不提前关闭 |

## 执行记录

- 2026-10-20：用户批准计划并要求统一原任务体系。创建阶段计划、新工作包、唯一状态台账及自动映射校验；旧台账转迁移快照。尚未将文档交付声明为功能完成。
- 2026-10-20：NP-00与NP-10完成限定出口。新增13项bootstrap测试，Gateway完整50套724项通过；隔离PG最终61 warm+4 cold组通过并停止/清理。Node22文件元数据不一致及OpenSSL初次失败记录保留；最终使用Node24.19.0及显式OpenSSL配置。构建、测试、范围决定见[本轮审计](../audits/2026-10-20-unified-planning-np10.md)。
- 2026-10-20后续批次：用户要求并行推进并明确授权向registry.npmjs.org发送依赖信息。NP-11/20/30并行开发，NP-02全量/生产在线审计均返回完整报告；命令退出1表示发现漏洞。报告包计数不等于实际可利用漏洞数，未自动升级依赖。
- 本批[并行开发验收](../audits/2026-10-20-parallel-runtime-delivery.md)记录各包结果；[在线依赖分诊](../audits/2026-10-20-dependency-audit-triage.md)区分真实入口、条件性风险和待验证修复。NP-30只完成限定切片，不提升完整包状态。
- 最终整合：API 137套1585项全绿、最终构建退出0；MCP生命周期24项及通道/准备47项通过。修复真实重启后健康检查未恢复、产品首次预检期间停止失效，以及旧入口调用形态回归；首轮失败与复验分别保留。没有提交、推送、自动升级依赖或生产启用。
- 本次优先批：兼容依赖整改、NP-20收口、NP-31宿主授权并行完成限定出口；最终API140套1630项、Parser48套1193项、SDK122项通过，四工作区构建通过。NP-20转DONE并解锁NP-21，NP-02/31保留进行中。新增7个执行子任务，不改变209条原任务归属。详见[整改与接线验收](../audits/2026-10-20-security-lifecycle-authority-batch.md)；依赖安装失败与缺模块首轮证据保留。

## 下一批并行入口

- NP-02.3：评估Inspector、braces/chokidar和剩余兼容候选；Nest/uuid/图表生态主版本单列迁移，核对独立安装及离线包实际依赖。
- NP-12：在已完成NP-11上补普通reload在途快照、撤销/收窄/到期中止及关停资源矩阵。
- NP-21：从已完成生命周期进入真实产品child单跳执行矩阵；NP-22撤销/更新仍依赖其完成。
- NP-30/31.2：补生产会话epoch/资源归属适配器、宿主管理入口和G2/异步激活；保留缺失authority和未验证发布拒绝。

## 每次更新要求

记录任务、改动范围、命令/退出码、证据路径与适用环境；失败与复验分别保留。`DONE`必须满足包内全部出口。`NEED_ENV`须列明缺什么，`NEED_APPROVAL`写明待授权的动作/目的地，`WAIT_DEP`引用新包。父包验收不能由新包数量或测试数推算。
