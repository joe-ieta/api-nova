---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# MAIL-02 受控邮件投递证据（2026-09-26）

> Document status: Active evidence。按 [MAIL-01 合同](./mail-delivery-scope-and-acceptance.md)受控验收：本地 sink 端到端 + 回环假 SMTP；未向任何真实外部地址发送。

## 1. 环境与执行

- 命令：`npm run verify:mail-02`（`scripts/test-mail-delivery.cjs`），标记 `MAIL_02_OK`
- 环境：commit `65458b6`，win32 x64，Node v24.15.0；sink 目录 `E:\temp\opencode\api-nova-mail-02-sink-*`（JSONL）
- 结果：**6 suites / 30 tests 全通过**（模板 5、邮件服务 9、SMTP 3、认证投递 5、通知 6、迁移 2）；`MAIL_ENABLED=false` 默认关闭
- 构建：`npm run build --workspace api-nova-api`、`--workspace api-nova-ui` 均通过；`database-tool.cjs smoke sqlite` = entities 73/domainTables 73/appliedMigrations 8/schemaDrift 0/apiStartup true

## 2. 实施范围（对照 MAIL-01 §5）

| 项 | 结果 |
| --- | --- |
| 1 配置与校验 | `MAIL_ENABLED`/`MAIL_TRANSPORT`/`MAIL_SMTP_*`/`MAIL_FROM`/`MAIL_ALLOWED_RECIPIENTS`/`MAIL_SUBJECT_PREFIX`/`MAIL_RATE_LIMIT_PER_HOUR` + 补充 `MAIL_SINK_DIR`、`MAIL_ACTION_BASE_URL`、`WEBHOOK_NOTIFICATION_URL`、`SLACK_WEBHOOK_URL` 已入 schema/.env.example；秘密仅环境读取 |
| 2 邮件模块 | transport 抽象 + `sink`（默认，JSONL 落盘）/`smtp`（node:net/node:tls 自研，无新依赖）；代码内模板 `verify-email.v1`/`reset-password.v1`/`alert-notification.v1`（zh-CN/en-US，变量白名单+HTML 转义）；收件人白名单大小写规范化；每收件人/模板/小时限流；审计接入（脱敏 `a***@domain`，无 token/正文） |
| 3 认证接线 | 注册/忘记密码真实投递；新增公开 `POST /auth/resend-verification`、`POST /auth/reset-password`；`verify-email` 以 body `{token}` 为主、query 兼容；token 改 CSPRNG(32B base64url)+SHA-256 摘要存储，验证 TTL 24h（新列 `emailVerificationExpiresAt` + SQLite/PostgreSQL 双迁移 1790000012000/13000）、重置 TTL 1h；一次性消费；移除 token 前缀日志；响应语义不变 |
| 4 通知接线 | `alert.created/acknowledged/resolved` 经偏好+白名单+开关解析；同告警 ack/resolve 去重合并（250ms 去抖，最新态优先）；最多 3 次指数退避（起始 5s，可注入）；不阻塞告警主链；WebSocket 行为不变 |
| 5 失败与恢复 | 投递失败不回滚注册/重置；重试终结写 `FAILED` 审计；未新增第二套通知存储 |
| 6 测试 | 上述 6 suites/30 tests + `verify:mail-02` 执行器；无真实外部地址 |
| 7 UI | `/forgot-password` 视图+路由+中英 i18n、登录页入口、`resendVerification()` 客户端、`verify-email` body 契约确认；通知偏好在无用户设置 UI 的情况下明确延后 |

## 3. 验收矩阵（MAIL-01 §4）

- 默认关闭无发送；白名单外拒绝（`REJECTED`，脱敏审计）；三类流程对 sink 端到端成功；token 仅摘要持久化且日志/审计无明文；失败重试与终结审计；限流触发拒绝；注册/忘记密码通用响应与不枚举回归；UI 忘记密码/重置/验证路径可用（构建级）。

## 4. 边界与决策（如实）

- 未覆盖：真实外部 SMTP/第三方、PostgreSQL 运行时装新迁移（DDL 由专项断言）、持久投递队列/退信、UI 偏好开关（无设置页）、浏览器级 UI e2e、STARTTLS（仅隐式 TLS）。
- 决策记录：限流超限=`REJECTED`；`MAIL_ENABLED=false` 不写审计（保持原“不投递”语义）；沿用既有 `AuditAction` 枚举 + `resource:'mail'`；旧明文 token 因摘要化而失效（迁移注意）；管理员重置改为摘要查找但不额外撤销会话；忘记密码成功文案改为通用 `Password reset request accepted.`。
- 新增配置键 `MAIL_SINK_DIR`、`MAIL_ACTION_BASE_URL`（默认取首个 `CORS_ORIGINS`）为合同外实现补充，已写入 `.env.example`。

## 5. 出口判定

MAIL-02 **DONE（限定）**：受控本地矩阵与三类接线完成；真实外发、生产启用与跨平台/队列化属环境或另立任务，须单独授权与签收。
