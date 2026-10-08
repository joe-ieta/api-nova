---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-08
---
# EXT-01～05：注册到Gateway消费者能力闭环（限定验收完成）

> 当前状态：EXT-01～05限定DONE（Windows本地真实HTTP）。最终构建、相关回归及完整执行器均通过；范围沿用[原验收用例](../testing/runtime-publication-acceptance-cases.md)，不增加细分任务。

## 交付与执行边界

本次将绝对URL导入、未解析导入绑定修复、手工注册、测试/治理/发布/部署、实例A下线迁移B、Gateway认证与多端点聚合调用作为同一产品流程验收。使用真实管理HTTP和Gateway入口、每次新建隔离SQLite及迁移、独立回环上游A/B和随机端口；不复用业务数据库或已有服务。

执行入口：根目录 `npm run verify:ext-01-05`，对应 `scripts/verify-ext-01-05.cjs`。每次在 `.tmp/ext-01-05-*/evidence.json` 留存脱敏逐步结果，并保留 `migration.log` 与 `api.log`。完成要求为退出码0、全部断言通过及 `EXT_01_05_VERIFY_OK`；启动成功不能替代全流程成功。

## 真实流程发现与修复

### 无服务器声明的导入误建运行实例

原实现使用文档的 `metadata.originalUrl` 推导来源时，会把用于下载OpenAPI文档的地址误建为API运行实例。修复在创建实例前检查可用HTTP(S)服务器声明；没有显式可用server时保留逻辑来源与端点，不自动创建实例。后续通过既有绑定流程恢复测试/治理/发布，端点身份保持不变。

### 认证路由无法使用脱敏样例完成候选验证

消费者API Key/JWT不应存入样例；原候选重放仍要求消费者凭证，受认证保护的Gateway候选因此无法验证。修复使用进程内单次候选执行授权，绑定真实request/target对象、请求method/URL及路由状态指纹；消费一次并在结束或失败时释放。HTTP字段及审计internal标记不能生成授权，跨target、状态变化和重复消费拒绝。真实消费者仍走原API Key/JWT鉴权，临时Anonymous到期保护保留。

### 实例迁移后自动探测仍访问旧地址

真实runner关闭A后发现，缓存的自动 `probeUrl` 仍指向A，导致已切换到B的端点治理失败。修复区分instance自动模式与custom显式覆盖：自动地址随所选实例重建，保留用户自定义探测地址并记录 `lastProbeInstanceId`。manual注册时的custom覆盖兼容亦已修复并通过最终专项，自动地址与自定义地址不会混淆。

## 最终验证记录

- 最终API构建通过，包含上述三项修复。
- 独立回归：Gateway/runtime-verification/runtime-assets/publication为90 suites / 1255 tests；资产/实例为4 suites / 57 tests，合计94 suites / 1312 tests，均exit 0。最初2 suites / 50 tests已包含在上述回归中，不重复累计。
- 最终执行器：11/11阶段通过，exit 0，成功标记EXT_01_05_VERIFY_OK；执行时工作树基于91e64065c001d569f7f70aa5fa2645fe0588ef2e并包含本轮修复。
- 脱敏原始证据：.tmp/ext-01-05-tkg2tT/evidence.json；SHA-256：37a1be70b58a7ff52e008cb6eda4f68c9cfeef005eb3fe6ba018aaf79407fd70。
- 执行器scripts/verify-ext-01-05.cjs SHA-256：7a556c19276a5b94ea99ac2b191669d74ef11a6aaba06b5c9770e65acda3d979。
- 运行后API 50545、MCP预留50546、上游A 50543/B 50544均独立重绑定成功，确认已释放。脱敏证据和隔离数据库保留在.tmp，无业务环境更动。

| 原任务 | 实际完成证据 |
| --- | --- |
| EXT-01 | 真实URL导入产生实例，探测/测试成功并留存样例 |
| EXT-02 | 无server导入没有伪实例，附加实例后同一端点可执行且未重新导入 |
| EXT-03 | 手工注册经过测试、治理、成员配置、发布/部署到真实消费者调用 |
| EXT-04 | A关闭后绑定B，端点身份不变，自动探测及验证指向B并激活；自定义探测地址由专项保护 |
| EXT-05 | 同一前缀多端点认证调用成功，缺失/错误/撤销Key拒绝且消费者凭据不上游 |

11阶段包括隔离迁移与启动、EXT01/02/03、Registry A、认证聚合发布、A验证部署、EXT05、EXT04迁移与消费者撤销；迁移阶段内部还复核B的治理、部署与调用。数量按最终evidence.steps.length计，不将内部断言重复累计为阶段。

下一能力包为PROD-04C二进制样例完整留存验收；现有209叶不增拆，状态为202 DONE、3 NEED_ENV、2 WAIT_DEP、2 DEFERRED，其他为0。

## 未覆盖范围

本轮不证明PostgreSQL、Linux、外部生产身份、浏览器交互或MCP传输验收。公网部署、生产开关和运维签收仍归SEC-F4-02、OBS-16-04与OPS-01。既有MCP及平台证据按原限定范围复用，不与本轮计数相加。