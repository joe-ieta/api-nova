---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# OBS-16-04 本机隔离完整备份恢复演练

## 范围与运行

执行器：[verify-obs-16-04-backup-restore.cjs](../../scripts/verify-obs-16-04-backup-restore.cjs)。命令 `node scripts/verify-obs-16-04-backup-restore.cjs`；需预先构建 API，并有 PostgreSQL 16 的 `initdb`、`pg_ctl`、`pg_dump`、`pg_restore` 可执行文件。可通过 `API_NOVA_TEST_PG_BIN` 指定二进制目录。

每次在仓库 `.tmp/obs-16-04-backup-*` 创建独立集群，仅监听回环动态端口。`obs_source` 和 `obs_restored` 均属于这个新集群；不连接已有 5432，不创建或删除任何外部数据库。执行器保留证据、归档和关闭后的集群数据，结束关闭自己的服务、receiver、数据库连接和 PostgreSQL。

本轮按用户决定仅做本机隔离验收，生产签收保留待办。调用记录由合成 fixture 输入真实产品 ingest；授权使用真实 JWT guard 和数据库持久化账户、角色、权限，未测试完整登录或真实 Gateway 采集。投递使用真实 outbox 与 delivery worker 的 `runOnce`，不证明自动调度启用。

## 一致性与恢复边界

1. 源库运行全部产品迁移，建立账户、授权范围及普通事件订阅。真实 ingest 写入三条调用、脱敏 JSON 和含 NUL 的二进制响应；真实 outbox 生成普通业务事件投递。
2. 接收端验签并先持久保存 deliveryId/eventId 与处理结果，然后故意丢弃第一次响应。产品留下一条 `retry_wait`；其他事件正常成功。接收端去重账本独立于 ApiNova 备份。
3. 停止本执行器所有写入、HTTP 读取、worker 和正文存储服务，关闭数据库连接，确认源库连接数为 0。此后依次 `pg_dump -Fc`、复制整个 observability 私有目录与合成审计暂存、保存配置和逐文件 SHA-256 清单，构成同一停止写入时点的完整备份。没有把在线复制单文件或进程重开算作恢复。
4. 配置清单只含普通设置及 secret 引用。合成 JWT/游标/幂等/Webhook secret 由单独 AES-256-GCM 加密保险库恢复；解密 key 只在当前演练进程内存，解密后清零。普通归档逐文件断言不含这些值。此方式只验证秘密与普通归档分离的恢复依赖，未交付生产密钥托管、ACL 或加密备份方案。
5. 备份后将源库设为不允许连接，并将源目录改名为 offline，排除恢复服务误用原数据。确认目标库 0 张 public 表、目标目录不存在，再 `pg_restore --exit-on-error` 到空库，复制私有目录，独立解密配置秘密，并以新数据库、新目录打开真实产品服务。应用迁移表、业务表、身份权限、审计等全部表的行数和内容指纹必须与源时点一致；文件路径、长度及散列完全一致。正文目录的 owner marker 与存储 generation 随同保留。
6. 恢复后实测正文 HTTP：有权限读取脱敏 JSON 和精确二进制字节 200；匿名 401；缺少正文权限 403；资产范围外 404；已过期正文 410，且授权读取的强制管理审计写入。过期样本时间及重试可执行时间为执行器自有数据库明确设置的 fixture，不变更产品策略。
7. 重新运行 outbox 不生成重复 delivery；剩余不确定投递继续用同一 deliveryId/eventId，receiver 再次验签但只产生一次业务副作用。去重比较事件内容散列，重试的 `delivery.attemptNo` 递增属于正常协议行为，不应按整个请求体散列将重试拒为冲突。再次运行 worker 无新投递。此处证明接收方使用持久去重账本后的效果，不承诺网络 exactly-once。

## 测量与状态

2026-10-08 本轮结果 **7/7 PASS，`OBS_16_04_BACKUP_RESTORE_OK`，exit 0**。环境为 Windows x64、Node v24.15.0、PostgreSQL 16.10。证据目录 `.tmp/obs-16-04-backup-oQqVMX/`，包含 `evidence.json`、PG 工具日志、完整归档、逐表/文件 manifest 及独立 receiver 去重账本。执行时源码 HEAD 为 `ffaafe04d9db805e15002950675d8caac22f1943`，候选含本轮依赖补丁；evidence 记录实际 lock、runner 与构建文件散列。

| 验证项 | 本机结果 |
| --- | --- |
| 全库恢复 | 目标原有 public 表 0；恢复 74 张表，全部行数与内容指纹一致 |
| 文件/正文 | 8 个文件、3,620 字节，清单一致；6 个正文引用、散列、过期时间保留 |
| 已知业务数据 | 3 条调用、3 个普通事件与 3 个 delivery；快照内已知数据损失 0 |
| 授权/保留 | JSON、二进制读取 200；匿名 401、缺权限 403、越界 404、过期 410；强制审计通过 |
| 不确定投递 | 恢复后补发 1 次；同一 delivery 的物理接收 2 次，业务副作用 1 次；总副作用 3 次，再跑无新增 |
| 本机冷备耗时 | 259 ms，停止写入时点 `2026-10-08T04:56:19.060Z`，source watermark `4` |
| 本机恢复闭环耗时 | 1,364 ms，含空库 pg_restore、文件/配置/秘密恢复、校验、授权读取与投递收敛 |
| 清理 | 服务、receiver、独立 PostgreSQL 均已停止，未删除证据 |

第一次运行通过前 6 格，receiver fixture 错把含变化 attemptNo 的整个请求体作为去重内容，导致重试 409；修正为事件内容和 delivery/event ID 后完整复跑通过，未改生产代码。运行有现存 pg 客户端并行 query 弃用提示，本次无失败；不据此宣称已支持未来 pg 9。

RTO 从 `pg_restore` 开始测到授权正文读取与投递收敛结束，记录本机耗时；RPO 记录停止写入快照点及其内已知数据的完整恢复，不外推在线写入期间的数据损失上限，不承诺生产 SLA。

尚未覆盖 Linux/SQLite 恢复、在线并发写入备份、真实生产运行账户和文件 ACL、外部 secret manager、真实部署的密钥轮换、备份周期及异地灾备。OBS-16-04 仍须结合参考负载性能和最终目标部署证据签收。此前[签收准备](2026-10-08-observability-signoff-readiness.md)中“尚无完整 runner”的描述是本轮前基线，以本报告新增实测为后续证据。
