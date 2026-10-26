---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 认证、凭据与网络安全合同

本文合并安全需求、实现方案、调用审计及上游安全说明的当前有效部分。各任务原审批条款不因合并而放宽；原文与限定证据在归档保留。目标签收及依赖处置仍归SEC-F4-02。

## 三类身份必须分开

| 身份 | 用途 | 有效边界 |
| --- | --- | --- |
| 管理JWT | 操作管理API和授权实时订阅 | 当前用户状态、角色、权限和资源范围；不授予任意上游访问 |
| 运行时消费身份 | Gateway路由/MCP工具调用 | 对应运行资产、工具/路由范围、会话、到期和撤销；不能用管理JWT或上游密钥替代 |
| 上游认证 | 访问真实目标API | 获准的端点、网络策略及凭据引用；不在普通列表、日志、快照或URL中回显秘密 |

不同字段里的Bearer字样不表示同一信任域。Anonymous只在原有运行时合同显式配置时采用，不能作为未配置认证的自动降级。OAuth2获取token/SSO不在本里程碑。

## 控制面授权

控制器Guard、权限装饰器和服务内资源检查共同决定可操作范围。server:read/update/manage、monitoring细分权限与超级管理员条件不能互相推导；查看某资产不表示可以创建其消费凭据或读取原始正文。具体接口见[权限矩阵](management-permission-matrix.md)及[API清单](../api/ENDPOINTS.md)。

JWT访问令牌、刷新令牌和各类签名HMAC应按有效配置分别提供秘密；示例/离线包公开默认值只用于本地测试。刷新会话不是已证明的多实例持久会话。反向代理、TLS、CORS和信任来源按目标部署核验。

## 上游凭据与网络执行

已有凭据类型及OpenAPI认证对账按现有服务和DTO执行。规范声明只能描述所需认证，不能证明已经注入有效秘密；有效上游身份需要当前绑定、引用解析、认证证据与授权策略一致。

受控header注入、URL/query/header边界、单跳执行、DNS/目标地址/Host/SNI及秘密域约束遵循已有策略；不能以关闭校验或任意跟随重定向规避失败。受管host/网络桥、许可和可信操作映射只有显式装配并取得有效上下文才可用，代码导出存在不代表AppModule生产默认全开。

文件凭据启用和回退见[既有文件激活步骤](../guides/gateway-upstream-credential-file-activation.md)。未知版本、归属冲突、失效凭据和陈旧上下文按原拒绝语义处理；不增加新的Provider或令牌适配。

## 受管MCP与审计

API持有管理控制权，子进程只获得获准运行范围的交付上下文。可信操作映射、受管IPC/持久交接与临时fixture通道有不同证据边界，不能将测试夹具视为目标host配置全链路。启停、会话撤销和秘密扫描已有各自限定证据。

审计、调用事实、正文和进程输出是不同数据族。上游秘密、运行时完整密钥、原始认证头和管理token不进入通用日志/快照；业务二进制也不承诺自动脱敏。脱敏不等于允许无范围访问，查询仍须当前授权。

## 邮件和外部接收

邮件验证、重置和通知已有MAIL-02受控sink/回环SMTP限定验收；不再描述为未实现。`MAIL_ENABLED=false`默认不投递，`MAIL_TRANSPORT`支持sink/smtp；`MAIL_ALLOWED_RECIPIENTS`约束获准接收端。SMTP主机/端口/SSL、发件人、模板前缀和限流按有效配置；秘密由部署提供，不写入API正文或证据。

验证/重置等接口的通用响应不保证邮件送达，也不暴露账号存在性。真实第三方SMTP/地址、Webhook/TLS/出站及生产启用仍需实际授权和目标证据，受控sink通过不能代签。本文没有新的外发授权。

## 当前残余风险

2026-10-26生产依赖审计为6 high、11 moderate、0 critical包节点，包含传播节点和已有Nest SSE回移仍命中的版本范围。既有字节补丁继续保留，但本轮未完成全部可达性/补丁/风险处置，不宣称安全门禁已整体通过。详见[原始审计（历史取证）](../archive/audits/2026-10-26-existing-scope-closure.md#依赖时效与安全签收)。

SEC-F4-02需收齐实际OS/CPU/DB、运行身份/ACL、TLS/代理/出站、有效开关及依赖风险的处置和责任人。生产签收仍待办；不因整理文档接受风险或强制跨大版本升级。

原批准细节：[header/网络边界](../archive/contracts/2026-10-26/security-header-network-boundary-contract.md)、[凭据类型](../archive/contracts/2026-10-26/upstream-credential-types-contract.md)、[认证对账](../archive/contracts/2026-10-26/upstream-security-reconciliation-contract.md)、[可信操作映射](../archive/contracts/2026-10-26/mcp-trusted-operation-bindings.md)、[受管交接计划](../archive/plans/2026-10-26/managed-mcp-credential-handoff-plan.md)。以上为原审批与阶段记录，不作为新开发队列。
