---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 在线凭证轮换与临时匿名闭环

## 范围与版本
在main基线5b5587c上实现SEC-B1-02与SEC-A3-01；最终代码版本以包含本报告的提交为准。Windows本机隔离SQL.js、loopback HTTP与真实Node CLI；未修改生产数据或部署。package-lock.json SHA256保持9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54。
## 可使用的功能
管理API POST /api/v1/runtime-assets/:id/runtime-access-credentials/:credentialId/rotate 接受overlapSeconds（0–86400），沿用JWT及server:manage。Key只返回一次；同族新Key保持Subject、协议、Route/Tool Scope及原到期时间，旧Key保存截止窗口且不可重复轮换。事务内保存前后凭证与审计，失败回滚。
主机设置API_NOVA_RUNTIME_CREDENTIAL_SOURCE=database后，现行受管CLI每次请求向私有127.0.0.1 resolver读取当前DB摘要。随机capability绑定Runtime，不进入ProcessConfig/持久日志；停止、自然退出和错误回收，旧进程事件不能撤销新进程。解析器失败返回503，不退回静态Key。原静态环境模式仍是明确的静态配置，不声称动态撤销。
Gateway路由upstreamConfig.temporaryAnonymous与MCP部署temporaryAnonymous保存reason、服务端可信actor、带时区expiresAt和allowProduction；省略字段更新不会清掉原临时授权，null/空期限拒绝。生产临时授权同时需要allowProduction=true和主机API_NOVA_ALLOW_TEMPORARY_ANONYMOUS_IN_PRODUCTION=true。managed子进程NODE_ENV、该许可及凭证来源只取主机，用户env不能覆盖。到期每请求拒绝并审计，重启/冷重开保持原期限。既有显式永久匿名行为保留，风险/到期UI另属F2-02。
Gateway鉴权后只更新lastUsedAt，避免整行保存覆盖并发轮换/撤销。该问题由真实双入口测试发现。
## 执行证据
- npm run build --workspace=api-nova-api：exit 0；Parser/Server构建由并行实现任务验证exit 0。
- npm test --workspace=api-nova-api -- --runInBand --testPathPattern=modules/servers：13套73/73，exit 0，本地日志.tmp/servers-final.log。
- Gateway/runtime-assets/publication联合：30套382/382，exit 0；含轮换事务8/8、真实DB、HTTP、临时保存6/6。
- Parser runtime-access-credential/runtime-credential-resolver/temporary-anonymous/runtime-security-audit：4套67/67，exit 0，本地日志.tmp/parser-final.log。
- node packages/api-nova-api/scripts/test-runtime-credential-rotation-live.cjs：1/1，真实发布→Lifecycle/ProcessManager→CLI，同PID下Gateway/MCP旧新Key窗口、截止、撤销、自然到期及resolver停机验证。本地日志.tmp/rotation-final.log。
- node packages/api-nova-api/scripts/test-temporary-anonymous-lifecycle.cjs：1/1，真实发布→SQLite冷重开→两次CLI→墙钟到期403与磁盘审计。本地日志.tmp/anonymous-final.log。
- node packages/api-nova-server/scripts/temporary-anonymous-http.cjs：7场景通过，同session墙钟到期、生产双许可矩阵和畸形策略。
- process-manager.temporary-anonymous.spec.ts：4/4，含真实子进程主机环境隔离。日志仅为本地证据，不保证随Git分发。
补充并发回归：gateway-security-usage-concurrency.spec.ts真实SQL.js在读取旧Key后暂停请求，完成轮换或撤销再恢复鉴权；2/2通过，验证lastUsedAt不覆盖新状态、旧Key下一请求401。联合security/composition 3套58/58。

## 状态复核与边界
B1-02/A3-01满足既有叶子出口。对照归档父包原条件，A2已有缺失/未知策略拒绝矩阵，父状态滞后；A2、B1、A3依次闭合。D2组合另报告；B3长连接/重连撤销、匿名UI、生产managed IPC、Linux与最终安全发布验收仍独立，不由本报告推断完成。
C3-03先前READY判断漏列E1-02C1产品接线依赖，现纠正WAIT_DEP。现行CLI消费者DB解析器不等同于上游Registry managed IPC。
