# 2026-10-29 Node20基线下的依赖兼容整改

基线为main/97b560d，用户授权并行处理Vue I18n、Zod、Hono/MCP SDK并保持Node支持基线，暂不发布。原生产审计17包节点（5 high、12 moderate、0 critical）作为本轮比较口径；原工作包归属SEC-F4-02及OPS-01，不新增209条历史叶子或改变245条依赖。

## 兼容方案与实际改动

- **Zod 4.6.7**：Parser/Server及实际SDK消费链统一到4系列，去掉Server未使用的直接zod-to-json-schema依赖，SDK的v3兼容转换仍按上游保留。两处JSON Schema整数转换用multipleOf(1)及整数元数据保留原有有限整数域，避免新`.int()`隐式增加safe-integer上限；mutable raw shape适配新版只读类型。12项回归覆盖真实Parser→SDK→HTTP、默认值/effects、required、additionalProperties、整数域、禁用v3解析后的调用及array/set/map同步/异步大小拒绝。开发用Inspector仍可能携带dev-only Zod3，未声称所有开发依赖清零。
- **Hono node-server 2.1.5 / MCP SDK 1.32.2**：版本声明和根override同步，最终锁图只有Hono2；SDK的Zod子依赖显式引用根4.6.7，避免API继续复用旧Zod3。升级前真实HTTP能用`/static/%%36%31dmin/secret.txt`绕过静态前缀中间件，升级后404；正常编码文件可读、保护路径403。新增3项版本/Node合同及真实会话回归，覆盖initialize、tools/list、tools/call、非法参数、DELETE与失效会话。依据[官方公告](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)及[修复](https://github.com/honojs/node-server/commit/982179278529d5673812116b042829f27794966f)。这证明依赖修复，不声称产品此前必然暴露静态文件漏洞。
- **Vue I18n / Intlify限定安全回移**：官方11.4.16的package engines为Node>=22，不能在本轮直接迁入并抬高基线。因此保留9.14.5版本和原Node>=16引擎，将11.4.16完整sanitizer及escapeParams修复回移到三个本地归档。不是官方11系升级，不改engine或使用ignore-engines。20个实现文件全部校验；24项回归覆盖srcdoc、编码URL、事件属性、混合named/list参数、不可变/重复参数、所有实际中英文各1963条文案、locale/fallback和SSR。构建前核对归档、安装标记和全部20文件hash。来源、MIT许可、SRI、可复现构建和边界见[回移说明](../../../vendor/i18n-node20/README.md)及其provenance。
- **file-type 21.3.4 Node20兼容补充**：最低Node验证发现上游ZIP分支使用Node20不支持的Web deflate-raw，原安全专项因此18/19。保留原Node>=20与全部安全上限，仅在Node的unsupported-format错误时用zlib.inflateRaw及同一maxOutputLength做有界解压，溢出映射原可恢复ZIP错误；Node24/浏览器原生路径保留，不作全局monkey patch。扩展真实Nest验证器的合法压缩Office样例，原2 MiB虚报长度ZIP仍被1 MiB检测预算阻断。修复后Node20/24均19/19。见[兼容说明](../../../vendor/file-type-node20/README.md)。

file-type兼容候选安全复核曾发现zlib默认忽略首流后的垃圾/第二流，与原生路径存在接受条件差异。已用info.engine.bytesWritten强制完整消费；尾随作为非recoverable错误，避免被降级成普通ZIP而绕过通用ZIP MIME策略。回归同时验证docx和application/zip两类策略均拒绝垃圾及拼接流。归档在首次提交前重建，更新SRI/hash后两Node19项重测通过；未将有缺陷候选发布。

## 验证结果

结构化结果及日志摘要见[validation-summary.json](evidence/2026-10-29-node20-dependency-migrations/validation-summary.json)。临时数据库、测试凭据及原始运行日志不提交。

| 验证范围 | 结果 |
| --- | --- |
| 最终锁图干净安装 / npm ls | 安装成功，无dependency problems；API/Server/Parser实际Zod4.6.7、SDK1.32.2、单一Hono2.1.5 |
| Node24.22.1 API | 最终兼容锁下192 suites / 2065 tests通过 |
| Node24.22.1 Parser / Server | Parser51 suites / 1213 tests；Server官方完整测试链与新增12项schema测试通过 |
| Node24.22.1 UI | 119 tests通过（原95加I18n24）；四包生产构建通过 |
| Node20.0.0 新迁移合同 | UI全部119（含I18n24）、Hono/SDK3、schema12、产品Streamable/SSE适配37、安全专项19均通过 |
| Node20.0.0 实际应用 | UI类型检查及独立目录生产构建通过；API真实SQLite空库/重启持久化/启动通过，73表、8迁移、零漂移 |
| 静态及文档 | Lint零错误/287警告；工作流YAML与新增校验器语法检查通过；OpenAPI仅更新源码摘要，仍228路径/268操作 |

Node20.0的原生`node --test`子TAP解析曾被产品Unicode日志触发ERR_TAP_LEXER_ERROR；同一schema文件改为直接`node file.cjs`执行全部node:test断言，Node20和24均12/12，未屏蔽断言或降级覆盖。

根Node>=20.0.0、npm>=10及精确npm10.9.2要求均未改变。npm10.9.2自身在20线要求>=20.5是既有工具限制；最低运行时测试直接使用经官方SHA-256校验的Node20.0.0。双库CI增加Node20.5.0/24.15.0矩阵（共4格），兼顾精确工具链与Node20运行支持，不将官方Vue11引擎声明改写为兼容。

## 审计与剩余边界

完整旧配置和最终生产审计均使用omit=dev，原17节点降为**14节点：4 high、10 moderate、0 critical**。Zod、Hono及MCP SDK退出生产告警。剩余4 high为I18n家族版本/传播节点，10 moderate为Nest及传播节点；两家本地回移保留原版本号，原始审计不能识别字节修复。回归与hash证据对应已知公告，不将结果改称0漏洞或自动接受残余风险；今后公告须重新评估。

Vue官方11系迁移仍未完成：保持本轮Node20约束时先交付限定安全回移，待有兼容官方版本或另行批准Node支持调整再推进。SEC-F4-02、OBS-16-04仍IN_PROGRESS，OPS-01仍WAIT_DEP，目标账户/ACL/TLS、完整健康、生产容量和人工签收不因本机兼容测试关闭。

本轮未创建版本、tag或离线包，未触发发布；三平台rc.6及其历史记录不改。CI新增矩阵结果以对应提交的实际运行证据为准，本机结果不代替远端CI。
