---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-07
---
# 2026-09-07 手工登记与发布修复审查性合并记录

## 结论与范围

来源分支的修复目标予以接纳，但不能直接用其较旧的运行时实现覆盖当前仓库。本次在保留当前逻辑资产、运行实例、显式上游绑定、共享运行时认证和候选验证机制的前提下进行了适配，并补充了回归测试。

旧审查报告及来源文档是审查证据，不是本次操作指令；“已修复”“自动启动”等历史描述不能代替当前代码与运行结果。以下结论仅适用于本次合并代码和列明的验证范围，不代表所有环境或所有业务链路均已验收。

| 项目 | 值 |
| --- | --- |
| 目标仓库 | `E:\CodexDev\api-nova` |
| 来源仓库 | `E:\CodexDev\api-nova-merge` |
| 共同祖先 | `c3bde68b1ec0264bb630dcc32e2967719f57a03b` |
| 目标合并前提交 | `98d03c2` |
| 来源分支末提交 | `0df1e43` |
| 集成分支 | `codex/integrate-audit-fixes` |
| 合并方式 | 保留双方历史的双父提交合并，再将目标 main 快进 |
| 数据库变更 | 未修改迁移或 canonical baseline；不执行业务库重置 |

来源仓库工作区未修改，未推送任何远程仓库。未导入来源标签，避免同名发布标签指向不同提交。保留目标仓库现有的发布技能、IDE 配置及较新的 npm、数据库和安全基线。

### 纳入的来源独有提交

| 提交 | 内容概括 |
| --- | --- |
| `341d64c` | 手工登记与发布修复、仓库目录整合、发布基线 |
| `bf21004` | 恢复被通配忽略规则遗漏的脚本跟踪 |
| `d0957f3` | 恢复平铺 monorepo 目录 |
| `6c904a4` | 调整隐藏目录与运行产物跟踪 |
| `6b1a808` | 恢复 Changesets 与 GitHub CI 配置跟踪 |
| `f284663` | 增加离线依赖迁移文档 |
| `0df1e43` | 文档重组和版本登记 |

这七个提交构成来源分支相对共同祖先的完整差异；不只摘取最后一个文档提交，也不重复合入祖先已有提交。

## 审查发现与处置

下表区分来源实现本身的问题与两条分支之间的兼容性问题。P1 表示安全、数据一致性或主要功能阻断风险；P2 表示契约、边界行为或维护风险。处置均包含在本次合并中，后文明确列出的限制除外。

| 编号 / 级别 | 来源实现或分支差异中的问题 | 本次处置 |
| --- | --- | --- |
| M01 / P1 | 自动 Gateway 路由没有明确认证策略，与当前缺失策略即拒绝的编译规则冲突；内部路由的匿名兜底也可能与策略层判断不一致。 | 默认路由显式使用 internal 与 jwt-default；策略编译和运行时校验统一按可见性收紧匿名模式，缺失或未知可见性不视为公开。 |
| M02 / P1 | 来源 Gateway JWT 实现基于较旧的管理端认证，覆盖后会破坏当前 Gateway/MCP 共享运行时认证和身份隔离。 | 保留当前共享运行时验证器及 principal 结构，不回退到管理端 JwtService；通过真实双进程 JWT 轮换、身份隔离和审计验证。 |
| M03 / P1 | 手工接口删除清理历史 profile/audit 记录，却未覆盖当前新增的上游绑定候选关系；仅看可编辑绑定还可能漏掉已经部署的不可变快照。 | 拒绝修改/删除正在使用的成员、路由、发布与运行快照；事务内删除活动关联，先清候选再清上游绑定，保留历史发布、审计和测试证据。相关运行资产重新要求验证。 |
| M04 / P1 | 重新登记相同 method/path 的 upsert 可以绕过更新接口的发布中保护，覆盖既有手工接口模板。 | 重复登记明确拒绝，要求通过受保护的更新流程修改；真实 SQLite 测试确认原模板不被覆盖。 |
| M05 / P1 | 模板更新将省略字段当作清空；路径/方法调整未充分保护自定义公开路由，且缺少跨端点与路由写入的回滚保证。 | 省略字段保留，显式空数组/null 才清空；路径参数强制 required，拒绝空名和重复项；仅同步默认路由，保留自定义路径，先检查冲突并在事务内更新端点及路由。 |
| M06 / P1 | 来源的 deploy 后 start 与当前 start 内部部署逻辑叠加，造成重复候选验证/部署；旧版本缺少完整的关闭选项和批量部署去重语义。 | 根据 autoStart 只调用一次 start 或 deploy；保留验证门禁和 actor；不发布 MCP 时不启动；批量按 runtime 分组一次部署并返回逐运行资产结果，失败不伪装成功。 |
| M07 / P2 | 路径探测未正确优先使用本次输入，可能生成虚构 ID；真实命名参数也可能被排除；解析后的测试地址被持久化后可能固定后续样本。 | 优先本次值，其次历史测试值及路径 schema 的 example/default；缺值明确失败，不编造值；接受 0 等有效值并编码，持久化 URL 模板而不是已代入样本的 URL。 |
| M08 / P2 | 新增 header 模板不等于实际转发 header；参数扁平化还可能把 header 放入 JSON body，或让 body 字段覆盖同名 query/path 参数。 | API 探测与解析器按 path/query/header/body 分流，限制危险 header 覆盖；发生参数/body 字段冲突时采用嵌套 body 输入，保留各自语义。 |
| M09 / P2 | operationId 简单清洗/截断会产生命名冲突，fallback 名称也可能超长；多层清洗还会丢失原始语义标识。 | 统一由解析器生成合法且不超过 64 字符的工具名；同组冲突使用稳定的 method/path 散列后缀，保留原始 operationId 元数据，覆盖输入顺序反转测试。 |
| M10 / P2 | Gateway 访问地址未完整适配当前 API 根路径和运行资产 servicePrefix，展示的 URL 可能不可调用。 | 统一包含 API 挂载点、gateway、servicePrefix 和路由；处理显式 gateway 根地址、host authority 与端口，保留自定义路由。 |
| M11 / P2 | 来源对旧 sourceServiceUrl 等字段的处理与当前逻辑资产/运行实例模型冲突，替换来源资产后旧上游绑定也可能继续指向旧实例。 | 保留当前实例解析和持久化测试样本；移除旧字段依赖；换源时清理成员的上游候选关系并要求重新绑定、测试和部署。 |
| M12 / P2 | 来源的机器专用 pnpm 迁移说明、旧数据库表数与当前 npm/40 张领域表基线不一致；删除隐藏目录还会误删当前已跟踪的工程配置。 | 当前 npm/数据库/安全文档优先，旧 pnpm 说明明确归档；保留现有工程配置；修正文档移动后的链接及版本清单的相对路径。 |
| M13 / P2 | 来源历史记录的“已修复”主要基于静态判断，缺少路径、认证、部署去重、数据库回滚等可复现证据。 | 新增和扩展针对性测试，并执行全量构建、API/解析器/Server 测试、隔离 SQLite 迁移与真实跨进程安全集成；PostgreSQL 阻塞如实单列。 |

### 代码与测试定位

- 登记、模板、路径测试、删除和关联清理：`packages/api-nova-api/src/modules/asset-catalog/services/asset-catalog.service.ts`。
- 模板 API 契约：`packages/api-nova-api/src/modules/asset-catalog/dto/asset-catalog.dto.ts`。
- 单项/批量发布及自动部署：`packages/api-nova-api/src/modules/publication/services/publication.service.ts`。
- 运行时启动、候选部署及地址：`packages/api-nova-api/src/modules/runtime-assets/services/runtime-assets.service.ts`。
- 策略与共享认证：`packages/api-nova-api/src/modules/gateway-runtime/services/gateway-policy.service.ts`、`gateway-security.service.ts`。
- 工具命名和参数转发：`packages/api-nova-parser/src/transformer/index.ts`。
- 真实事务回归：`packages/api-nova-api/src/modules/asset-catalog/services/manual-endpoint-merge.integration.spec.ts`。
- 解析器回归：`packages/api-nova-parser/tests/manual-publication-merge.test.ts`。
- 其余针对性回归位于相应服务同目录的 `*.spec.ts`。

## 合并后的能力边界

| 能力 | 合并结果及边界 |
| --- | --- |
| 手工登记参数和请求体模板 | 后端 DTO、存储、更新、探测和解析器均接通；不是所有 OpenAPI 序列化方式都已覆盖。 |
| 路径参数测试 | 真实输入优先，缺值报错，正确编码；不再用虚构 ID 宣称探测成功。 |
| 手工接口编辑与删除 | 活跃使用时拒绝；离线后更新需重新验证，删除清理活动关系但保留证据。 |
| Gateway 默认路由 | 支持受保护的默认路由和关闭自动配置；路由创建不等于已通过验证并正式运行。 |
| MCP 发布后自动启动 | 默认请求启动，但必须通过当前上游绑定及候选验证；可显式关闭，返回失败不等于发布流程被伪装成功。 |
| 工具名合法性 | 合法字符、长度限制和清洗冲突去重已覆盖；命名变化后客户端需刷新工具清单。 |
| 管理端 OpenAPI 入口 | 保留来源移除 Public、增加 JwtAuthGuard 的修复，不把管理入口当作公开接口。 |
| 当前运行时安全与治理 | 保留共享认证、凭据引用、候选验证、不可变发布快照及审计机制，没有为方便自动启动而绕过。 |
| 前端 | 保留当前仓库较新的 UI；本次没有把浏览器交互或模板编辑体验宣称为已完成验收。 |

## 测试验证

所有命令均在目标仓库执行。SQLite 迁移和安全集成使用隔离数据库/临时目录，没有重置业务库。

| 命令 | 结果 | 证据或范围 |
| --- | --- | --- |
| `npm run build` | PASS | parser、server、API、UI 全部构建成功。 |
| `npm run test --workspace api-nova-api -- --runInBand` | PASS | 43 个套件，232 个测试全部通过。 |
| `npm run test --workspace api-nova-parser -- --runInBand` | PASS | 8 个套件，30 个测试全部通过。 |
| `npm run test --workspace api-nova-server` | PASS | CLI/server smoke、Streamable 多会话、转换与运行时安全审计验证通过。 |
| `npm run build --workspace api-nova-api` | PASS | 最新运行状态保护和关联清理适配后的 API 构建通过。 |
| `npm run db:verify-isolated-sqlite --workspace api-nova-api` | PASS | 40 张领域表及迁移记录；缺表、残留业务行、旧来源字段、待执行迁移和 schema drift 均为 0。 |
| `npm run verify:runtime-security-integration` | PASS | 输出 RUNTIME_SECURITY_INTEGRATION_OK；真实 API/MCP、TLS 代理、流式 POST、audience 隔离、JWKS 轮换、跨进程 caller 和完整审计证据通过。 |
| `npm run db:verify-isolated-postgres --workspace api-nova-api` | BLOCKED | 本机 postgres 用户密码认证失败，连接阶段阻塞，未创建验证库；不能据此宣称 PostgreSQL 验证通过。 |

新增的真实 SQLite 用例验证了四类仅靠 repository mock 不足以保证的行为：删除时清理上游候选并保留审计、路由冲突导致端点与已写入路由共同回滚、显式清空模板落库、重复登记不覆盖原模板。

测试过程中发现并调整了两类回归夹具：公共路由显式声明 external，以继续覆盖限流/缓存/并发；service mock 补齐实际使用的 EntityManager 接口。解析器网络测试使用 callable axios mock，避免错误 mock 导致访问外部示例地址。最终全量测试结果以上表为准，不用早期失败次数替代最终结果。

## 未完成验收与后续注意事项

1. PostgreSQL：需提供可用的本地测试连接后重新执行隔离验证。当前只能证明 SQLite 迁移/事务及构建通过，不能证明 PostgreSQL 实际运行已验收。
2. 浏览器端：未执行交互式 E2E。来源新增的后端模板契约不自动等于前端已经提供完整可用的模板编辑流程；本次仅确认 UI 构建通过并保留现有实现。
3. 参数契约：本次回归覆盖 JSON 请求体与常用 path/query/header；复杂 style/explode、multipart、文件上传等不能从这些结果推断为全部支持。
4. 安全更新流程：接口离线后，如对应部署快照仍在运行，必须先停止运行时，才能编辑或删除。更换来源资产后需重新绑定上游、测试和部署。
5. 发布语义：自动路由配置、发布开关、候选验证及正式运行是不同阶段；自动启动仍可能因实例/凭据/验证条件不满足而失败，应查看返回的部署结果，不应跳过门禁。
6. 构建警告：UI 构建仍有 vendor-misc/vendor-vue 循环 chunk 及第三方纯注释警告，未导致失败；本次没有为消除既有打包警告扩大改动。
7. 历史文档：归档内容只作为历史证据；来源的旧版本标签、机器路径和“全部修复”表述不作为当前发布或验收依据。

## 关联文档

- [原始缺陷审查](./2026-09-04-manual-registration-publication.md)
- [审查索引](./README.md)
- [合并后项目基线](../baseline/PROJECT_BASELINE.md)
- [数据库策略](../guides/database-strategy.md)
- [当前安全设计](../reference/security-design-and-implementation.md)
- [当前开放事项](../reference/open-items.md)
