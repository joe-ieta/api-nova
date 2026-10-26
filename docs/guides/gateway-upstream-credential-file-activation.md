---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-10-26
---
# Gateway上游凭据文件激活

本文是现有文件Registry路径的操作说明；host运行装配和文件Registry互斥，不能同时启用。上游凭据不是管理JWT或Gateway消费密钥，原则见[安全合同](../reference/security-contract.md)。

## 受控配置

| 配置项 | 要求 |
| --- | --- |
| API_NOVA_UPSTREAM_CREDENTIAL_FILE | 受控本机配置文件的绝对路径，按现有普通文件/归属及链接限制检查 |
| API_NOVA_UPSTREAM_CREDENTIAL_FORMAT | 明确json或yaml，不靠扩展名猜测 |
| API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT | 与文档metadata.environment一致 |
| API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE | 不设置/手动路径，或显式manual/watch；watch已有实现，不再写成未完成 |

四项完全未设置时不构造文件Registry；任一显式值必须满足完整配置与有效Schema，失败不自动降级。持久数据库需已初始化，当前实现会验证候选资产归属并维护header历史账本。显式host模式在读取文件或开启watch前短路此Registry。

初始化的普通配置/秘密失败会报告固定gateway_upstream_credential_configuration_failed；HISTORY_UNAVAILABLE/HISTORY_CONFLICT按源码保留空/闭锁Registry，使Gateway拒绝而非回退旧秘密路径，其他API仍可启动。不能将这类503解释为“未配置所以匿名放行”。

## 状态与重载

`GET /api/security/upstream-credentials/status`要求管理JWT及config:read；`POST /api/security/upstream-credentials/reload`要求config:update。状态和响应不公开路径、秘密引用或秘密值，Cache-Control:no-store。

先读取实际generation，在可信目录维护相同文件及新的metadata.revision，再提交`{ "expectedGeneration": 1, "reason": "轮换上游凭据" }`，其中1用实际代次替换。请求不得传入任意file/path/secret；generation冲突或并发重载按409处理。原因遵守当前DTO长度/控制字符约束。

意图先持久化；候选失败保留旧快照。结果审计失败可能返回503 RELOAD_AUDIT_UNAVAILABLE并带实际代次，不等于已经回滚，应先重新读取状态/审计，避免盲重试。watch采用既有显式开关、文件稳定性检查及生命周期关闭规则；不承诺跨进程一致切换或恶意文件系统隔离。

当前源码入口：[Provider](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential.providers.ts)。Linux Provider隔离验证见[用例](../testing/upstream-secret-provider-linux.md)，目标账户、ACL、真实部署与多进程结果仍单独签收。
