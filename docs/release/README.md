---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-26
---
# 版本发布文档入口

本次候选为 **v1.7.6-rc.6**，人工测试预发布，生产签收未完成。本次从main构建三平台离线候选包，门禁和原生验证完成后发布新标签并整体晋升latest。

| 需要 | 入口 |
| --- | --- |
| 用户启动和人工检查 | [rc.6快速指南](./versions/v1.7.6-rc.6/QUICK_START.md) |
| 版本变化和已知限制 | [rc.6发布说明](./versions/v1.7.6-rc.6/RELEASE_NOTES.md) |
| 当前开发分支的完整手册 | [文档中心](../README.md)、[现行清单](../VERSIONS.md) |
| 发布条件与事务 | [唯一发布规范](../../RELEASE_STANDARD.md)、[就绪检查表](../guides/release-readiness-checklist.md) |
| 三平台构建操作 | [发布操作说明](./api-nova-release-requirements.md) |
| 文档随包交付和校验 | [文档交付说明](./DOCUMENTATION.md) |
| 当前风险和未签收出口 | [open-items](../reference/open-items.md) |
| 历史版本 | [版本索引](./versions/README.md) |

创建下一版本前使用templates准备RELEASE_NOTES/QUICK_START；保持精确标签、提交、锁文件和三平台原生离线验证一致。原版历史说明保留原发布时的事实，安全/开发状态以当前台账为准。
