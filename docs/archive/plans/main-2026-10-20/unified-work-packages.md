---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-20
---
# 统一工作包与任务映射

状态唯一入口为[开发状态](unified-development-status.md)。本表为合同；依赖列仅表示新包前置，已完成旧任务由BASE-150提供。
`BASE-150`精确指原[冻结台账](active-work-package-execution-status.md)中状态DONE的150行；每行保留原ID、证据和限定边界，不作为150个待开发任务。其余59行必须在下表出现且仅出现一次。

| 工作包 | 阶段 | 优先级 | 依赖 | 旧子任务 | 交付及验收出口 |
| --- | --- | --- | --- | --- | --- |
| NP-00 | 0 | P0 | — | PROD-06 | 映射209行、父包摘要纠偏、原CAS范围审核；未证明属原范围的CAS强化不进入开发 |
| NP-01 | 0 | P0 | — | — | 核实双平台/数据库/目标环境；冻结性能数据规模和指标，列明确未提供项 |
| NP-02 | 0 | P0 | — | SEC-F3a-01 | 当前锁文件全量/生产审计、生产可达性及补丁兼容处置；不自动重大升级 |
| NP-10 | 1 | P0 | NP-00 | SEC-F3-02C1d2b3d2a | host早期互斥、只读可信Snapshot、旧Registry/watch零启动；Gateway闭锁与非Gateway健康，默认off |
| NP-11 | 1 | P0 | NP-10 | SEC-F3-02C1d2b3d2b | 等committed routes后用新proof装配稳定facade；真实Nest/PG/HTTP正负验收 |
| NP-12 | 1 | P0 | NP-11 | SEC-F3-02C1d4 | 普通reload固定在途快照；撤销/收窄/到期在DNS/连接/流阶段abort；shutdown无资源残留 |
| NP-13 | 1 | P0 | NP-12 | SEC-F3-02C3, SEC-F3-02C5b, SEC-F3-02C6 | 同operation/deadline/epoch贯穿Gateway执行，统一失败与脱敏审计，双运行时真实矩阵，单attempt/cache-off |
| NP-20 | 1 | P0 | NP-00 | SEC-E1-02C1, SEC-E1-02C2 | 持久trusted_ipc_v1启动、READY后RUNNING、每次重启重新准备；超时/退出/停止正确，无秘密argv/隐式fallback |
| NP-21 | 1 | P0 | NP-20 | SEC-E1-03 | 真实child→受控上游继承/覆盖/None、缺Secret零发送、零自动跳转与legacy边界 |
| NP-22 | 1 | P0 | NP-21 | SEC-E1-04, SEC-C3-03 | 实际运行child的代次协调、更新/撤销时限和在途语义可验；无混版本执行 |
| NP-30 | 2 | P0 | NP-00 | SEC-F1-02D | preview/批量发布/激活同结果；事务内context/证据复核；部分失败不误部署，保旧有效版本 |
| NP-31 | 2 | P0 | NP-10 | SEC-F1-02C3G5 | 补齐host challenge/session/proof issuer及request-bound provider，真实Gateway在Resolver/cache前复核；独立guard不算完整接线 |
| NP-32 | 2 | P0 | NP-21, NP-22 | SEC-F1-02E3b, SEC-F1-02C3G6 | 真实child更新前阻断、实时许可及撤销零联网；proof不跨IPC序列化 |
| NP-33 | 2 | P0 | NP-30, NP-31, NP-32 | SEC-F1-02F, SEC-C4-01 | Gateway/MCP、SQL.js/PG重开、迟到/并发/同revision秘密变化矩阵；Unresolved联网前拒绝 |
| NP-40 | 3 | P1 | NP-00 | OBS-14-03E2B, OBS-14-03E3 | 有界过期事件物理清理与gap/cursor同事务；TTL/回滚/重启/Outbox/410/重复清理验收，默认关闭 |
| NP-41 | 3 | P1 | NP-00 | OBS-14-03D, OBS-14-06A | 投递30天及活动引用保护、receipt墓碑和管理审计清理；失败保留恢复证据 |
| NP-42 | 3 | P1 | NP-00 | OBS-14-06T | 暂存扫描/导入状态/重启进度持久化，不丢有效数据、不重复计量 |
| NP-43 | 3 | P1 | NP-01 | OBS-14-05C3, OBS-14-05D | Linux/PG多进程和长期故障验收、状态联调；账本守恒，未知占用不释放 |
| NP-44 | 3 | P1 | NP-00 | OBS-13-02 | 状态流/调用事实流长连接、慢客户端、ACK/有限缓冲/恢复；明确跨部署及持久消费者边界 |
| NP-45 | 3 | P1 | NP-00 | OBS-15-01, OBS-15-02 | 迁移选定旧查询入口；统一权限/身份/分页/拒绝审计，移除对应双链 |
| NP-46 | 3 | P1 | NP-00 | PROD-05 | 实例/绑定变更操作者透传到可查询审计，权限拒绝/脱敏/归属有证据 |
| NP-47 | 3 | P1 | NP-00 | OBS-06-01 | 支持的MCP传输成功/取消/超时/大正文终态及Windows原生对照；失败不伪成功 |
| NP-50 | 4 | P0 | NP-01, NP-13, NP-21, NP-22, NP-33 | SEC-C2-01, SEC-E2-01, SEC-E2-02, SEC-F3-02D, SEC-F3-03 | Linux文件权限、双平台传输、N01～N17、秘密扫描和生命周期审计，同版本证据 |
| NP-51 | 4 | P1 | NP-01, NP-21, NP-33 | PROD-04C, EXT-01, EXT-02, EXT-03, EXT-04, EXT-05, EXT-06, EXT-07, EXT-08, EXT-09, ENV-01 | 真实注册→测试→治理→发布→消费、迁移/失败保旧、二进制留存、Windows/Ubuntu完整流程及health |
| NP-52 | 4 | P1 | NP-01, NP-40, NP-41, NP-42, NP-43, NP-44, NP-45, NP-47 | OBS-06-02, OBS-16-02, OBS-16-03 | 同候选双平台MCP正文、数据库/多进程、持续负载/容量、故障恢复；按冻结指标通过 |
| NP-53 | 4 | P0 | NP-02, NP-46, NP-50, NP-51, NP-52 | SEC-F4-02 | 逐父包退出复核、当前依赖处置、平台/DB/功能门禁一致，形成候选签收 |
| NP-60 | 5 | P0 | NP-53 | OBS-16-04, OPS-01 | 目标部署权限/TLS/审计目录/告警/备份恢复/开关/回退签收，不复算功能完成 |
| NP-70 | 6 | P2 | — | MAIL-01, MAIL-02 | 验证码/重置/通知范围与受控邮箱先定，后实现投递及失败恢复 |
| NP-71 | 6 | P2 | NP-51 | MAINT-01 | 发布稳定后按测量拆前端结构/分块，关键交互无回归 |
| NP-72 | 6 | P2 | — | MAINT-02 | 随每包检查中英文可见文案/编码，里程碑汇总，不无限扩张 |
| NP-73 | 6 | P2 | — | DEFER-01, DEFER-02 | OAuth2、额外令牌与跨协议QoS保留延期；重新批准范围后单独计划 |

## 本批执行子任务

以下是既有主包的执行切片，不新增旧任务归属、不增加31个主包数量。状态及证据仍只维护在[统一开发状态](unified-development-status.md)；子任务完成不自动代表主包完成。

| 子任务 | 主包 | 优先级 | 前置 | 验收出口 |
| --- | --- | --- | --- | --- |
| NP-02.1 | NP-02 | P0 | — | 同主版本补丁和定点替换；实际消费副本与锁文件一致；全量/生产在线复审，保留残余漏洞 |
| NP-02.2 | NP-02 | P0 | NP-02.1 | 压缩断连、Socket.IO、上传限额/中断、YAML/Axios、SDK协议回归及四工作区构建 |
| NP-02.3 | NP-02 | P0 | NP-02.2 | Inspector、braces/chokidar、Nest/数据库/图表等剩余漏洞分别评估升级与暴露面；不以低优先级代替处置 |
| NP-20.1 | NP-20 | P0 | NP-00 | 真实Nest容器整体关停，实际child/监听/健康检查/重启计时器释放，持久终态正确 |
| NP-20.2 | NP-20 | P0 | NP-20.1 | 真实超时和强制终止贯通产品生命周期，无迟到RUNNING及残留；无测试配置进入生产授权面 |
| NP-31.1 | NP-31 | P0 | NP-10 | 注册host challenge/session/proof与请求绑定provider；默认关闭，伪造/过期/撤销/漂移拒绝，有集成正负证据 |
| NP-31.2 | NP-31 | P0 | NP-31.1, NP-30 | 完整受保护发布/实际Gateway入口、事务内证据复核、异步激活及PG并发证据齐备 |

## 原父任务和跨计划归属

| 原视图 | 新执行归属/处理 |
| --- | --- |
| Phase1/2；WP00/10、DEV01～04已交付切片 | BASE-150；当前数据库/真实流程复验归NP-50/51/53 |
| Phase3；WP90；EXT01～09 | NP-10～60收口；NP-51实际产品路径 |
| WP20/30/50/70，DEV02/03 | NP-51迁移与失败保旧；不重做内部实现；CAS归NP-00范围审查 |
| WP40/DEV04 | BASE-150二进制实现；NP-51真实留存/平台权限 |
| WP80/DEV05 | NP-46操作者审计、NP-45统一查询 |
| SEC-A0/A1/A2/A3/B1/B2/B3/C1/D1/E0 | 已有父包DONE证据，回归复用 |
| SEC-A4 | 旧子项DONE但模型有后续迁移；NP-53按最终候选核对数据库基线 |
| SEC-C2/C3/C4 | NP-50 Linux；NP-22多进程；NP-33两运行时Resolver |
| SEC-D2 | 原B2/D1依赖已完成，NP-00仅复核原退出与证据，不新增多节点QoS |
| SEC-E1/E2/F1/F2/F3/F3a/F4 | NP-20～33/50/53、NP-10～13/02；F2已有UI切片归基线，真实浏览器与父依赖归NP-51/53 |
| OBS01～05/07～12 | BASE-150；业务generation与retained水位边界保留 |
| OBS06/13/14/15/16，AUDIT01～04 | NP-40～47/52/60；不新建第二事件源或索引链 |
| SEC-DEP01/SEC-OPS01 | NP-02/53/60 |

## 校验

执行 `node scripts/verify-unified-work-plan.cjs`：检查209条唯一旧记录、150条基线、59条迁移逐项唯一覆盖，主包/子任务与状态一一对应、归属及依赖无环。此检查仅证明计划结构一致，不代替代码/环境验收。
