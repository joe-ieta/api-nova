---
doc-version: 1.7.0
doc-status: active
doc-updated: 2026-10-29
---
# 项目当前基线

当前产品定位和功能范围见[项目概览](../overview/PRODUCT.md)，结构和依赖见[总体设计](../architecture/OVERALL_DESIGN.md)。本页只维护版本/工程/验收基线，不重复展开旧Phase计划。

| 项目 | 当前基线 |
| --- | --- |
| 当前候选 | v1.7.6-rc.6，main源1fd5753，三平台预发布已完成；[发布审计](../archive/audits/2026-10-26-release-v1.7.6-rc.6.md) |
| 当前开发线 | 在main/97b560d后推进Node20兼容依赖整改，本机限定验收完成；[本轮进度](../guides/active-work-package-execution-status.md#dependency-migration-20261029)；用户要求暂不发布，不覆盖既有rc.6 |
| 产品包 | Parser共享内核、Server MCP运行时、API控制面/Gateway、UI |
| 工具链 | 根Node>=20.0.0/npm>=10不变；精确npm10.9.2原本要求20线>=20.5。最低运行验证为20.0.0，本机常规24.22.1；CI已接线20.5/24.15双Node双库，rc.6原三平台24.15记录不改 |
| 依赖维护 | Zod4.6.7、Hono2.1.5/SDK1.32.2；I18n9回移官方安全修复，file-type21.3.4有界ZIP兼容Node20；未伪称Vue11官方升级 |
| 默认端口 | 开发UI9000、API9001、独立MCP9022；离线UI由9001托管 |
| 持久化 | SQLite默认、PostgreSQL显式可选；73业务表/每方言8迁移、synchronize=false |
| MCP | stdio、streamable、sse；管理Socket.IO不是MCP传输 |
| 最近本机复验 | 四包构建、API192套/2065项、Parser1213项、UI119项、Server全链；Node20安全19/schema12/I18n24/产品适配37及实际UI构建和SQLite73表/8迁移/零漂移通过；[证据](../archive/audits/2026-10-29-node20-dependency-migrations.md) |
| 最近远端复验 | [双库CI40811446522](../archive/audits/2026-10-29-dual-database-ci.md)：a63d076两个作业success；各API2065项（SQL.js fixture）、UI95项、依赖16项，实际SQLite/PG均73表/8迁移、零漂移、持久化及live/初始化冒烟通过 |
| 依赖审计 | 本轮生产17→14节点：4 high、10 moderate、0 critical，剩余为保留原版本号的I18n/Nest回移及传播范围；Vue11官方升级、未来公告评估和目标签收仍归SEC-F4-02，未自动接受风险 |
| 任务口径 | 209项：204 DONE、2 IN_PROGRESS、1 WAIT_DEP、2 DEFERRED；245条依赖 |

Phase1注册/测试/治理与Phase2发布/运行资产主线保持关闭，现阶段仅收齐现有能力的验收/签收及有明确影响的缺陷。邮件受控投递、真实运行日志、前端分块/交付国际化已有对应限定成果，不再沿用旧基线的“邮件未实现/延期”与无限UI整理清单。

正式保留SEC-F4-02和OBS-16-04目标签收、OPS-01最终汇总，以及DEFER-01 OAuth2和DEFER-02额外令牌/跨协议QoS。人工反馈、原未验组合、SQLite未全量观察和目标环境边界见[open-items](../reference/open-items.md)。

原批准合同与任务依赖保留，归档不放宽退出标准。状态唯一入口为[统一台账](../guides/active-work-package-execution-status.md)，原任务出口见[合同表](../guides/active-work-package-breakdown.md)，历史取证见[归档索引](../archive/README.md)。发布唯一规范为[RELEASE_STANDARD](../../RELEASE_STANDARD.md)，顶层约束见[产品约束](PRODUCT_CONSTRAINTS.md)。

2026-10-26合并保留main独有9d27b51的宿主授权/网络接线、managedMcpMode受管进程和兼容依赖整改，同时保留oc_dev的executionMode生命周期、运行时/日志/数据库修复及最新文档。两种受管MCP配置键不混同，显式Gateway网络宿主冲突时关闭两条路径，不静默回退。原main的150-DONE迁移口径和NP计划保留为[历史记录](../archive/plans/main-2026-10-20/unified-development-status.md)，当前209状态不回退。
