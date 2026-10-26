---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 验收与证据指引

功能验收以原批准合同为准，文档校验、自动化通过和人工/生产签收分别记录。

| 用途 | 当前入口 |
| --- | --- |
| 注册→测试→治理→发布、实例/样例、消费与保旧 | [发布用例](./runtime-publication-acceptance-cases.md) |
| 身份、审计、拒绝及目标安全验收 | [安全用例](./runtime-security-audit-cases.md) |
| Linux Provider隔离运行 | [平台步骤](./upstream-secret-provider-linux.md) |
| 发布全套门禁 | [就绪检查表](../guides/release-readiness-checklist.md) |
| 文档与API快照 | [文档交付说明](../release/DOCUMENTATION.md) |

每次记录精确代码身份、平台/CPU、Node/npm、DB、有效配置/身份、命令、时间、结果、脱敏证据及清理。passed只覆盖明确运行范围，未运行不能用历史计数代替。生产签收、真实收件和用户反馈保留在[open-items](../reference/open-items.md)。
