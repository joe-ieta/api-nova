---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 现有范围收口、台账归一与本机限定验收

## 授权与基线

用户2026-10-26同意按现有能力收口：先统一台账/open-items，清理过期表述和链接，再推进现有条件下可完成的验收；保留生产签收和延期，不新增功能。

起点`oc_dev / 7be57aab3f709f6e559f8557b1b8a8376e2192e3`，本地与远端一致；候选为已发布v1.7.6-rc.5，发布源`a2639ce8d20d0709a3088e9de7e59bbd5dee8159`。本轮产品源码、配置、依赖及锁文件不变，不修改已发布包、标签或生产环境。唯一脚本修改是清理EXT-06验收器过期的SDK版本断言，不改变产品行为。

## 文档收口

- open-items改为单一当前剩余清单，保留3项签收、2项延期以及既有覆盖/维护/诊断，不重复叠加旧日期的“当前待办”。
- 直接更新统一台账、工作包映射中已由rc.5完成的文件/无server双端点、A/B迁移、日志、双库初始化和预发布交付结论；原209个ID、状态、合同及245条依赖保持。
- Phase1/2保持主线关闭，Phase3只做已有验收和签收；旧MCP端点DEV-01、二进制存储、状态流/配额/留存等工程缺口映射到后续限定DONE证据，不重新立项。
- 专题旧阶段记录折叠/标明日期，批准任务定义和退出条件保留；当前状态指向统一台账，不把旧父包计数当成新增开发任务。
- 发布检查清单采用已存rc.5双库73表/8迁移证据，替换失效的10-14数据库审计链接；38/40/43表数字保留为历史阶段。
- 更新文档索引及VERSIONS；16份带版本文档同步元数据，当前依赖、健康结果与历史发布日期分开记录。

## 本轮验收记录

Windows 10.0.19045、Node v24.15.0，产品代码与rc.5发布源一致。各脚本只使用工作区内新建隔离SQLite库、独立端口、随机测试凭据及回环上游；未接触历史业务库、发布镜像、外部收件人或生产实例。

| 验收 | 命令/范围 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build`；Parser/Server/API/UI | 全部通过；本轮未改产品代码，未额外重跑rc.5的全量单元测试 |
| 完整健康/监控入口 | `node scripts/verify-env-01.cjs --with-monitoring` | `FULL_HEALTH_PASSED`；API ready/live均200，MCP停用时完整health503，真实MCP运行后200；打包UI/Vite各4项、合计8项监控入口检查通过 |
| 浏览器Gateway闭环 | `node scripts/verify-ops-01-browser.cjs --lifecycle --logs`；打包UI/Edge 156.0.4314.42 | 37/37通过、无pageErrors；URL/no-server双端点→探测/测试/治理→凭证401/200→日志/监控→A/B迁移与身份保留→B消费→真实日志/分页/错误恢复/转义 |
| MCP消费者 | `node scripts/verify-ext-06.cjs`；真实SDK 1.32.1 | 初次被过期断言拦截；修复验收器后25/25通过，Streamable/SSE、受管child、身份/权限/会话/撤销、秘密扫描及清理均通过，distStale=false |
| 依赖公告复核 | `npm audit --omit=dev --json` | 17个包节点：6 high、11 moderate、0 critical；安全处置未完成，见下一节 |
| 文档合同 | 状态/合同/依赖/版本/相对文件链接 | 209状态与原合同一致、245依赖不变，无缺失依赖/环/DONE依赖未完成；16份版本同步，719处相对文件链接和9处Markdown锚点无失效项；详见[检查结果](./evidence/2026-10-26-existing-scope-closure/doc-validation.json) |

磁盘门槛仍为5,368,709,120字节（5GiB）；运行时C盘实测空闲20,762,865,664字节（约19.34GiB）。完整health实际返回200，不能只凭磁盘观察代签健康。ENV的PowerShell执行策略辅助读取因模块自动加载失败未取得结果；这不影响本轮API/MCP/浏览器进程运行，但目标账户执行策略仍未签收。

API/MCP/Vite、上游A/B及EXT-06监听端口全部按各验收器记录清理。构建和实际测试结果、源/脚本摘要、限制与原始证据SHA-256已保留在[验收摘要](./evidence/2026-10-26-existing-scope-closure/acceptance-summary.json)；不提交临时数据库、随机凭据、原始运行日志或浏览器截图。

EXT-06原脚本要求SDK 1.29.0，而当前根锁文件及已安装版本均为1.32.1；在服务启动前首项即失败。将硬编码断言改为比较安装版本与根`package-lock.json`，保留版本一致性门禁，随后全25项重跑通过。未更新依赖、跳过管理通道或放宽业务断言。首次失败摘要与复验结果均保留，不覆盖失败事实。

## 依赖时效与安全签收

10-20发布时的10 moderate、0 high/critical是历史结果，不能作为10-26的当前结论。[本次依赖摘要](./evidence/2026-10-26-existing-scope-closure/dependency-audit-summary.json)记录原始审计和锁文件摘要、17个节点的版本、公告及npm建议。计数表示受公告版本范围影响的包节点，包含传播节点；不等于17条已证实可利用路径，也不能以本机流程通过豁免。

| 高危节点 | 当前版本与核对边界 | 归属 |
| --- | --- | --- |
| @nestjs/core | 10.4.22；[SSE注入公告](https://github.com/advisories/GHSA-36xv-jgw5-4q75)仍命中版本范围；已有官方SSE字节回移和构建门禁，保留原补丁证据，版本审计不能识别该修复 | SEC-F4-02核对回移覆盖及风险处置，不声称新增可利用SSE缺口 |
| @nestjs/platform-express | 10.4.22；依赖链传播的high节点 | 与body-parser/multer链一起审查，不能独立重复计为新漏洞 |
| body-parser | 1.20.8/2.3.0；[压缩请求尾部DoS公告](https://github.com/advisories/GHSA-27r3-jxmh-p828) | 现有安全维护范围内核对真实入口及兼容补丁 |
| follow-redirects | 1.16.0；[数组header跨域凭据公告](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)、[sensitiveHeaders转义公告](https://github.com/advisories/GHSA-8r9p-f939-6h3c) | 核对现有转发调用方式与补丁，不凭一般HTTP通过认定无影响 |
| multer | 2.4.0；[异步fileFilter请求拆除DoS公告](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) | 核对已有文件上传入口与可用修复 |
| zod | 3.25.76；[超大受限集合验证内存耗尽公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | 核对实际schema/请求边界；npm建议主版本升级不自动等同可直接采用 |

11个中危节点和兼容修复提示（如fast-uri、hono、ip-address）详见JSON。它们与高危处置均归原SEC-F4-02，不新增任务ID、不改DONE历史。此轮冻结候选的验收不替换依赖、不接受残余风险；后续若改变锁文件须重验相关调用及构建，并使用新的交付版本，不能覆盖rc.5归档。目标安全签收仍不能关闭。

## 继续保留的出口

- SEC-F4-02和OBS-16-04仍IN_PROGRESS，OPS-01仍WAIT_DEP；目标平台/身份/ACL/TLS/出站/有效开关、实际SMTP/Webhook、告警、保留、恢复、回退和原合同的长期/多进程矩阵不由本机结果代签。
- 用户人工反馈、MCP浏览器/认证规范/多角色及其他原定未验组合仍单列。本轮浏览器覆盖不含文件/手工分支（复用rc.5既有证据）；自动化不称人工签收，HTTP/SDK不称浏览器验证。
- MCP本轮仅Windows回环；Linux/外部网络/生产启用及通过真实API配置驱动的受管生命周期全链路不由本次fixture证明。ENV的MCP health不证明工具业务正确性，SDK结果也不覆盖二进制真实MCP外发。
- Nest及新增公告的风险处置与lint warning继续维护；接受风险须责任人决定，本轮不强制跨大版本升级。
- SQLite3000未全量、参考硬件及时间开销保留非阻断诊断，不追加本机性能优化。
- OAuth2、额外令牌适配、跨协议QoS继续DEFERRED；独立UI/SDK/SSO、完整跨进程CAS等不作为本轮新增任务。

后续仅按既有出口推进：先处理SEC依赖风险处置与目标条件，再按同候选收齐SEC/OBS目标签收，最后汇总OPS人工及部署结论。生产签收和延期继续保留，本轮收口不等于项目全部完成。

状态入口：[统一台账](../guides/active-work-package-execution-status.md)、[open-items](../reference/open-items.md)、[原合同/依赖](../guides/active-work-package-breakdown.md)；旧交接和各日期审计保留可追溯事实，不覆盖当前限定验收。
