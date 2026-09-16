---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-16
---
# 重拆第三批：跨批围栏、原子基线与二进制样例证据

本记录对应[111项任务划分](../guides/active-work-package-breakdown.md)和[统一执行台账](../guides/active-work-package-execution-status.md)中的限定子项。叶子任务的完成不等于OBS-14、PROD-04或SEC父包验收；测试总数有重叠，不能相加作为项目完成率。

## 本批完成的限定出口

| 子项 | 可核查结果 | 尚未覆盖 |
| --- | --- | --- |
| OBS-14-05C2B1 | 独立inventory租约在跨批期间阻挡另一Store的writer/GC，校验owner、generation和到期；到期失效持久化使旧checkpoint不可复用。新专项7/7，既有相关回归61/61，API类型检查通过。 | 不启动扫描或确认baseline。 |
| OBS-14-05C2B2 | 同一围栏内从shard 0有界重扫，逐行核验C2A未验证前缀；旧代次或文件原地变化时，在ledger仍initializing、无reservation的条件下CAS废弃并重建。完整256 shard、owner/epoch/generation/root及账本/预留在最终事务复核后确认baseline。专项15/15，相关旧回归53/53。 | 默认每批最多1000条、每次32批，可显式提高至10000批；超预算返回incomplete且不ready。没有controller或启动器接线，quotaEnforced仍为false。受管域外直接改盘不与数据库构成原子快照。 |
| OBS-14-05C2B3 | 独立SQL.js故障矩阵7/7：双Store竞争、模拟崩溃导出重启、扫描/检查点/账本事务失败、租约超时和确认后双Store预留硬上限。 | Linux、PostgreSQL、真实多进程、真实杀进程和磁盘压力属于05C3等后续验收；未执行生产配额。 |
| PROD-04B2B1 | 仅真实有界HTTP流形成受信原始字节；样例与对象ready状态同事务，run只留摘要。文件/对象状态失败保留不可读staged墓碑并将HTTP成功记为storage_failed成功；直接删除和到期清理暂对有对象样例关闭。 | 默认关闭；不提供下载、撤销或回收。 |
| PROD-04B2B2 | SQL.js导出重启、rename后事务失败、重复执行独立ID、文件open/rename失败与半对象不可读的独立验收；对象测试与B2C合并的五组回归68/68通过。 | 墓碑最终回收、实际物理删除和跨平台文件权限仍待B3/04C。 |
| PROD-04B2C | 新增server:manage保护的二进制内容读取，只按sampleId核对样例描述符、归属与ready对象，读取后复核；真实JWT守卫与SQL.js HTTP测试覆盖401/403/200/404/410/503、固定下载头和Range拒绝。 | 无引用撤销、显式GC、binary-exact回放或生产配置启用。 |
| SEC-F4-01 | 新增[安全交付证据索引](../guides/security-delivery-evidence-index.md)，45个SEC叶子ID逐项对应，70个相对链接有效；区分历史、本机限定、准备和未验收证据。 | 不构成SEC-F4-02生产签收。 |

本批主代理独立复验：二进制五套68/68、围栏7/7、基线15/15、基线故障7/7，API type-check和构建均通过；git diff --check通过。计划与状态表各111项、集合一致、重复0；93条依赖无悬空或环路，已完成项无未完成前置。以上是Windows本机SQL.js、受控loopback和合成故障结果，不是PostgreSQL实库、Linux权限、真实身份提供方或生产部署证据。

## 下一依赖与授权边界

OBS-14-05C2C现可处理未结算预留、发布后孤儿及残留占用；PROD-04B3现可处理引用撤销、对象整理和二进制验证语义。两项工作量仍大，下一批须再切成可独立验收的出口。SEC-E1-02C1产品受管生命周期与OBS-14-03E2B事件永久物理删除仍等待各自明确授权；本批未实施这些动作。没有连接业务数据库、执行生产迁移、真实删除或部署。