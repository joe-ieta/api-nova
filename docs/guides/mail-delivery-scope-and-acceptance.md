---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-26
---
# 邮件投递范围与受控验收合同（MAIL-01）

> Document status: Active。本文只冻结范围、接口合同、模板政策与受控验收策略，不属于当前产品主线里程碑，也不代表邮件功能已实现。实际发送到第三方地址必须另行授权。
> 依据：[工作包划分](../guides/active-work-package-breakdown.md) MAIL-01/MAIL-02、[未完成事项](../reference/open-items.md) 第6节、[阶段计划](./staged-development-plan.md) Deferred Topic、[项目基线](../baseline/PROJECT_BASELINE.md) Deferred Topic。

## 1. 目的与边界

MAIL-01 的出口是：验证码、重置、通知三类接口、模板及测试邮箱策略明确。本文据此冻结 MAIL-02 实施前的合同，不修改当前运行默认，不新增依赖，不代替依赖审计（SEC-F3a-01）和发布验收。

当前事实（源码核对）：

- 没有任何邮件发送实现、模板存储、邮件实体或 `MAIL_*`/`SMTP_*` 配置；`package.json`/锁文件无 nodemailer、SendGrid、SES 等依赖。
- 注册仅生成并持久化验证 token，随后告警"current baseline 不投递"（[auth.service.ts](../../packages/api-nova-api/src/modules/security/services/auth.service.ts) 128–191）。
- 忘记密码仅生成重置 token，同样不投递（同文件 284–319）。
- 通知服务只有内存渠道/记录，`sendEmailNotification` 是抛错占位；EMAIL 被标记为不可重试（[notification.service.ts](../../packages/api-nova-api/src/modules/websocket/services/notification.service.ts) 411–429）。
- UI 存在死路径：`resetPassword` 调用的 `POST /auth/reset-password` 不存在；`verifyEmail` 用 body 传 token 而 API 读 query；`/forgot-password` 有公开路由声明但无视图（[api.ts](../../packages/api-nova-ui/src/services/api.ts) 1485–1506、[router/index.ts](../../packages/api-nova-ui/src/router/index.ts)）。
- 管理审计矩阵没有邮件路由或 `notification:*` 权限；`users.preferences.notifications` 字段存在但无读写方。

明确非目标（本里程碑）：

- 不构建授权服务器、营销/批量邮件、退订管理、退信/投诉 webhook。
- 不把邮件作为 MFA/2FA 或登录必需因子。
- 不向非受控地址发送真实邮件；受控验收只使用受控邮箱/本地接收端。
- 不因邮件投递失败改变注册、忘记密码等接口的既有响应语义（见第3节失败语义）。

## 2. 三类投递接口合同（冻结）

### 2.1 验证码类（邮箱验证）

- 发送入口：`POST /auth/register` 隐式发送；新增 `POST /auth/resend-verification`（受 `auth:public` + 每邮箱/每 IP 限流，响应通用，不暴露账号是否存在）。
- 消费入口：`POST /auth/verify-email`，token 一律走请求体 `{ token }`；现有 query 形式降级为兼容输入并标记 deprecated，UI 与新文档统一 body。
- Token：替换 `Math.random` 为 CSPRNG（≥32 字节，base64url）；持久化 SHA-256 摘要而非明文；新增 `emailVerificationExpiresAt`（实体 + SQLite/PostgreSQL 迁移），TTL 24 小时；一次性消费；消费成功后 `emailVerified=true` 且清除 token/到期。
- 邮件内容：一次性验证链接（含 token）+ 到期时间；不发送明文 token 到日志、审计或回复正文。
- 失败语义：注册成功不因投递失败回滚；失败写入管理审计 `FAILED` 并允许通过 resend 重试；已 `PENDING` 用户保持待验证。
- 审计：不再记录 token 前缀（现状 `substring(0,8)` 必须移除）；记录操作、账号、结果与脱敏原因。

### 2.2 重置密码类

- 发送入口：`POST /auth/forgot-password` 保持通用 200 响应与不枚举用户；内部生成/持久化 token 后投递。
- 消费入口：新增公开 `POST /auth/reset-password`（`{ token, newPassword }`），满足 UI 既有调用；管理员 `POST /users/:id/reset-password` 保持现状不合并。
- Token：CSPRNG + 摘要存储；TTL 1 小时（沿用现值）；一次性；成功/失败均写审计，不写 token 原文。
- 邮件内容：一次性重置链接 + 到期时间 + "若非本人操作请忽略"。
- 失败语义：响应保持通用，不确认投递；投递失败写审计，允许用户重新发起。

### 2.3 通知邮件类

- 触发源：仅 `alert.created` / `alert.acknowledged` / `alert.resolved`（[notification.service.ts](../../packages/api-nova-api/src/modules/websocket/services/notification.service.ts) 226–269）。
- 收件人：必须同时满足 `MAIL_ENABLED=true`、用户在 `MAIL_ALLOWED_RECIPIENTS`（受控模式，见第4节）或外部模式下的明确授权、且 `users.preferences.notifications.email === true`；缺任一条件不发送，且不默认全量通知管理员。
- 内容：标题含可配置前缀；正文使用固定模板（第3节），不含调用详情、凭据、IP 或堆栈；可含资产/告警名称与跳转链接。
- 汇总：同一告警的 acknowledge/resolve 通知按告警 ID 去重合并；不做营销或周期摘要。
- 失败语义：最多 3 次重试（指数退避，起始 5 秒）；仍失败写管理审计 `FAILED` 并停止；不阻塞告警主流程，不无限重试；WebSocket 通道行为不变。
- 审计：每次尝试记录渠道类型、模板标识、结果与脱敏原因，不记录正文与收件人全量地址（脱敏为 `a***@domain`）。

## 3. 模板政策（冻结）

- 存储：MAIL-02 首发使用代码内模板模块（不建数据库模板表）；如需运营可编辑模板，另行建 DOC 与权限模型。
- 格式：`text` 必选，`html` 为最小安全子集（无外链脚本、无远程图片默认加载）。
- 语言：按用户 locale（默认 `zh-CN`，`en-US` 备选），与 UI locale 模块对齐；模板标识形如 `verify-email.v1`、`reset-password.v1`、`alert-notification.v1`。
- 变量白名单：`appName`、`username`、`emailMasked`、`actionUrl`、`expiresAt`、`alertName`、`severity`、`assetName`。模板渲染只接受白名单变量，未知变量拒绝或留空并记录。
- 禁止项：明文 token 摘要/密码/凭据、请求头、完整调用正文、内网地址。
- 主题：`<MAIL_SUBJECT_PREFIX><模板主题>`；受控验收固定前缀以便识别测试邮件。

## 4. 受控验收与测试邮箱策略（冻结）

- 默认关闭：`MAIL_ENABLED` 默认 `false`；未启用时三类流程保持现状（生成 token、告警、不投递）。
- 传输抽象：`MAIL_TRANSPORT`：`sink`（默认，本地接收端/回环 SMTP，落盘到运行审计目录供断言）或 `smtp`（受控 SMTP/沙箱）。新增第三方依赖前须完成 SEC-F3a-01 依赖可达性审计与兼容补丁评审。
- 受控模式：`MAIL_ALLOWED_RECIPIENTS`（逗号分隔）为唯一允许收件集合；受控验收只能使用本地 sink 或该集合内的测试邮箱（建议 `SUPER_ADMIN_EMAIL` 或专用测试邮箱）。真实外部地址只可通过 `smtp` 且需单独书面授权，不允许在测试脚本中硬编码。
- 配置键（MAIL-02 落地到 `validation.schema.ts`/`AppConfigService`/`.env.example`）：`MAIL_ENABLED`、`MAIL_TRANSPORT`、`MAIL_SMTP_HOST`、`MAIL_SMTP_PORT`、`MAIL_SMTP_SECURE`、`MAIL_SMTP_USER`、`MAIL_SMTP_PASSWORD`、`MAIL_FROM`、`MAIL_ALLOWED_RECIPIENTS`、`MAIL_SUBJECT_PREFIX`、`MAIL_RATE_LIMIT_PER_HOUR`。秘密只从环境/受控 Provider 读取，不落库、不回显。
- 限流：每收件人/每模板/每小时上限（默认 10），超限拒绝并审计。
- 证据合同：每次验收记录目标环境、版本/提交 SHA、运行命令、执行时间、收件人（脱敏）、模板标识与版本、传输类型、消息 ID、原始脱敏日志与退出码；受控夹具结果不得替代真实环境签收（遵守 [open-items](../reference/open-items.md) 证据口径）。
- 验收矩阵（MAIL-02）：默认关闭无发送；白名单外收件人被拒绝；三类流程对 sink 端到端成功；token 仅摘要持久化且日志/审计无明文；失败重试与终结审计；限流；既有通用响应与不枚举语义回归；UI 忘记密码/重置/验证路径可用。

## 5. MAIL-02 实施清单（待 MAIL-01 批准后）

1. 配置与校验：新增上述 MAIL 配置与元数据；声明现有未声明的 `WEBHOOK_NOTIFICATION_URL`/`SLACK_WEBHOOK_URL`。
2. 邮件模块：传输抽象 + sink/smtp 适配、模板渲染、限流、管理审计接入；默认关闭。
3. 认证接线：替换 `auth.service.ts` 两处 TODO；新增 resend 与公开 reset-password；token 熵与到期迁移；移除 token 前缀日志。
4. 通知接线：实现 `sendEmailNotification`，收敛 `isNonRetryableChannelError`；收件人解析走偏好 + 白名单。
5. 失败与恢复：重试/幂等/终结审计；不新增第二套通知存储，如需持久投递记录另立任务。
6. 测试：Jest 专项 + `scripts/test-mail-delivery.cjs`（对本地 sink），覆盖第4节矩阵；不得使用真实外部地址。
7. UI：补 `/forgot-password` 视图与路由、修正 `verify-email` 传输、可选通知偏好开关。

## 6. 状态与后续

- MAIL-01（本文）完成 DOC 出口；MAIL-02 依赖本文，从 WAIT_DEP 转为 READY。
- 邮件投递仍不属于当前 OBS/SEC 专项计数；完成状态以[子任务台账](./active-work-package-execution-status.md)为准。
- 2026-09-26 MAIL-02 按第4节完成受控验收并限定 DONE（[证据](../audits/2026-09-26-mail-02-controlled-delivery.md)）：本地 sink 端到端、回环假 SMTP、白名单/限流/摘要 token/退避审计矩阵与 UI 忘记密码路径；真实外发、生产启用、PostgreSQL 运行时装迁移、持久队列/退信与 UI 偏好开关仍待授权或另立任务。实现补充两个合同外配置键 `MAIL_SINK_DIR`、`MAIL_ACTION_BASE_URL`（已入 `.env.example`）。
- [未完成事项](../reference/open-items.md) 第6节的待办性质在本轮按上述边界更新后仍保留“真实环境签收”部分。
