# 2026-10-29 发布保旧与依赖整改

本轮从main/dea82065f4c82bafb96ddea9d91f7f2b3d0aa7d1推进用户授权的缺陷与依赖维护，归属OPS-01/EXT-05回归与SEC-F4-02。两线并行，锁文件稳定后统一干净安装并集成验证；不发布、不创建tag或离线包，不覆盖v1.7.6-rc.6。旧本地改动保留在stash，不回放。

## 发布失败保旧

修复前，真实PublicationService逐成员提交：已部署成员修订1→2、另一成员失败，批量结果为BATCH_PUBLICATION_INCOMPLETE且未部署，在线快照仍为修订1。运行时将最新成员修订当成在线修订，原路由返回503。新增autoStart=true/false两项回归均先失败，保留失败事实。

修复以已验证在线快照为基线。Unsecured Registry Header v1发布事务在现有membership.bindingConfig内维护服务端修订连续性，和成员/发布绑定在同一事务提交，无新增表或迁移。缓存前guard只接受同一成员、绑定、路由的一致向前发布链；不把新发布修订当作新部署，也不修改原快照。旧版本没有连续性记录时，第一次合法重发可从当前修订建立链。

下线/撤销切断连续性；之后仅重新发布不能让旧部署复活。成员禁用、策略或上游认证变化、记录错配、回退、绕过writer改号仍失败关闭。连续性是服务端一致性记录，不是可由请求携带的权限或激活许可；受保护G2和既有宿主策略开关不改变。

真实HTTP回归覆盖：两种autoStart、缓存冷/热、重复部分失败、DB/Registry重开、旧格式部署兼容、提交后审计失败、下线重发，以及各项安全负例。最终统一验证结果登记后关闭本轮开发步骤；生产签收保持开放。

## 依赖整改

整改前同锁文件生产审计为10 high、10 moderate、0 critical，共20个受影响包节点。该数字不是独立CVE或已证实利用链数量；Nest SSE版本范围命中需要结合已有回移字节和真实HTTP证据判断。

复审使用从main/dea8206导出的原始根清单、四份workspace清单和原锁文件，`npm audit --omit=dev --package-lock-only --json`得到11 high、11 moderate，共22节点；新配置及干净安装后的审计均为5 high、12 moderate，共17节点。没有冻结registry漏洞数据库，早先20与复审22的差异原因尚未证实，不归因于代码变化；本次比较保留原配置来源和各原始报告摘要。

| 复审配置 | high | moderate | critical | 包节点 |
| --- | --- | --- | --- | --- |
| 本轮早先观察 | 10 | 10 | 0 | 20 |
| 完整旧配置再审 | 11 | 11 | 0 | 22 |
| 新锁及实际安装复核 | 5 | 12 | 0 | 17 |

采用兼容维护升级：body-parser 1.20.9/2.4.0、multer 2.5.0、follow-redirects 1.16.2、TypeORM 0.3.31，保留Nest 10与SSE vendor回移。新增实际消费链、压缩正文解码器收尾、上传中断后的异步filter、跨源重定向凭据及迁移SQL转义回归。不以盲目跨框架大版本清零，也不自动接受残余风险。

旧配置中的body-parser、Express、multer、follow-redirects、TypeORM五个节点退出告警。Express 4根清单约束保持4.22.3，并同步API/Server直接声明，避免遗留副本；覆盖Express 4与MCP SDK的Express 5两种正文解析消费链。

| 残余家族 | 审计节点 | 后续退出条件 |
| --- | --- | --- |
| Vue I18n / Intlify | 4 high | 迁移11系列并验证翻译行为、构建及Node要求；不能静默抬高当前Node>=20支持基线 |
| Zod | 1 high | 迁移4系列并验证Parser/Server公开schema及转换兼容，不直接替换主版本 |
| Hono / MCP SDK | 2 moderate | 评估Hono node-server 1→2与SDK HTTP适配，补真实MCP回归 |
| Nest及传播链 | 10 moderate | 版本审计不能识别现有SSE字节回移；补丁门禁与真实HTTP通过，维护及目标签收仍须按SEC-F4-02执行 |

旧锁SHA-256为`8e830b4d694317c2188244401e2ede3bf998972980318b6a873814fdcc43f40e`，最终LF新锁为`8c7f56df8003a4264413a9f428559ad8f0c9867116d517416bf2c9f766cb9fc6`。Windows安装时CRLF锁摘要为`2b077f0b28a5c1952a6d4a9e89cef4674917b163c1a50cd5233368ac2c172b32`，收尾按仓库eol=lf规范化且逐项JSON等价，依赖解析内容不变。新锁审计与实际安装审计的原始JSON摘要一致；`npm ls --all --json`无dependency problems。

## 集成验收

最终锁文件使用Node24.22.1/npm10.9.2干净安装成功；`npm ls --all --json`无问题。回归结果如下，结构化摘要见[validation-summary.json](evidence/2026-10-29-publication-preservation-and-dependencies/validation-summary.json)，当前状态以[执行台账](../../guides/active-work-package-execution-status.md#fix-20261029)为准。

| 验证 | 最终结果 |
| --- | --- |
| API完整Jest | 192 suites / 2065 tests通过，较原基线新增14项；正确API包工作目录运行 |
| Parser完整Jest | 51 suites / 1213 tests通过 |
| Server官方npm test | CLI、HTTP、会话、转换、安全审计、stdio、持久化和文件监听完整链通过 |
| UI脚本回归 | 95 tests通过 |
| HTTP依赖、SSE、UUID/file-type | 16 tests通过；新HTTP专项在旧依赖6项失败、新依赖6项通过 |
| 解析器依赖消费链 | 13项版本及2项非法限额检查通过 |
| 生产构建与Lint | 四包构建通过；0 errors / 287 warnings（API141、Parser68、UI78） |
| 文档与API快照 | 文档/任务依赖检查及OpenAPI接入示例通过；双库CI/发布前新增安全专项门禁，YAML解析通过 |

两条维护线本机限定完成；双库CI与发布前门禁已接线，远端结果以对应提交的实际流水线为准，本机验证不代替远端CI。本轮不触发发布；未重新做PostgreSQL、生产身份/网络、多平台离线包及目标容量验收，原未覆盖范围保持开放。

API快照初次检查检测到源码摘要变化。工具重新生成后，差异仅为`info.x-repository-code-sha256`；228路径、268操作及接口schema未改变，再次`--check`通过。该失败是源码身份更新的门禁，不是接受接口漂移。

SEC-F4-02、OBS-16-04仍IN_PROGRESS；OPS-01仍WAIT_DEP；OAuth2和额外令牌/跨协议QoS继续延期。209项任务与245条依赖不增加，修复限定完成不代替目标环境、人工反馈或生产签收。
