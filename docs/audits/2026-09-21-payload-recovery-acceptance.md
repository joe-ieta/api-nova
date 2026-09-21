---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# OBS-14-05C2C3恢复故障验收

新增[完整恢复链脚本](../../packages/api-nova-api/scripts/test-call-observability-payload-recovery-acceptance.cjs)，不修改生产实现，不直接改写账本制造成功证据。初始化空根baseline后通过实际ingest/发布路径进行故障注入。每次重启先export并关闭旧连接，再重建SQL.js和服务，核对schema零漂移。每次账本断言递归计量临时根.body/.tmp路径字节，确认预留+已提交不少于实物。

| 故障链 | 验收结果 |
| --- | --- |
| 延后结算→重建连接→关联/文件证明→安全结算 | 只读证明不释放；20B预留转10B实际；重启重复恢复与ingest均不重复计费或释放 |
| 外部元数据事务回滚 | 10B文件保持已计费，重启replay修复元数据且不重复计费 |
| 延后结算且元数据回滚/缺receipt | 两次重启均拒绝结算，保留20B；source重放不凭空恢复原缺失证据 |
| final发布后temp unlink失败 | final+temp真实存在，跨重启和重放保留20B峰值，不漏计 |
| 额外temp残留 | 证明阻断；仅测试夹具清理后重建连接，完整证明才结算，重复不再释放 |

新脚本5/5，既有correlation/file-proof/reconcile联合23/23，整合API构建通过。

这是Windows临时目录和SQL.js连接重建证据，不是实际杀进程/掉电、PG、Linux或真实多写者证据。quotaEnforced=false、生产默认开关不变。OBS-14-05C3已解锁，05D等待其退出；OBS-TP-14保持IN_PROGRESS。

[任务划分](../guides/active-work-package-breakdown.md)与[执行状态](../guides/active-work-package-execution-status.md)本批最终132叶子：DONE56、READY27、IN_PROGRESS0、WAIT_DEP29、NEED_ENV17、SCOPE_REVIEW1、DEFERRED2；叶子数量不代表项目完成率。
