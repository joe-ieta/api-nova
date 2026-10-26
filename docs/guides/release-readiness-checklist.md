---
doc-version: 1.5.0
doc-status: active
doc-updated: 2026-10-26
---
# 发布就绪检查表

此表用于逐次填写结果，不是“全部通过”的签收报告。当前rc.5是人工测试预发布，SEC-F4-02、OBS-16-04、OPS-01及依赖风险仍开放。发布以[唯一规范](../../RELEASE_STANDARD.md)为准。

## 身份与源码

- [ ] 标签、精确commit、批准分支、根锁文件与工具链一致，工作区干净并已同步。
- [ ] 版本说明/快速指南在标签前提交；最终包内无@GIT_COMMIT@占位符。
- [ ] 当前支持、限制、默认关闭开关和未验目标准确列明；人工结果不由自动化代签。

## 工程与文档门禁

```bash
npm ci
npm run verify:package-manager
npm run verify:runtime-closure
npm run test
npm run type-check
npm run lint
npm run build
node scripts/verify-docs.cjs
node scripts/export-api-docs.cjs --check
```

- [ ] 记录命令、环境、提交、退出码和证据；lint要求0 error且命令成功，warning数量可见。
- [ ] 复审生产依赖公告及实际影响；10-26有7 high/9 moderate包节点，不能沿用0 high旧结论。
- [ ] 现行文档清单、相对链接、API快照和示例无漂移；历史条目只作追溯。
- [ ] 双库空schema/迁移/持久化/启动结果及样例/对象/调用留存按当前合同记录；原73表/8迁移是rc.5证据，不是永久schema断言。

## 三平台产物

- [ ] Windows x64、Linux x64、Linux ARM64均由匹配OS/CPU构建，包含对应Node和生产依赖。
- [ ] 暂存及最终归档新解压副本均在断网/受控网络下通过；/、/api/health/live、/api/system/initialization检查成功。
- [ ] 启停无遗留PID；测试数据/日志已移除；公开默认值已披露，无真实凭据。
- [ ] 检查完整health所需5GiB/内存/MCP，与单独live结果分开记录。
- [ ] docs/README.md、API快照和当前手册已随包导出，包内本地链接可用；历史/源码链接固定到同一提交。

## 交付与签收

- [ ] 三包、说明、Quick Start、Manifest、SHA256固定同一身份并复验。
- [ ] 数据备份、迁移策略及回退验证明确；legacy目录和不可变archive未被覆盖。
- [ ] 完整三平台latest原子晋升，CURRENT_RELEASE.json最后写入；精确注释tag及远端七附件一致。
- [ ] SEC/OBS目标签收、用户人工反馈和OPS汇总逐项有结论；未完成项继续列入open-items，不通过删合同或新增无限任务收口。

具体使用流程验收见[发布用例](../testing/runtime-publication-acceptance-cases.md)，安全用例见[安全验收](../testing/runtime-security-audit-cases.md)。
