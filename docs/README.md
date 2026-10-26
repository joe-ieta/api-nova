---
doc-version: 1.7.0
doc-status: active
doc-updated: 2026-10-26
---
# 项目文档与阅读指引

本页是当前文档的唯一阅读入口，复核日期2026-10-26。当前候选v1.7.6-rc.6仍为人工测试预发布；本次在main执行完整候选发布，历史发布物保留，生产签收另行完成。

## 按角色阅读

| 读者/目标 | 建议顺序 |
| --- | --- |
| 项目使用者、产品评估 | [项目概览](./overview/PRODUCT.md) → [使用手册](./guides/USER_GUIDE.md) → [当前限制](./reference/open-items.md) |
| 架构和二次开发 | [总体设计](./architecture/OVERALL_DESIGN.md) → [开发手册](./development/DEVELOPER_GUIDE.md) → [API手册](./api/README.md) |
| 安装与运维 | [部署](./guides/DEPLOYMENT.md) → [数据库](./guides/database-strategy.md) → [可观测性](./guides/OBSERVABILITY.md) |
| API/自定义UI接入 | [接入约定](./api/README.md) → [完整接口清单](./api/ENDPOINTS.md) → [OpenAPI快照](./api/openapi.json) |
| 发布与验收 | [项目基线](./baseline/PROJECT_BASELINE.md) → [open-items](./reference/open-items.md) → [发布规范](../RELEASE_STANDARD.md) → [检查表](./guides/release-readiness-checklist.md) |

## 当前文档分工

- **总体与能力**：概览负责定位/功能边界，总体设计负责分层/数据流；不再维护并行的旧总体方案。
- **使用与部署**：使用手册负责业务操作；部署手册负责运行、配置、健康、升级和回退；数据库仅维护持久合同。
- **开发API**：接入手册负责认证/响应/主流程；生成清单和JSON对应当前控制器；MCP、Parser、可观测性分别维护自己的协议。
- **技术合同**：[发布/样例](./reference/publication-contract.md)、[安全](./reference/security-contract.md)、[观察/留存](./reference/observability-contract.md)、[权限](./reference/management-permission-matrix.md)保留详细边界。
- **当前状态**：[统一台账](./guides/active-work-package-execution-status.md)是唯一任务状态来源，[合同表](./guides/active-work-package-breakdown.md)保留209项原出口及245依赖，open-items只汇总未关闭事项。
- **版本交付**：[release入口](./release/README.md)区分当前候选、版本记录、模板和打包步骤。

## 完整清单与历史

[现行文档版本清单](./VERSIONS.md)穷举当前文档并标明类型；[机器清单](./documentation-manifest.json)供链接检查和发布文档导出使用。目录索引不再重复列出全部技术正文。

历史审计、旧计划、阶段完成说明和被合并的技术文档已移入[归档](./archive/README.md)，详细条目在[历史目录](./archive/INDEX.md)。原批准条款和证据保留，不把归档中的旧状态/统计当作当前待开发队列。

本套文档与现有能力一致；依赖风险、人工反馈、SEC/OBS/OPS目标签收和延期事项继续保留。最新整理和校验范围见[文档交付说明](./release/DOCUMENTATION.md)。
