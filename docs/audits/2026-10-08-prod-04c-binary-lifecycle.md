---
doc-version: 1.0.1
doc-status: active
doc-updated: 2026-10-08
---
# PROD-04C 二进制样例留存联合验收

## 环境与判定边界

按用户选择在Windows本机隔离环境验证；生产签收仍归SEC-F4-02、OBS-16-04及OPS-01。本轮复用既有采集、授权下载、撤销墓碑、对象整理和候选验证实现，组合真实HTTP、全新PostgreSQL集群和既有SQL.js故障专项，不重做对象存储。

运行器：[verify-prod-04c.cjs](../../scripts/verify-prod-04c.cjs)。它创建独占`.tmp/prod-04c-*`目录和动态端口，PG仅监听loopback；不连接已有5432数据库，不启用生产后台清理。90天到期与5分钟宽限由自有数据库的显式时间老化夹具验证，不代表连续运行90天。

## 本轮修复的能力阻断

1. 未知二进制MIME被解码为字符串，NUL字节进入PostgreSQL JSONB导致测试接口500。现在仅识别出的JSON/text/XML走原文本处理；未知类型保留有界测量和unavailable原因，不保存原始内容。
2. 二进制status-only候选回放把原始响应字符串写入JSONB，导致验证接口500。Gateway/MCP共享路径现在写入明确的正文省略标记，保留状态和相应测量，不将二进制解释为普通JSON证据。
3. 候选只检查ready数据库行，未检查实际文件。回放前后复用受权下载的内部解析服务，重新核对文件、摘要和引用；缺失或损坏阻断候选，保留上次可用发布版本。文件读取后还须按验证语义复核ACTIVE/enabled，不能用允许下载归档样例的规则替代。

## 覆盖如何组合

| 原合同出口 | 本轮真实PG/HTTP联合验证 | 专项补充与限定 |
| --- | --- | --- |
| 实际字节与上限 | 非UTF-8、PNG/PDF、阈值边界、分块超限、gzip解码测量、未知类型 | [采集专项](../../packages/api-nova-api/src/modules/asset-catalog/services/asset-catalog.service.spec.ts)验证JSON/text兼容和不信任JSON Buffer形状 |
| 身份与读取 | 真实管理员/只读用户、401/403、存在性隐藏、固定下载头、Range拒绝、逐字节内容 | [对象专项](../../packages/api-nova-api/src/modules/endpoint-testing/services/endpoint-test-sample-object.service.spec.ts)及[HTTP专项](../../packages/api-nova-api/src/modules/endpoint-testing/endpoint-testing-binary-http.spec.ts)补充路径、链接、损坏和删除竞争 |
| 候选验证 | 认证Gateway真实上游外发、显式status-only、unsupported零外发并保旧、物理样本失效阻断 | [验证专项](../../packages/api-nova-api/src/modules/runtime-verification/services/runtime-verification.service.spec.ts)覆盖Gateway/MCP逻辑；MCP二进制真实外发未在本轮执行 |
| 留存与恢复 | active不按年龄自动删除，archived按capturedAt到期撤销；即时410、宽限、重启、双API并发整理和重复收敛 | 时间老化只在自有测试数据库；不改变生产TTL或自动启用worker |
| 事务和进程故障 | 文件删除失败墓碑/恢复，真实PG围栏连接终止，真实写者进程在stage后退出及孤儿整理 | [事务专项](../../packages/api-nova-api/src/modules/endpoint-testing/services/endpoint-testing-binary-transaction.spec.ts)补充write/rename、事务回滚和DB终结失败；不声称覆盖每种单次文件操作中途断连竞态 |
| 引用独立与OBS分离 | 相同字节重复采集保留独立对象引用，OBS哨兵文件保持不变 | 哨兵仅证明此入口未误删独立目录，不代表全OBS策略集成验收 |

## 复跑方式

先构建API，再运行`npm run verify:prod-04c`。需要可用的PostgreSQL `initdb`/`pg_ctl`（PATH或`API_NOVA_TEST_PG_BIN`），以及本机创建隔离子进程和临时目录的权限。运行器结束后检查证据中的检查项与cleanup结果，不能仅凭进程退出码推断所有资源已收回。

本地证据使用合成上游数据，不包含生产凭据。用户以后指定目标环境后，仍须验证实际运行账户、私有对象目录权限、Linux/POSIX差异及部署恢复步骤。binary-exact仍为明确unsupported，不将status-only结果当成字节相等验证。

## 最终执行结果

- 基线：提交`a38c2af`加本轮二进制改动；Windows本机、真实隔离PG16、真实API/上游HTTP。
- 联合验收：16/16通过，`PROD_04C_VERIFY_OK`；本地机器证据`.tmp/prod-04c-d8slBr/evidence.json`。错误Content-Length导致测试失败且不生成可读样例/对象；选中对象物理缺失在外发前阻断，旧版本保持可用。
- 综合回归：15 suites/237 tests通过；API构建通过。
- 最终清理：所有自有API/worker已停止、自有PG已停止，cleanup.errors为空；合成夹具目录保留用于审计。

判定：PROD-04C按本机Windows/PG与既有SQL.js组合证据限定DONE。生产运行账户/ACL、Linux文件语义及MCP二进制真实外发仍未由本次证明，统一在SEC-F4-02/OPS-01后续矩阵中列明；不表示生产存储已签收。

后续已解决（归OPS-01）：同candidateRevision重复激活唯一键冲突已独立复现并修复，完整样例下两次重复部署仍执行真实验证，仅保留一份有效快照；后续PG/HTTP17/17通过，见[重复部署证据](./2026-10-08-gateway-repeat-deployment.md)。本报告原16项为上一轮执行记录，不回写成当时已验。
